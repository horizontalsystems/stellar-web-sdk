/**
 * The provider-adapter contract. Every adapter under `src/providers/<name>/` is a plain
 * `getQuote(request, context, signal) => Promise<Route>` function: it fetches a quote from its
 * upstream venue, normalizes the numbers, and constructs the {@link Route} every other layer
 * consumes. Route *discovery* (which adapters to call) lives in
 * `src/routing/registry.ts`, the parallel fan-out in `src/routing/fanout.ts`, and the
 * route-selection policy in `src/core/selection.ts`.
 *
 * Ported from `uswap-server/src/providers/*` and `src/api/quote/*`. The server-only concerns —
 * the `UserFee` table, sanction haircuts, analytics rows, swap records, affiliate splits,
 * provider suspension flags — are deliberately NOT ported: they are hosting policy, not swap
 * routing, and none of them change which route wins or what it pays out.
 */

import { ResolvedConfig } from '../core/config.js'
import { StellarSwapError } from '../core/errors.js'
import { HorizonClient } from '../stellar/horizon.js'
import { Route } from '../core/types.js'

/**
 * Why a provider declined to quote. The vocabulary is deliberately finer than the SDK's public
 * error codes: "this pair has no liquidity" and "this asset is not supported" are different facts
 * about a route, and the fan-out reports each one per provider.
 */
export type QuoteErrorCode =
  | 'rateExpired'
  | 'amountTooSmall'
  | 'amountTooBig'
  | 'amountOutOfRange'
  | 'requestTimeOut'
  | 'networkError'
  | 'unknownApiError'
  | 'invalidResponseFormat'
  | 'tokenNotSupported'
  | 'pairNotSupported'
  | 'chainNotSupported'
  | 'invalidParams'
  | 'routeNotFound'

/**
 * A single provider's refusal. Extends {@link StellarSwapError} so callers still catch one class,
 * and carries the finer-grained `quoteCode` the fan-out reports per provider.
 *
 * `origin` records WHERE the decline was decided: `'local'` means our own asset/pair logic
 * rejected the request before spending an upstream call; `'provider'` (the default) means the
 * venue itself declined. The distinction is what separates "we can't express this pair" from
 * "there is no liquidity", and it is the only reason the fan-out can tell a misconfigured
 * request apart from a genuinely unroutable one.
 */
export class ProviderQuoteError extends StellarSwapError {
  readonly quoteCode: QuoteErrorCode
  readonly provider?: string
  readonly origin: 'local' | 'provider'
  readonly minimumAmount?: string
  readonly maximumAmount?: string

  constructor(
    quoteCode: QuoteErrorCode,
    message: string,
    opts: {
      provider?: string
      origin?: 'local' | 'provider'
      minimumAmount?: string
      maximumAmount?: string
      status?: number
      details?: unknown
      cause?: unknown
    } = {}
  ) {
    super(sdkCodeFor(quoteCode), message, opts)
    this.name = 'ProviderQuoteError'
    this.quoteCode = quoteCode
    this.provider = opts.provider
    this.origin = opts.origin ?? 'provider'
    this.minimumAmount = opts.minimumAmount
    this.maximumAmount = opts.maximumAmount
    Object.setPrototypeOf(this, ProviderQuoteError.prototype)
  }
}

/** Collapse a provider-level reason onto the SDK's coarser public error code. */
function sdkCodeFor(code: QuoteErrorCode): StellarSwapError['code'] {
  switch (code) {
    case 'routeNotFound':
    case 'pairNotSupported':
    case 'tokenNotSupported':
    case 'chainNotSupported':
      return 'no_route'
    case 'rateExpired':
      return 'rate_expired'
    case 'requestTimeOut':
      return 'timeout'
    case 'invalidParams':
    case 'amountTooSmall':
    case 'amountTooBig':
    case 'amountOutOfRange':
      return 'invalid_params'
    default:
      return 'provider_error'
  }
}

/**
 * What an adapter is asked to price: one exact-input side, slippage as a PERCENT (1 = 1%), and a
 * `dry` flag deciding whether the adapter merely prices the route or also builds its executable
 * form.
 */
export interface ProviderQuoteRequest {
  /** Canonical identifier — `XLM.XLM`, `XLM.CODE-GISSUER…`, or a cross-chain `CHAIN.TICKER-ADDRESS`. */
  sellAsset: string
  buyAsset: string
  /** Decimal string, whole units. */
  sellAmount: string
  /** PERCENT (1 = 1%). */
  slippage: number
  /**
   * `true` → price only (no accounts touched, no tx built, no upstream order created).
   * `false` → a committed quote: pre-flight the accounts and build the executable route.
   */
  dry: boolean
  sourceAddress?: string
  destinationAddress?: string
  /** Where a cross-chain provider refunds if it can't fill. Required by NEAR on a commit. */
  refundAddress?: string
}

/**
 * Optional upstream credentials. Every one of these venues answers CORS-enabled requests from a
 * browser (verified against all six hosts), so the adapters run natively client-side — but a key
 * placed in a browser bundle is public by construction. For a public web app, leave these unset
 * and point `config.fetch` at your own proxy, which attaches the keys server-side; the example in
 * `examples/nextjs` shows that pattern. Server-side (Node) consumers can set them directly.
 */
