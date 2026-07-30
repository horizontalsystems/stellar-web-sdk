import { Networks } from '@stellar/stellar-sdk'
import { StellarSwapError } from './errors.js'

/**
 * SDK configuration. `apiBaseUrl` + `apiKey` are the uswap-server credentials (ask esen for
 * an SDK-specific key — never reuse the mobile app's). `horizonUrl` is where the SDK submits
 * `signed_transaction` envelopes and reads account state for trustline detection.
 */
export interface StellarSwapConfig {
  /** uswap-server base, including `/v2`-parent path, e.g. `https://swap-dev.unstoppable.money/api`. */
  apiBaseUrl: string
  /** `X-API-Key` value. */
  apiKey: string
  /** Horizon endpoint for submit + account reads. Defaults to the public SDF Horizon. */
  horizonUrl?: string
  /** Network passphrase. Stellar swaps are mainnet-only (SB has no testnet), so this defaults to PUBLIC. */
  networkPassphrase?: string
  /** Override the StellarBroker WebSocket base. Defaults to `wss://api.stellar.broker/ws`. */
  brokerWsUrl?: string
  /** `fetch` implementation. Defaults to the global `fetch` (Node 18+/browser). */
  fetch?: typeof fetch
  /** `WebSocket` constructor. Defaults to the global `WebSocket` (Node 22+/browser). */
  WebSocket?: typeof WebSocket
  /** Optional request timeout (ms) for REST calls. Default 30_000. */
  requestTimeoutMs?: number
}

/** The fully-defaulted, internal shape every service consumes (all optionals resolved). */
export interface ResolvedConfig extends Required<Omit<StellarSwapConfig, 'fetch' | 'WebSocket'>> {
  fetch: typeof fetch
  WebSocket: typeof WebSocket
}

/**
 * Validate a user config and fill in defaults. Requires `apiBaseUrl` + `apiKey`; strips trailing
 * slashes from URLs; binds the default global `fetch` to `globalThis` (an unbound `window.fetch`
 * would throw "Illegal invocation" when called as a method); and defers the `WebSocket` check to
 * session start, since only StellarBroker routes need it.
 */
export function resolveConfig(config: StellarSwapConfig): ResolvedConfig {
  if (!config.apiBaseUrl) throw new StellarSwapError('invalid_config', 'apiBaseUrl is required')
  if (!config.apiKey) throw new StellarSwapError('invalid_config', 'apiKey is required')

  // Bind the global default to `globalThis`: the SDK calls `config.fetch(...)` as a method, so an
  // unbound browser `window.fetch` would run with `this === config` and throw "Illegal invocation".
  // A caller-supplied `fetch` is left as-is (bind it yourself if it needs a receiver).
  const fetchImpl = config.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
  if (typeof fetchImpl !== 'function') {
    throw new StellarSwapError(
      'invalid_config',
      'No global fetch available — pass `fetch` in the config (Node 18+ or a polyfill)'
    )
  }
  const WebSocketImpl = config.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  // WebSocket is only needed for StellarBroker sessions; defer the hard error to session start.

  return {
    apiBaseUrl: config.apiBaseUrl.replace(/\/+$/, ''),
    apiKey: config.apiKey,
    horizonUrl: (config.horizonUrl ?? 'https://horizon.stellar.org').replace(/\/+$/, ''),
    networkPassphrase: config.networkPassphrase ?? Networks.PUBLIC,
    brokerWsUrl: config.brokerWsUrl ?? 'wss://api.stellar.broker/ws',
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    fetch: fetchImpl,
    // Cast is safe: session code re-checks and throws a clear error if this is undefined.
    WebSocket: WebSocketImpl as typeof WebSocket
  }
}
