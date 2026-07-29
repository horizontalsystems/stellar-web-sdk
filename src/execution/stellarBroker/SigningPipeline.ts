import {
  Address,
  Asset,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  scValToNative,
  xdr
} from '@stellar/stellar-sdk'
import { StellarSwapError } from '../../core/errors.js'
import { StellarAsset, isNativeAsset, sacContractId } from '../../core/assets.js'
import { toStroops } from '../../core/amounts.js'
import { HorizonClient } from '../../stellar/horizon.js'
import { StellarSigner, authEntrySigner, signTransaction, txCarriesSignatureFrom } from '../../core/signer.js'
import { TxMessage } from './messages.js'

/** Per-tx debit headroom over the quoted selling amount (guide §5: ≤ sellingAmount × 1.02). */
const DEBIT_HEADROOM_BPS = 200n // 2%
/** At most this many DISTINCT debiting txs in one session (guide §5). NOT a cumulative budget. */
const MAX_DEBITING_TXS = 5

/** SEP-41 methods that must never debit/authorize the trader inside a broker-built tx. */
const FORBIDDEN_SEP41 = new Set(['approve', 'transfer_from', 'burn', 'burn_from'])

export interface SigningPipelineOptions {
  signer: StellarSigner
  /** The asset being sold — the ONLY asset a broker tx may debit from the trader. */
  sellingAsset: StellarAsset
  /** Quoted selling amount (decimal string). */
  sellingAmount: string
  networkPassphrase: string
  horizon: HorizonClient
}

export interface SignResult {
  /** Echo of the broker's correlation hash. */
  hash: string
  /** Signed envelope (base64) to return to the broker. */
  xdr: string
}

/**
 * The StellarBroker signing pipeline (guide §5). The broker builds every transaction; these
 * checks are the client's ONLY defense. Order matters:
 *
 *   1. Shape validation — every op is an InvokeHostFunction or a path payment that pays the
 *      trader (swap leg) or a trader/unset-sourced strict-send fee leg. Anything else → reject.
 *   2. Trader-signature detection — a tx already carrying the trader's signature is the Soroban
 *      fee-bump round-trip (second pass). Detected by CRYPTOGRAPHIC verification, never by hint
 *      or signature-presence (channel accounts pre-sign classic txs).
 *   3. Per-tx debit budget — worst-case trader spend in the SELLING asset ≤ sellingAmount × 1.02,
 *      and ≤ 5 distinct debiting txs/session. Per-tx + tx-count only, NEVER cumulative (SB retries
 *      rebuild on different channel accounts, so a cumulative ceiling kills legit retries).
 *   4. Sign — classic: fee-bump with feeSource = trader; Soroban first pass: sign auth entries +
 *      inner tx, no fee-bump (server round-trips it); Soroban second pass: only wrap + sign the
 *      fee-bump (skip the debit budget — same tx, counting twice falsely trips).
 */
export class SigningPipeline {
  private readonly trader: string
  private readonly sellingSac: string
  private readonly sellingStroops: bigint
  private debitingTxCount = 0

  /** Outer fee-bump hashes we signed, in order. The LAST is the tracking handle. */
  readonly signedHashes: string[] = []

  constructor(private readonly opts: SigningPipelineOptions) {
    this.trader = opts.signer.publicKey
    this.sellingStroops = toStroops(opts.sellingAmount)
    // Deterministic, no RPC — the SAC contract id the SELLING asset's Soroban transfers must use
    // (native XLM has a SAC too, so this is derived uniformly).
    this.sellingSac = sacContractId(opts.sellingAsset, opts.networkPassphrase)
  }

  /** The last outer fee-bump hash — report this to `/v2/track`. Undefined if nothing signed yet. */
  get lastSignedHash(): string | undefined {
    return this.signedHashes[this.signedHashes.length - 1]
  }

  /** Run the full pipeline for one broker `tx` message and return the signed envelope. */
  async sign(message: TxMessage): Promise<SignResult> {
    const parsed = TransactionBuilder.fromXDR(message.xdr, this.opts.networkPassphrase)
    if (!(parsed instanceof Transaction)) {
      throw new StellarSwapError('signing_rejected', 'Broker sent a fee-bump envelope; expected an inner transaction')
    }
    const tx = parsed

    const isSoroban = tx.operations.some((op) => op.type === 'invokeHostFunction')

    // 1. Shape — always.
    this.validateShape(tx, isSoroban)

    // 2. Trader-signature detection — cryptographic, not hint/presence.
    const hasTraderSignature = txCarriesSignatureFrom(tx, this.trader)

    if (hasTraderSignature) {
      // Soroban second pass: SAME tx already counted — skip the debit budget, only fee-bump.
      return this.feeBumpAndSign(tx, message)
    }

    // 3. Per-tx debit budget (first pass / classic).
    if (isSoroban) {
      this.enforceSorobanDebit(tx)
      // 4. Soroban first pass — sign auth entries + inner tx, return WITHOUT a fee bump.
      return this.signSorobanFirstPass(message)
    }

    this.enforceClassicDebit(tx)
    // 4. Classic — sign inner, wrap + sign fee-bump.
    return this.feeBumpAndSign(tx, message)
  }

