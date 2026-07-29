/**
 * Wire types for the uswap-server `/v2` contract, narrowed to the Stellar surface the
 * SDK actually touches. Mirrors `uswap-server/API.md` §3–§6. Fields the SDK never reads
 * are typed loosely (`unknown`/`Record`) so a server-side additive change can't break us.
 */

/** The four Stellar-native providers this SDK routes across. */
export const STELLAR_PROVIDERS = [
  'STELLARBROKER',
  'SOROSWAP',
  'AQUARIUS',
  'STELLAR_DEX'
] as const

export type StellarProvider = (typeof STELLAR_PROVIDERS)[number]

/** Providers that can settle to a destination ≠ source (see guide §3, §6). */
export const RECIPIENT_CAPABLE_PROVIDERS = ['SOROSWAP', 'STELLAR_DEX'] as const

/** Stellar chain id / prefix used across the contract. */
export const STELLAR_CHAIN_ID = 'stellar'

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

export type FeeType = 'service' | 'liquidity' | 'inbound' | 'outbound' | 'affiliate'

export interface Fee {
  type: FeeType
  /** The provider/protocol the fee applies to. */
  protocol?: string
  /** The chain the fee applies to. */
  chain?: string
  /** Asset identifier the fee is denominated in. */
  asset: string
  /** Decimal-string amount. */
  amount: string
}

// ---------------------------------------------------------------------------
// Execution blocks (§5)
// ---------------------------------------------------------------------------

export interface StellarSignedTx {
  kind: 'stellar'
  /** Base64 TransactionEnvelope XDR to sign and submit to Horizon. */
  xdr: string
}

/**
 * `signed_transaction` execution for SOROSWAP / AQUARIUS / STELLAR_DEX — a server-built
 * Stellar envelope the client signs and submits verbatim.
 */
export interface SignedTransactionExecution {
  method: 'signed_transaction'
  chain: string
  transactions: StellarSignedTx[]
}

/**
 * `stellar_broker` execution — the session parameters the client uses to run the
 * interactive WebSocket trade. NOTE the unit/format differences vs the `/v2` request:
 * `slippageTolerance` is a FRACTION (0.01 = 1%), and assets are SB's wire form
 * (`CODE-GISSUER…` / `XLM`, no `XLM.` prefix). Use these verbatim — never re-derive them.
 */
export interface StellarBrokerExecution {
  method: 'stellar_broker'
  chain: string
  /** SB wire form: `XLM` native, `CODE-GISSUER…` classic. */
  sellingAsset: string
  buyingAsset: string
  sellingAmount: string
  /** FRACTION (0–0.5), NOT bps/percent. */
  slippageTolerance: number
  /** Partner key from the server — pass as `?partner=` on the WS URL. */
  partnerKey?: string
}

export type Execution = SignedTransactionExecution | StellarBrokerExecution

// ---------------------------------------------------------------------------
// Routes (§3, §4)
// ---------------------------------------------------------------------------

export interface EstimatedTime {
  inbound: number
  swap: number
  outbound: number
  /** Total seconds. */
  total: number
}

export interface Accuracy {
  matched: number
  total: number
  avgDeviation: number
}

/**
 * A route from `/v2/rate` (economics only) or `/v2/swap` (adds `execution` + `uuid`).
 */
export interface Route {
  /** Providers in the route (one today). `providers[0]` is the provider name. */
  providers: string[]
  sellAsset: string
  sellAmount: string
  buyAsset: string
  /** Already net of all fees. */
  expectedBuyAmount: string
  /** ENFORCED floor, or `null` when the amount is only an estimate (STELLARBROKER). */
  minBuyAmount: string | null
  fees: Fee[]
  estimatedTime: EstimatedTime
  amlPolicy?: string
  accuracy?: Accuracy
  amlErrors?: { message: string; level: number }[]
  meta?: Record<string, unknown>
  /** Present only on committed (`/v2/swap`) routes. */
  execution?: Execution
  /** Tracking handle — present only on committed routes. Store it. */
  uuid?: string
}

/** A committed route is guaranteed to carry `execution` + `uuid`. */
export interface CommittedRoute extends Route {
  execution: Execution
  uuid: string
}

export interface ProviderError {
  provider: string
  error: string
  errorCode?: string
  minimumAmount?: number
  maximumAmount?: number
}

export interface RateResponse {
  routes: Route[]
  providerErrors?: ProviderError[]
}

// ---------------------------------------------------------------------------
// Requests (§3, §4)
// ---------------------------------------------------------------------------

export interface RateRequest {
  chainId?: string
  sellAsset: string
  buyAsset: string
  sellAmount: string
  /** PERCENT (1 = 1%). */
  slippage: number
  /** Narrow the fan-out. Defaults to all four Stellar providers. */
  providers?: string[]
}

export interface SwapRequest extends RateRequest {
  provider: string
  sourceAddress: string
  destinationAddress: string
}

// ---------------------------------------------------------------------------
// Tracking (§6)
// ---------------------------------------------------------------------------

export type TrackStatus =
  | 'not_started'
  | 'pending'
  | 'swapping'
  | 'action_required'
  | 'completed'
  | 'refunded'
  | 'failed'
  | 'expired'
  | 'unknown'

export const TERMINAL_STATUSES: TrackStatus[] = ['completed', 'refunded', 'failed', 'expired']

export interface TrackLeg {
  chainId?: string
  hash?: string
  type?: string
  status?: TrackStatus
  fromAsset?: string
  fromAmount?: string
  fromAddress?: string
  toAsset?: string
  toAmount?: string
  toAddress?: string
}

export interface TrackResponse {
  status: TrackStatus
  providers: string[]
  fromAsset?: string
  fromAmount?: string
  fromAddress?: string
  toAsset?: string
  toAmount?: string
  toAddress?: string
  legs?: TrackLeg[]
  meta?: Record<string, unknown> & { pauseReason?: string; sellAmountUsd?: string }
}

export interface TrackRequest {
  uuid: string
  inboundTxHash?: string
}

// ---------------------------------------------------------------------------
// Balances (§7) — used for trustline detection
// ---------------------------------------------------------------------------

export interface BalanceEntry {
  identifier: string
  amount: string
  /** Present on classic assets. */
  ticker?: string
  address?: string
  [k: string]: unknown
}
