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

/** Providers that can settle to a destination ≠ source. */
export const RECIPIENT_CAPABLE_PROVIDERS = ['SOROSWAP', 'STELLAR_DEX'] as const

/** Cross-chain (`transfer` / deposit-to-address) providers the unified quote also fans out to. */
export const CROSS_CHAIN_PROVIDERS = ['NEAR'] as const

/** Axelar ITS — same-token cross-chain bridge (Stellar ↔ Ethereum) via a signed Stellar tx. */
export const AXELAR_PROVIDERS = ['AXELAR_ITS'] as const

/** Tokens the AXELAR_ITS provider bridges today (Stellar ↔ Ethereum, same token). */
export const AXELAR_ITS_TICKERS = ['XLM', 'SHX'] as const

/** Stellar chain id / prefix used across the contract. */
export const STELLAR_CHAIN_ID = 'stellar'

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/** Category of a fee line on a route. */
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
 * An EVM transaction request. Produced only by AXELAR_ITS on its Ethereum→Stellar direction,
 * where the transaction has to be sent by an EVM wallet. This SDK builds and describes it but
 * never signs it — `sdk.execute()` rejects it with a clear error, and the caller hands it to
 * whatever EVM signer it already has. All numeric fields are hex-quantity strings.
 */
export interface EvmSignedTx {
  kind: 'evm'
  to: string
  from: string
  /** Hex-quantity wei to attach (the Axelar gas prepayment). */
  value: string
  /** Hex calldata. */
  data: string
  gas?: string
  gasPrice: string
}

export type SignableTx = StellarSignedTx | EvmSignedTx

/**
 * `signed_transaction` execution for SOROSWAP / AQUARIUS / STELLAR_DEX / AXELAR_ITS — a fully
 * built, unsigned transaction the client signs and broadcasts verbatim. `chain` says which
 * network it belongs to, and each entry is tagged with its `kind`.
 */
export interface SignedTransactionExecution {
  method: 'signed_transaction'
  chain: string
  transactions: SignableTx[]
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

/**
 * `transfer` execution for cross-chain providers (e.g. NEAR / 1Click). There is no envelope to
 * sign: the trader sends `amount` of `asset` (with the memo/tag in `attachment`) to `depositAddress`
 * on the origin `chain`, and the provider fills the destination side. For some origin chains the
 * server can hand back a prebuilt `unsignedTx`; when it can't, `unsignedTxUnavailable` says why and
 * the client builds the deposit itself.
 */
export interface TransferExecution {
  method: 'transfer'
  /** Origin chain code the deposit is made on (e.g. `XLM`, `ETH`, `BTC`). */
  chain: string
  /** Address to send the origin funds to. */
  depositAddress: string
  /** Exact amount to deposit, in whole units (decimal string) of `asset`. */
  amount: string
  /** Origin asset identifier (`CHAIN.TICKER-ADDRESS`). */
  asset: string
  /** Memo / destination tag required by the deposit, if any (Stellar memo, XRP tag, …). */
  attachment?: { type: string; value: string }
  /** Base64/hex unsigned deposit tx the client may sign, when the server could build one. */
  unsignedTx?: string
  /** Present instead of `unsignedTx` when the server couldn't prebuild one (e.g. `chain_not_supported`). */
  unsignedTxUnavailable?: string
}

export type Execution = SignedTransactionExecution | StellarBrokerExecution | TransferExecution

// ---------------------------------------------------------------------------
// Routes (§3, §4)
// ---------------------------------------------------------------------------

/** Per-phase time estimate for a route, in seconds. */
export interface EstimatedTime {
  inbound: number
  swap: number
  outbound: number
  /** Total seconds. */
  total: number
}

/** Quote accuracy metadata the server attaches to a route (informational). */
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
  /** Unix ms after which a cross-chain quote's price/deposit is stale (cross-chain routes). */
  expiresAt?: number
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

/** A provider that couldn't serve the pair, with an optional min/max hint (as sent by the server). */
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
  /** Where refunds go if the swap can't complete. REQUIRED by cross-chain (`transfer`) providers. */
  refundAddress?: string
}

/**
 * A token from `GET /v2/tokens?provider=…` — the cross-chain asset catalog. Never hand-construct
 * `identifier`s; use these. `decimals` varies per token (unlike Stellar's fixed 7).
 */
export interface TokenInfo {
  /** Canonical `CHAIN.TICKER-ADDRESS` identifier to pass as sell/buy asset. */
  identifier: string
  chain: string
  chainId: string
  decimals: number
  ticker: string
  name?: string
  address?: string
  logoURI?: string
  coingeckoId?: string | null
  /** Provider-native id, e.g. NEAR's `nep141:…` / `nep245:…`. */
  extensions?: { providerId?: string } & Record<string, unknown>
  [k: string]: unknown
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

/** Statuses at which tracking is final and polling should stop. */
export const TERMINAL_STATUSES: readonly TrackStatus[] = ['completed', 'refunded', 'failed', 'expired']

/** One leg (inbound / swap / outbound) of a tracked swap's progress. */
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

/** Current tracking state for a committed swap (`POST /v2/track`). */
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

/** Report the broadcast hash (first call) and/or poll status for a committed swap's `uuid`. */
export interface TrackRequest {
  uuid: string
  inboundTxHash?: string
}

// ---------------------------------------------------------------------------
// Balances (§7) — used for trustline detection
// ---------------------------------------------------------------------------

/** One balance line from `/v2/balance` (used for trustline detection). */
export interface BalanceEntry {
  identifier: string
  amount: string
  /** Present on classic assets. */
  ticker?: string
  address?: string
  [k: string]: unknown
}
