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
 * A commercial Stellar RPC vendor that serves BOTH Horizon REST and Soroban RPC from one base,
 * `<host>/<apiKey>`. Supplying it here is the shorthand for setting `horizonUrl` and
 * `endpoints.sorobanRpcUrl` to the same derived base — worth having as its own field because the
 * public SDF endpoints are rate-limited enough to drop routes under a real fan-out, and the
 * alternative is every caller hand-concatenating the same URL.
 *
 * Either endpoint can still be overridden individually; see {@link resolveConfig} for precedence.
 */
export interface ValidationCloudConfig {
  apiKey: string
  /** Defaults to the mainnet host. Override for a different network or a dedicated deployment. */
  host?: string
}

/**
 * SDK configuration.
 *
 * The SDK talks to the swap providers directly — StellarBroker, Soroswap, Aquarius, Horizon,
 * 1Click and Axelar — for quoting, route selection, execution and outcome tracking alike. There is
 * no backend to point it at and no API key to obtain for the SDK itself; nothing here is required
 * beyond a runtime `fetch`.
 *
 * The keys that DO exist all belong to upstream services, and every one of them is passed here:
 * the venues' own credentials in `credentials`, and an optional commercial RPC endpoint in
 * `validationCloud` (or as raw URLs via `horizonUrl` / `endpoints.sorobanRpcUrl`).
 */
export interface StellarSwapConfig {
  /**
   * Horizon endpoint for submits, account reads, path-finding and tracking. Takes precedence over
   * `validationCloud`; falls back to the public SDF Horizon.
   */
  horizonUrl?: string
  /** Network passphrase. Stellar swaps are mainnet-only (SB has no testnet), so this defaults to PUBLIC. */
  networkPassphrase?: string
  /** Override the StellarBroker WebSocket base. Defaults to `wss://api.stellar.broker/ws`. */
  brokerWsUrl?: string
  /**
   * Upstream provider credentials. A key placed in a browser bundle is public by construction —
   * for a public web app leave these unset and point `fetch` at a proxy that attaches them
   * server-side. See `examples/nextjs` for that pattern.
   */
  credentials?: ProviderCredentials
  /**
   * A commercial Horizon + Soroban RPC endpoint, supplied as a key rather than a hand-built URL.
   * Fills in `horizonUrl` and `endpoints.sorobanRpcUrl` together unless either is set explicitly.
   */
  validationCloud?: ValidationCloudConfig
  /** Per-provider endpoint overrides. Defaults are the public mainnet hosts. */
  endpoints?: ProviderEndpoints
  /** Timeouts and route-selection tunables. */
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

const DEFAULT_VALIDATION_CLOUD_HOST = 'https://mainnet.stellar.validationcloud.io/v1'

/** `<host>/<apiKey>` — the one base that serves both Horizon REST and Soroban RPC. */
function validationCloudBase(config: ValidationCloudConfig | undefined): string | undefined {
  if (!config?.apiKey) return undefined
  const host = (config.host ?? DEFAULT_VALIDATION_CLOUD_HOST).replace(/\/+$/, '')
  return `${host}/${config.apiKey}`
}

/**
 * Validate a user config and fill in defaults.
 *
 * Endpoint precedence, for both Horizon and Soroban RPC: an explicitly supplied URL wins, then the
 * `validationCloud` base, then the public host. Per-endpoint overrides therefore compose with the
 * vendor key rather than being replaced by it — you can route Horizon through a vendor and Soroban
 * somewhere else, or vice versa.
 *
 * Also strips trailing slashes from URLs, binds the default global `fetch` to `globalThis` (an
 * unbound `window.fetch` would throw "Illegal invocation" when called as a method), and defers the
 * `WebSocket` check to session start, since only StellarBroker routes need it.
 */
export function resolveConfig(config: StellarSwapConfig = {}): ResolvedConfig {
  const vendorBase = validationCloudBase(config.validationCloud)
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
    horizonUrl: (config.horizonUrl ?? vendorBase ?? 'https://horizon.stellar.org').replace(/\/+$/, ''),
    networkPassphrase: config.networkPassphrase ?? Networks.PUBLIC,
    brokerWsUrl: config.brokerWsUrl ?? 'wss://api.stellar.broker/ws',
    credentials: config.credentials ?? {},
    endpoints: {
      ...config.endpoints,
      // Resolved here so the adapters that simulate Soroban read one field and never repeat the
      // precedence rule. An explicit override still wins.
      ...(config.endpoints?.sorobanRpcUrl ?? vendorBase
        ? { sorobanRpcUrl: config.endpoints?.sorobanRpcUrl ?? vendorBase }
        : {})
    },
    tunables: { ...DEFAULT_TUNABLES, ...config.tunables },
    serviceFees: config.serviceFees ?? {},
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    fetch: fetchImpl,
    // Cast is safe: session code re-checks and throws a clear error if this is undefined.
    WebSocket: WebSocketImpl as typeof WebSocket
  }
}
