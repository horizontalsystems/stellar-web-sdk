/**
 * The local routing stack, assembled: discovery → fan-out → solver.
 *
 * This is the piece that makes the SDK self-sufficient. `quote()` classifies the pair, asks every
 * eligible provider in parallel, and ranks the routes; `commit()` runs exactly one
 * provider with `dry: false` so it builds the executable route.
 */

import { ResolvedConfig } from '../core/config.js'
import { StellarSwapError } from '../core/errors.js'
import { CommittedRoute, ProviderError, Route, TokenInfo } from '../core/types.js'
import { selectUnifiedRoute } from '../core/selection.js'
import { ProviderContext, ProviderQuoteRequest } from '../providers/types.js'
import { getCatalog } from '../providers/near/index.js'
import { HorizonClient } from '../stellar/horizon.js'
import { runFanout } from './fanout.js'
import { Discovery, discoverProviders, providerByName } from './registry.js'

export interface LocalQuoteResult {
  route?: Route
  provider?: string
  allRoutes: Route[]
  providerErrors: ProviderError[]
  discovery: Discovery
  /** Per-provider wall-clock in ms — what the benchmark harness reports on. */
  timings: Record<string, number>
}

export class LocalRouter {
  readonly context: ProviderContext

  constructor(config: ResolvedConfig, horizon: HorizonClient) {
    this.context = {
      config,
      horizon,
      credentials: config.credentials,
      endpoints: config.endpoints,
      tunables: config.tunables,
      serviceFees: config.serviceFees,
      fetch: config.fetch
    }
  }

  /** Price a pair across every eligible provider and pick the best route. Read-only. */
  async quote(
    request: Omit<ProviderQuoteRequest, 'dry'> & { providers?: string[] },
    signal?: AbortSignal
  ): Promise<LocalQuoteResult> {
    const discovery = discoverProviders({
      sellAsset: request.sellAsset,
      buyAsset: request.buyAsset,
      sourceAddress: request.sourceAddress,
      destinationAddress: request.destinationAddress,
      providers: request.providers
    })

    const registered = discovery.providers.map(resolveProvider)

    const { routes, errors, timings } = await runFanout(
      registered,
      { ...request, dry: true },
      this.context,
      signal
    )

    const route = selectUnifiedRoute(routes)
    return {
      route,
      provider: route?.providers[0],
      allRoutes: routes,
      providerErrors: errors,
      discovery,
      timings
    }
  }

  /**
   * Commit against ONE provider, named by the caller (normally the picked route's) so the
   * committed quote matches the price that was shown.
   *
   * A locally committed route carries a client-minted `uuid`. It is a correlation handle for the
   * caller's own records, not a server-side order id: there is no order to create, because every
   * one of these providers is either quoted-and-built in the same call or, in StellarBroker's case,
   * negotiated live during the session.
   */
  async commit(
    request: ProviderQuoteRequest & { provider: string },
    signal?: AbortSignal
  ): Promise<CommittedRoute> {
    const provider = resolveProvider(request.provider)

    const route = await provider.getQuote({ ...request, dry: false }, this.context, signal)
    if (!route.execution) {
      throw new StellarSwapError('provider_error', `${request.provider} returned a committed route with no execution`, {
        details: route
      })
    }

    return { ...route, execution: route.execution, uuid: newUuid() } as CommittedRoute
  }

  /** The cross-chain asset catalog, straight from the provider. Memoized per SDK instance. */
  async crossChainTokens(provider: string, signal?: AbortSignal): Promise<TokenInfo[]> {
    if (provider !== 'NEAR') {
      throw new StellarSwapError(
        'invalid_params',
        `No local asset catalog for ${provider}. NEAR publishes one; AXELAR_ITS ships a static ` +
          `table (see providers/axelar/config.ts), and Stellar assets need no catalog.`
      )
    }
    return getCatalog(this.context, signal)
  }
}

function resolveProvider(name: string) {
  const provider = providerByName(name)
  if (!provider) {
    throw new StellarSwapError('invalid_params', `Unknown provider: ${name}`)
  }
  return provider
}

/**
 * A v4 UUID. Prefers the platform `crypto.randomUUID` and falls back to `getRandomValues`, which
 * covers Node 18 and every browser; the last resort keeps the SDK working in an exotic runtime
 * where neither exists, since this identifier is a local correlation handle and nothing reads it
 * as a security token.
 */
function newUuid(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
