import { Networks } from '@stellar/stellar-sdk'
import { StellarSwapError } from './errors.js'
import {
  DEFAULT_TUNABLES,
  ProviderCredentials,
  ProviderEndpoints,
  RoutingTunables,
  ServiceFeeConfig
} from '../providers/types.js'

/**
 * How the SDK discovers and prices routes.
 *
 *  - `'local'` (the default) runs the provider adapters in this package: the SDK talks to
 *    StellarBroker, Soroswap, Aquarius, Horizon, 1Click and Axelar directly, fans out across them,
 *    and applies the waterfall itself. Nothing about pricing or route selection depends on a
 *    hosted service. Every one of those hosts serves CORS-enabled responses, so this works in a
 *    browser as well as in Node.
 *  - `'server'` routes through a uswap-server deployment's `/v2` endpoints instead, which is the
 *    original behaviour and remains useful when you want its server-side tracking, or when you
 *    would rather keep provider API keys off the client entirely.
 *
 * Tracking is server-side either way: `/v2/track` reconciles outcomes on Horizon and is the one
 * capability local mode does not replace. Configure `apiBaseUrl` + `apiKey` to use it.
 */
export type RoutingMode = 'local' | 'server'

/**
 * SDK configuration. In the default `'local'` routing mode nothing here is required except a
 * runtime `fetch`; `apiBaseUrl` + `apiKey` are needed only for `'server'` routing or for tracking.
 */
export interface StellarSwapConfig {
  /** Where routes come from. Defaults to `'local'`. */
  routing?: RoutingMode
  /**
   * uswap-server base including the `/v2` parent path, e.g. `https://swap-dev.unstoppable.money/api`.
   * Required for `routing: 'server'`, and for tracking in either mode.
   */
  apiBaseUrl?: string
  /** `X-API-Key` value. Required alongside `apiBaseUrl`. */
  apiKey?: string
  /** Horizon endpoint for submits, account reads and path-finding. Defaults to the public SDF Horizon. */
  horizonUrl?: string
  /** Network passphrase. Stellar swaps are mainnet-only (SB has no testnet), so this defaults to PUBLIC. */
  networkPassphrase?: string
  /** Override the StellarBroker WebSocket base. Defaults to `wss://api.stellar.broker/ws`. */
  brokerWsUrl?: string
  /**
   * Upstream provider credentials for local routing. A key placed in a browser bundle is public by
   * construction — for a public web app leave these unset and point `fetch` at a proxy that
   * attaches them server-side. See `examples/nextjs` for that pattern.
   */
  credentials?: ProviderCredentials
  /** Per-provider endpoint overrides. Defaults are the public mainnet hosts. */
  endpoints?: ProviderEndpoints
  /** Timeouts and route-selection tunables. Defaults match the hosted server's values. */
  tunables?: RoutingTunables
  /** Per-provider service fee. Unset ⇒ no fee is quoted or collected. */
  serviceFees?: Record<string, ServiceFeeConfig>
  /** `fetch` implementation. Defaults to the global `fetch` (Node 18+/browser). */
  fetch?: typeof fetch
  /** `WebSocket` constructor. Defaults to the global `WebSocket` (Node 22+/browser). */
  WebSocket?: typeof WebSocket
  /** Optional request timeout (ms) for REST calls. Default 30_000. */
  requestTimeoutMs?: number
}

/** The fully-defaulted, internal shape every service consumes (all optionals resolved). */
export interface ResolvedConfig {
  routing: RoutingMode
  /** Empty string when no server is configured; `requireServer` is what guards its use. */
  apiBaseUrl: string
  apiKey: string
  horizonUrl: string
  networkPassphrase: string
  brokerWsUrl: string
  credentials: ProviderCredentials
  endpoints: ProviderEndpoints
  tunables: Required<RoutingTunables>
  serviceFees: Record<string, ServiceFeeConfig>
  requestTimeoutMs: number
  fetch: typeof fetch
  WebSocket: typeof WebSocket
}

/**
 * Validate a user config and fill in defaults. `'server'` routing requires `apiBaseUrl` + `apiKey`;
 * `'local'` routing requires neither. Strips trailing slashes from URLs, binds the default global
 * `fetch` to `globalThis` (an unbound `window.fetch` would throw "Illegal invocation" when called
 * as a method), and defers the `WebSocket` check to session start, since only StellarBroker routes
 * need it.
 */
export function resolveConfig(config: StellarSwapConfig): ResolvedConfig {
  const routing: RoutingMode = config.routing ?? 'local'

  if (routing === 'server') {
    if (!config.apiBaseUrl) throw new StellarSwapError('invalid_config', "apiBaseUrl is required for routing: 'server'")
    if (!config.apiKey) throw new StellarSwapError('invalid_config', "apiKey is required for routing: 'server'")
  }
  // A partially configured server is a mistake worth catching now rather than at the first track()
  // call, when a swap has already been executed.
  if (!!config.apiBaseUrl !== !!config.apiKey) {
    throw new StellarSwapError('invalid_config', 'apiBaseUrl and apiKey must be set together')
  }

  // Bind the global default to `globalThis`: the SDK calls `config.fetch(...)` as a method, so an
  // unbound browser `window.fetch` would run with `this === config` and throw "Illegal invocation".
  // A caller-supplied `fetch` is left as-is (bind it yourself if it needs a receiver).
  const fetchImpl =
    config.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
  if (typeof fetchImpl !== 'function') {
    throw new StellarSwapError(
      'invalid_config',
      'No global fetch available — pass `fetch` in the config (Node 18+ or a polyfill)'
    )
  }
  const WebSocketImpl = config.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket

  return {
    routing,
    apiBaseUrl: (config.apiBaseUrl ?? '').replace(/\/+$/, ''),
    apiKey: config.apiKey ?? '',
    horizonUrl: (config.horizonUrl ?? 'https://horizon.stellar.org').replace(/\/+$/, ''),
    networkPassphrase: config.networkPassphrase ?? Networks.PUBLIC,
    brokerWsUrl: config.brokerWsUrl ?? 'wss://api.stellar.broker/ws',
    credentials: config.credentials ?? {},
    endpoints: config.endpoints ?? {},
    tunables: { ...DEFAULT_TUNABLES, ...config.tunables },
    serviceFees: config.serviceFees ?? {},
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    fetch: fetchImpl,
    // Cast is safe: session code re-checks and throws a clear error if this is undefined.
    WebSocket: WebSocketImpl as typeof WebSocket
  }
}

/** Guard for the operations that genuinely need a hosted server (today: tracking). */
export function requireServer(config: ResolvedConfig, operation: string): void {
  if (!config.apiBaseUrl || !config.apiKey) {
    throw new StellarSwapError(
      'invalid_config',
      `${operation} needs a uswap-server deployment — set apiBaseUrl and apiKey. ` +
        `Local routing prices and executes swaps without one, but server-side tracking is not part of that.`
    )
  }
}