  // --- 1. shape ------------------------------------------------------------

  private validateShape(tx: Transaction, _isSoroban: boolean): void {
    for (const op of tx.operations) {
      if (op.type === 'invokeHostFunction') continue

      if (op.type === 'pathPaymentStrictSend' || op.type === 'pathPaymentStrictReceive') {
        const paysTrader = op.destination === this.trader
        const source = this.effectiveSource(op, tx)
        const isFeeLeg = op.type === 'pathPaymentStrictSend' && (op.source === undefined || source === this.trader)
        if (paysTrader || isFeeLeg) continue
        throw this.reject(
          `path payment neither pays the trader nor is a trader-sourced fee leg (op destination ${op.destination})`
        )
      }

      throw this.reject(`unexpected operation type "${op.type}" in a broker-built transaction`)
    }
  }

  // --- 3a. classic debit ---------------------------------------------------

  private enforceClassicDebit(tx: Transaction): void {
    let debit = 0n
    for (const op of tx.operations) {
      if (op.type !== 'pathPaymentStrictSend' && op.type !== 'pathPaymentStrictReceive') continue
      if (this.effectiveSource(op, tx) !== this.trader) continue // not debiting the trader

      // Every trader-sourced path payment MUST spend the selling asset.
      if (!this.assetMatchesSelling(op.sendAsset)) {
        throw this.reject('a trader-sourced path payment does not spend the selling asset')
      }
      // strict-send debits exactly sendAmount; strict-receive debits at most sendMax.
      const spend = op.type === 'pathPaymentStrictSend' ? op.sendAmount : op.sendMax
      debit += toStroops(spend)
    }
    this.enforceBudget(debit)
  }

  // --- 3b. Soroban debit ---------------------------------------------------

  private enforceSorobanDebit(tx: Transaction): void {
    let debit = 0n
    for (const op of tx.operations) {
      if (op.type !== 'invokeHostFunction') continue
      const auth = op.auth ?? []
      for (const entry of auth) {
        debit += this.walkInvocation(entry.rootInvocation())
      }
    }
    this.enforceBudget(debit)
  }

  /** Recursively sum trader debits in an auth invocation tree, rejecting forbidden SEP-41 calls. */
  private walkInvocation(invocation: xdr.SorobanAuthorizedInvocation): bigint {
    let debit = 0n
    const fn = invocation.function()
    if (
      fn.switch().value ===
      xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn().value
    ) {
      const call = fn.contractFn()
      const contractId = addressToString(call.contractAddress())
      const method = call.functionName().toString()
      const args = call.args()

      if (FORBIDDEN_SEP41.has(method) && this.argsTouchTrader(args)) {
        throw this.reject(`Soroban auth invokes SEP-41 "${method}" touching the trader`)
      }

      const fromArg = args[0]
      const amountArg = args[2]
      if (method === 'transfer' && fromArg && amountArg) {
        const from = this.scvalAddress(fromArg)
        if (from === this.trader) {
          if (contractId !== this.sellingSac) {
            throw this.reject(`Soroban transfer(from=trader) is on ${contractId}, not the selling asset's SAC`)
          }
          const amount = this.scvalI128(amountArg)
          if (amount < 0n) throw this.reject('Soroban transfer has a negative amount')
          debit += amount
        }
      }
    }

    for (const sub of invocation.subInvocations()) {
      debit += this.walkInvocation(sub)
    }
    return debit
  }

  private argsTouchTrader(args: readonly xdr.ScVal[]): boolean {
    return args.some((a) => {
      try {
        return this.scvalAddress(a) === this.trader
      } catch {
        return false
      }
    })
  }

  private enforceBudget(debit: bigint): void {
    if (debit <= 0n) return // a tx that doesn't debit the trader doesn't consume the budget
    const ceiling = (this.sellingStroops * (10_000n + DEBIT_HEADROOM_BPS)) / 10_000n
    if (debit > ceiling) {
      throw this.reject(
        `per-tx trader debit ${debit} stroops exceeds sellingAmount × 1.02 (${ceiling} stroops)`
      )
    }
    this.debitingTxCount += 1
    if (this.debitingTxCount > MAX_DEBITING_TXS) {
      throw this.reject(`session exceeded ${MAX_DEBITING_TXS} distinct debiting transactions`)
    }
  }

  // --- 4. signing ----------------------------------------------------------

