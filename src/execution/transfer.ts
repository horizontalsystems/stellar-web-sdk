import { Account, Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { ResolvedConfig } from '../core/config.js'
import { StellarSwapError } from '../core/errors.js'
import { parseStellarAssetIdentifier, toStellarSdkAsset } from '../core/assets.js'
import { HorizonClient, HorizonSubmitResult } from '../stellar/horizon.js'
import { StellarSigner, signTransaction } from '../core/signer.js'
import { CommittedRoute, TransferExecution } from '../core/types.js'

/** Base fee (stroops) for the single-op deposit payment. Generous to survive mild surge. */
const DEPOSIT_BASE_FEE = '10000'

/** What the caller must send to complete a `transfer` route when the SDK doesn't submit for them. */
export interface DepositInstruction {
  /** Origin chain code (e.g. `XLM`, `ETH`, `BTC`). */
  chain: string
  depositAddress: string
  /** Exact amount to send, whole units (decimal string). */
  amount: string
  /** Origin asset identifier (`CHAIN.TICKER-ADDRESS`). */
  asset: string
  /** Memo / destination tag to attach, if the chain needs one. */
  attachment?: { type: string; value: string }
}

export interface TransferResult {
  method: 'transfer'
  /** True when the SDK built + submitted the deposit (Stellar origin + signer); false otherwise. */
  submitted: boolean
  /** The deposit the swap needs — always present, so a non-submitting caller knows what to send. */
  deposit: DepositInstruction
  /** Deposit tx hash to report to `/v2/track` — present only when `submitted`. */
  inboundTxHash?: string
  /** Horizon submit result — present only when `submitted`. */
  submit?: HorizonSubmitResult
}

/**
 * Executes a cross-chain `transfer` route (NEAR / 1Click model): the trader deposits the origin
 * asset to a provider-supplied `depositAddress` and the provider fills the destination side.
 *
 * When the origin is Stellar and a signer is given, the SDK builds the deposit payment (+ memo),
 * signs it, and submits it to Horizon — returning the hash to track. For any other origin (or with
 * no signer), it returns the `DepositInstruction` for the caller/wallet to send natively.
 */
export class TransferExecutor {
  private readonly horizon: HorizonClient

  constructor(private readonly config: ResolvedConfig) {
    this.horizon = new HorizonClient(config)
  }

  /** The deposit the route requires, without submitting anything. */
  deposit(route: CommittedRoute): DepositInstruction {
    return instruction(expectTransfer(route.execution))
  }

  async execute(route: CommittedRoute, signer?: StellarSigner): Promise<TransferResult> {
    const execution = expectTransfer(route.execution)
    const deposit = instruction(execution)

    // Only a Stellar-origin deposit with a signer can be built + submitted client-side here.
    if (!isStellarOrigin(execution) || !signer) {
      return { method: 'transfer', submitted: false, deposit }
    }

    const submit = await this.submitStellarDeposit(execution, signer)
    return { method: 'transfer', submitted: true, deposit, inboundTxHash: submit.hash, submit }
  }

  private async submitStellarDeposit(execution: TransferExecution, signer: StellarSigner): Promise<HorizonSubmitResult> {
    const asset = parseStellarAssetIdentifier(execution.asset)
    const account = await this.horizon.getAccount(signer.publicKey)
    if (!account) {
      throw new StellarSwapError(
        'invalid_params',
        `Source ${signer.publicKey} does not exist on-chain — fund it before depositing`
      )
    }

    const builder = new TransactionBuilder(new Account(account.id, account.sequence), {
      fee: DEPOSIT_BASE_FEE,
      networkPassphrase: this.config.networkPassphrase
    })
      .addOperation(
        Operation.payment({
          destination: execution.depositAddress,
          asset: toStellarSdkAsset(asset),
          amount: execution.amount
        })
      )
      .setTimeout(180)

    const memo = memoFromAttachment(execution.attachment)
    if (memo) builder.addMemo(memo)

    const tx = builder.build()
    await signTransaction(tx, signer)
    return this.horizon.submit(tx)
  }
}

function instruction(e: TransferExecution): DepositInstruction {
  return { chain: e.chain, depositAddress: e.depositAddress, amount: e.amount, asset: e.asset, attachment: e.attachment }
}

/** The origin is Stellar when the deposit is made on the `XLM` chain / with an `XLM.*` asset. */
function isStellarOrigin(e: TransferExecution): boolean {
  return e.chain === 'XLM' || e.asset.startsWith('XLM.')
}

function memoFromAttachment(a?: { type: string; value: string }): Memo | undefined {
  if (!a) return undefined
  switch (a.type) {
    case 'id':
      return Memo.id(a.value)
    case 'hash':
      return Memo.hash(a.value)
    case 'text':
    default:
      return Memo.text(a.value)
  }
}

function expectTransfer(execution: CommittedRoute['execution']): TransferExecution {
  if (execution.method !== 'transfer') {
    throw new StellarSwapError('invalid_params', `Route execution.method is ${execution.method}, not transfer`)
  }
  return execution
}
