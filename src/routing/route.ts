/**
 * Route construction — assembling the normalized {@link Route} an adapter returns, plus the
 * `execution` blocks that describe how each route is carried out.
 *
 * Ported from `uswap-server/src/api/v2/quoting/native.ts`. The output is byte-compatible with
 * what `/v2/rate` and `/v2/swap` return, so the waterfall, the executors, and the React hooks
 * consume a locally-built route and a server-built one through the same code path.
 */

import {
  EstimatedTime,
  Execution,
  Fee,
  Route,
  SignedTransactionExecution,
  StellarBrokerExecution,
  TransferExecution
} from '../core/types.js'

/**
 * Swap the estimated INBOUND (network fee) line for the real one, once a Soroban simulation has
 * revealed the resource-inclusive fee bid. Used by the two adapters that simulate before returning
 * (AQUARIUS, AXELAR_ITS on its Stellar leg); a no-op if no inbound line was added.
 */
export function replaceInboundFee(fees: Fee[], amount: string): void {
  const index = fees.findIndex((f) => f.type === 'inbound')
  const existing = index >= 0 ? fees[index] : undefined
  if (existing) fees[index] = { ...existing, amount }
}

export interface MakeRouteArgs {
  provider: string
  sellAsset: string
  sellAmount: string
  buyAsset: string
  /** Already net of every fee the route charges. */
  expectedBuyAmount: string
  /**
   * Set ONLY when the floor is genuinely ENFORCED (an on-chain minimum, a protocol limit, a
   * locked rate). A floating estimate leaves it unset and the route carries an explicit `null`,
   * so a caller can tell "no guaranteed minimum" apart from "field absent". STELLARBROKER is the
   * one Stellar provider that legitimately has none — the broker re-quotes live in-session.
   */
  minBuyAmount?: string
  fees: Fee[]
  estimatedTime: EstimatedTime
  expiresAt?: number
  meta?: Record<string, unknown>
  execution?: Execution
}

/**
 * Assemble a route. `providers` is a list because the wire contract reserves it for future
 * multi-step routes; every route built today names exactly one.
 */
export function makeRoute(args: MakeRouteArgs): Route {
  return {
    providers: [args.provider],
    sellAsset: args.sellAsset,
    sellAmount: args.sellAmount,
    buyAsset: args.buyAsset,
    expectedBuyAmount: args.expectedBuyAmount,
    minBuyAmount: args.minBuyAmount ?? null,
    fees: args.fees,
    estimatedTime: args.estimatedTime,
    ...(args.expiresAt != null ? { expiresAt: args.expiresAt } : {}),
    ...(args.meta != null ? { meta: args.meta } : {}),
    ...(args.execution ? { execution: args.execution } : {})
  }
}

/**
 * `signed_transaction` — SOROSWAP / AQUARIUS / STELLAR_DEX / AXELAR_ITS (Stellar side). The
 * adapter has built a complete unsigned envelope; the client signs it and submits it to Horizon.
 */
export function makeSignedTxExecution(args: { chain: string; xdr: string }): SignedTransactionExecution {
  return {
    method: 'signed_transaction',
    chain: args.chain,
    transactions: [{ kind: 'stellar', xdr: args.xdr }]
  }
}

/**
 * `stellar_broker` — no transaction exists to hand over. The broker builds and submits every tx
 * itself; what the client receives is the parameters for the interactive WebSocket session it
 * runs (and signs inside). Note the unit shift the wire contract fixes here: `slippageTolerance`
 * is a FRACTION (0.01 = 1%), not the request's percent, and the assets are SB's own wire form
 * with no `XLM.` prefix. Both are passed through verbatim by `StellarBrokerSession`.
 */
export function makeStellarBrokerExecution(args: {
  chain: string
  sellingAsset: string
  buyingAsset: string
  sellingAmount: string
  slippageTolerance: number
  partnerKey?: string
}): StellarBrokerExecution {
  return {
    method: 'stellar_broker',
    chain: args.chain,
    sellingAsset: args.sellingAsset,
    buyingAsset: args.buyingAsset,
    sellingAmount: args.sellingAmount,
    slippageTolerance: args.slippageTolerance,
    ...(args.partnerKey ? { partnerKey: args.partnerKey } : {})
  }
}

/**
 * `transfer` — deposit-to-address (NEAR / 1Click). Nothing is signed against a contract: the
 * trader sends `amount` of `asset` to `depositAddress` and the provider fills the far side.
 *
 * `unsignedTxUnavailable` is set whenever the caller supplied a source address (signalling intent
 * to send from it) but the SDK cannot build that chain's deposit transaction. That is the normal
 * case here and not a defect: building deposits for twenty-odd non-Stellar chains is wallet work,
 * outside this SDK's scope, and the hint tells the client to build the transfer itself.
 */
export function makeTransferExecution(args: {
  chain: string
  depositAddress: string
  amount: string
  asset: string
  attachment?: { type: string; value: string }
  sourceAddress?: string
  canBuildTx?: boolean
}): TransferExecution {
  const unbuildable = !!args.sourceAddress && !args.canBuildTx
  return {
    method: 'transfer',
    chain: args.chain,
    depositAddress: args.depositAddress,
    amount: args.amount,
    asset: args.asset,
    ...(args.attachment ? { attachment: args.attachment } : {}),
    ...(unbuildable ? { unsignedTxUnavailable: 'chain_not_supported' } : {})
  }
}