  /** Classic / Soroban-second-pass: sign inner (if unsigned by trader) + fee-bump wrapper. */
  private async feeBumpAndSign(tx: Transaction, message: TxMessage): Promise<SignResult> {
    // First pass classic: the trader hasn't signed yet → sign the inner tx (authorizes the swap
    // leg). Second pass Soroban: trader sig already present → don't double-sign the inner.
    if (!txCarriesSignatureFrom(tx, this.trader)) {
      await signTransaction(tx, this.opts.signer)
    }

    const baseFee = this.feeBumpBaseFee(tx, message.networkFee)
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      this.trader,
      baseFee,
      tx,
      this.opts.networkPassphrase
    )
    await signTransaction(feeBump, this.opts.signer)

    const outerHash = feeBump.hash().toString('hex')
    this.signedHashes.push(outerHash)
    return { hash: message.hash, xdr: feeBump.toEnvelope().toXDR('base64') }
  }

  /**
   * Soroban first pass: sign each address-credentials auth entry with
   * `signatureExpirationLedger = maxLedger + 1`, then sign the inner tx. Returns WITHOUT a fee
   * bump — the broker round-trips it and sends it back for the second (fee-bump) pass.
   */
  private async signSorobanFirstPass(message: TxMessage): Promise<SignResult> {
    const env = xdr.TransactionEnvelope.fromXDR(message.xdr, 'base64')
    const inner = env.v1().tx()
    // Guide §5: signatureExpirationLedger = tx maxLedger + 1.
    const maxLedger = maxLedgerFromCond(inner.cond())
    const validUntil = maxLedger !== undefined ? maxLedger + 1 : await this.horizonLedgerFallback()

    const signerFn = authEntrySigner(this.opts.signer)
    for (const op of inner.operations()) {
      const body = op.body()
      if (body.switch().name !== 'invokeHostFunction') continue
      const ihf = body.invokeHostFunctionOp()
      const signed: xdr.SorobanAuthorizationEntry[] = []
      for (const entry of ihf.auth()) {
        signed.push(await authorizeEntry(entry, signerFn, validUntil, this.opts.networkPassphrase))
      }
      ihf.auth(signed)
    }

    // Rebuild a Transaction from the mutated envelope and add the trader's tx signature.
    const tx = new Transaction(env.toXDR('base64'), this.opts.networkPassphrase)
    await signTransaction(tx, this.opts.signer)
    // No fee-bump on this pass, so no tracking hash is recorded yet.
    return { hash: message.hash, xdr: tx.toEnvelope().toXDR('base64') }
  }

  private feeBumpBaseFee(inner: Transaction, networkFee: string | number): string {
    const total = BigInt(String(networkFee))
    const units = BigInt(inner.operations.length + 1)
    // Fee-bump total = baseFee × (innerOps + 1). Choose baseFee so the total stays at/under the
    // broker's bid (never over-bid) while satisfying the SDK's minimums.
    let baseFee = units > 0n ? total / units : total
    const innerRate = ceilDiv(BigInt(inner.fee), BigInt(Math.max(inner.operations.length, 1)))
    const min = innerRate > 100n ? innerRate : 100n
    if (baseFee < min) baseFee = min
    return baseFee.toString()
  }

  private async horizonLedgerFallback(): Promise<number> {
    // A Soroban tx should carry ledger bounds; if not, expire ~one hour of ledgers out (~720).
    const latest = await this.opts.horizon.latestLedger()
    return latest + 720
  }

  // --- helpers -------------------------------------------------------------

  private effectiveSource(op: { source?: string }, tx: Transaction): string {
    return op.source ?? tx.source
  }

  private assetMatchesSelling(asset: Asset): boolean {
    if (isNativeAsset(this.opts.sellingAsset)) return asset.isNative()
    return (
      !asset.isNative() &&
      asset.getCode() === this.opts.sellingAsset.code &&
      asset.getIssuer() === this.opts.sellingAsset.issuer
    )
  }

  private scvalAddress(v: xdr.ScVal): string {
    const native = scValToNative(v)
    if (typeof native === 'string') return native
    throw new StellarSwapError('signing_rejected', 'Expected an address ScVal in Soroban auth')
  }

  private scvalI128(v: xdr.ScVal): bigint {
    const native = scValToNative(v)
    if (typeof native === 'bigint') return native
    if (typeof native === 'number' && Number.isSafeInteger(native)) return BigInt(native)
    throw new StellarSwapError('signing_rejected', 'Expected an i128 amount ScVal in Soroban auth')
  }

  private reject(reason: string): StellarSwapError {
    return new StellarSwapError('signing_rejected', `Refusing to sign broker transaction: ${reason}`)
  }
}

function addressToString(addr: xdr.ScAddress): string {
  // Contract (C…) or account (G…) — both stringify via Address.
  return Address.fromScAddress(addr).toString()
}

/** Read `maxLedger` from a Preconditions object (V2 ledger bounds), if present. */
function maxLedgerFromCond(cond: xdr.Preconditions): number | undefined {
  if (cond.switch().name !== 'precondV2') return undefined
  const bounds = cond.v2().ledgerBounds()
  if (!bounds) return undefined
  const max = bounds.maxLedger()
  return max && max > 0 ? max : undefined
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return b === 0n ? a : (a + b - 1n) / b
}