export interface ProviderCredentials {
  /**
   * StellarBroker partner key. REQUIRED for a committed StellarBroker route: without it the
   * broker's WebSocket accepts the connection and then silently drops it, so the failure would
   * land after the user has already confirmed. Quoting (REST `GET /quote`) is unauthenticated,
   * so a dry SB quote works without a key — but a keyless deployment declines SB on commit.
   */
  stellarBrokerPartnerKey?: string
  /** Soroswap `sk_…` bearer key. Required on every Soroswap swap endpoint (403 without it). */
  soroswapApiKey?: string
  /** NEAR 1Click bearer JWT. Optional — 1Click serves unauthenticated quotes at a lower rate limit. */
  nearApiJwt?: string
}

/** Per-provider endpoint overrides. Defaults are the public mainnet hosts. */
export interface ProviderEndpoints {
  stellarBrokerUrl?: string
  soroswapUrl?: string
  soroswapNetwork?: string
  aquariusUrl?: string
  aquariusRouterContract?: string
  nearOneClickUrl?: string
  axelarGmpUrl?: string
  axelarStellarItsContract?: string
  /** Soroban RPC, used to simulate Aquarius and Axelar Soroban invocations. */
  sorobanRpcUrl?: string
  /** Ethereum JSON-RPC, used only to price gas on an Ethereum→Stellar AXELAR_ITS transfer. */
  ethereumRpcUrl?: string
}

/**
 * Tunables that change which route wins. They are surfaced as configuration precisely so the
 * policy is inspectable rather than buried in a deployment's environment.
 */
export interface RoutingTunables {
  /** Per-provider time budget, ms. Default 12_000. */
  providerTimeoutMs?: number
  /** Whole fan-out budget, ms. Default 15_000. */
  overallTimeoutMs?: number
  /**
   * Venues requested from the Soroswap aggregator. `aqua` is excluded by default — Soroswap's
   * Aquarius integration ignores `slippageBps` and routes through stale pools that quote far off
   * market with a near-zero reported price impact. Nothing is lost: the fan-out carries the
   * DIRECT Aquarius adapter, which prices the same venue honestly.
   */
  soroswapProtocols?: string[]
  /** Reject a Soroswap route whose own reported price impact exceeds this percent. Default 15. */
  soroswapMaxPriceImpactPct?: number
  /**
   * Robustness tolerance for Horizon path selection, in percent of the best output. Default 0.5.
   * See `pickBestPath` in the STELLAR_DEX adapter for why the max-output path is not simply taken.
   */
  stellarDexPathTolerancePct?: number
  /** Multiplier on the Axelar cross-chain gas prepayment. Default 1.2. */
  axelarGasMultiplier?: number
}

/**
 * An integrator's own take on a route, per provider. On the hosted server this comes from a
 * `UserFee` database row plus a register of verified fee wallets; client-side it is plain
 * configuration. Leaving it unset — the default — means no service fee is quoted or collected,
 * which is what every adapter falls back to when it cannot actually collect one.
 *
 * The fee mechanism is different for each venue, and each adapter documents its own; what they
 * share is that a fee which cannot be collected is never quoted, so a dry route and its committed
 * counterpart always price identically.
 */
export interface ServiceFeeConfig {
  /** Basis points on the route. 0 or unset ⇒ no fee. */
  bps?: number
  /**
   * The collecting wallet (`G…`). Required by SOROSWAP (sent as `referralId`) and by STELLAR_DEX
   * (the recipient of the in-transaction fee payment). It MUST already hold a trustline for the
   * asset it collects in, or the fee leg reverts the whole transaction.
   */
  wallet?: string
  /**
   * AQUARIUS only: the deployed `ProviderSwapFeeCollector` contract id. Aquarius's router has no
   * fee parameter at all, so a fee is only possible by calling a collector contract deployed via
   * their factory. Unset ⇒ the plain router and no fee, which is the safe default.
   */
  feeCollectorContract?: string
}

/** Everything an adapter needs beyond the request itself. Assembled once per SDK instance. */
export interface ProviderContext {
  config: ResolvedConfig
  horizon: HorizonClient
  credentials: ProviderCredentials
  endpoints: ProviderEndpoints
  tunables: Required<RoutingTunables>
  /** Per-provider service fee. Absent ⇒ that provider quotes and collects no fee. */
  serviceFees: Partial<Record<string, ServiceFeeConfig>>
  /** `fetch` to use for every upstream call — the config's, so a proxy override applies here too. */
  fetch: typeof fetch
}

/** The adapter signature. `signal` carries the fan-out's per-provider time budget. */
export type ProviderGetQuote = (
  request: ProviderQuoteRequest,
  context: ProviderContext,
  signal?: AbortSignal
) => Promise<Route>

/** Resolved defaults for {@link RoutingTunables} — the hosted server's values. */
export const DEFAULT_TUNABLES: Required<RoutingTunables> = {
  providerTimeoutMs: 12_000,
  overallTimeoutMs: 15_000,
  soroswapProtocols: ['soroswap', 'phoenix', 'sdex'],
  soroswapMaxPriceImpactPct: 15,
  stellarDexPathTolerancePct: 0.5,
  axelarGasMultiplier: 1.2
}
