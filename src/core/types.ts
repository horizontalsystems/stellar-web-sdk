/**
 * The shared vocabulary of the SDK: routes, executions, fees and tracking. Provider adapters
 * produce these, the solver ranks them, the executors consume them, and the trackers report
 * against them. Fields an adapter may not populate are optional rather than empty-valued, so
 * "absent" and "zero" stay distinguishable.
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
// Execution blocks
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
 * `stellar_broker` execution — the session parameters the client uses to run the interactive
 * WebSocket trade. NOTE the unit/format differences from a quote request: `slippageTolerance` is a
 * FRACTION (0.01 = 1%), and assets are SB's wire form (`CODE-GISSUER…` / `XLM`, no `XLM.` prefix).
 * Use these verbatim — never re-derive them.
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
  /** Partner key — passed as `?partner=` on the WebSocket URL. */
  partnerKey?: string
}

/**
 * `transfer` execution for cross-chain providers (e.g. NEAR / 1Click). There is no envelope to
 * sign: the trader sends `amount` of `asset` (with the memo/tag in `attachment`) to `depositAddress`
 * on the origin `chain`, and the provider fills the destination side. A Stellar-origin deposit is
 * built by this SDK; for any other origin chain `unsignedTxUnavailable` says so and the connected
 * wallet builds the transfer itself.
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
  /** Base64 unsigned deposit tx the client may sign, when the SDK could build one. */
  unsignedTx?: string
  /** Present instead of `unsignedTx` when the SDK can't build one (e.g. `chain_not_supported`). */
  unsignedTxUnavailable?: string
}

export type Execution = SignedTransactionExecution | StellarBrokerExecution | TransferExecution

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Per-phase time estimate for a route, in seconds. */
export interface EstimatedTime {
  inbound: number
  swap: number
  outbound: number
  /** Total seconds. */
  total: number
}

/** Quote accuracy metadata a provider may attach to a route (informational). */
export interface Accuracy {
  matched: number
  total: number
  avgDeviation: number
}

/**
 * What tracking needs to follow a committed route to its outcome. Built by the adapter that
 * produced the route, because only it knows which identifiers its venue is keyed by — a Stellar
 * swap is found by transaction hash, a NEAR swap by deposit address and memo, an Axelar transfer
 * by its source-chain hash across two hub hops.
 *
 * This travels on the route so that tracking needs no server-side record of the swap: everything
 * required to verify the outcome against the chain (or the provider's own status endpoint) is in
 * the object the caller already holds.
 */
export interface RouteTracking {
  provider: string
  fromAsset: string
  toAsset: string
  toAddress: string
  fromAddress?: string
  fromAmount?: string
  /** Cross-chain deposit rails (NEAR): the swap is keyed by these, not by a transaction hash. */
  depositAddress?: string
  depositMemo?: string
  /** Bridges (AXELAR_ITS): the chain codes the two hub hops run between. */
  fromChain?: string
  toChain?: string
}

/**
 * A route from a dry quote (economics only) or a committed quote (adds `execution` + `uuid`).
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
  /** Present only on committed routes. */
  execution?: Execution
  /** Correlation handle for the caller's own records. Present only on committed routes. */
  uuid?: string
  /** What `sdk.track()` needs to follow this route. Present only on committed routes. */
  tracking?: RouteTracking
}

/** A committed route is guaranteed to carry `execution`, `uuid` and `tracking`. */
export interface CommittedRoute extends Route {
  execution: Execution
  uuid: string
  tracking: RouteTracking
}

/** A provider that couldn't serve the pair, with an optional min/max hint. */
export interface ProviderError {
  provider: string
  error: string
  errorCode?: string
  minimumAmount?: number
  maximumAmount?: number
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
// Tracking
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

/** Current tracking state for a committed swap, as read from the provider or the chain. */
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

