import { ResolvedConfig } from '../core/config.js'
import { StellarSwapError, codeForStatus } from '../core/errors.js'
import {
  BalanceEntry,
  CommittedRoute,
  RateRequest,
  RateResponse,
  Route,
  SwapRequest,
  TokenInfo,
  TrackRequest,
  TrackResponse
} from '../core/types.js'

/**
 * Thin, typed wrapper over the uswap-server `/v2` endpoints the SDK uses. It only speaks JSON,
 * attaches `X-API-Key`, and normalizes non-2xx bodies into `StellarSwapError`s (preserving the
 * provider error body on `.details`). No routing/waterfall logic lives here — that's policy.
 */
export class UswapClient {
  constructor(private readonly config: ResolvedConfig) {}

  /** `POST /v2/rate` — read-only fan-out quote across the requested providers. */
  async rate(req: RateRequest): Promise<RateResponse> {
    return this.post<RateResponse>('/v2/rate', req)
  }

  /**
   * `POST /v2/swap` — commit against ONE provider. Returns the executable route with
   * `execution` + top-level `uuid`. The server runs its preflight here (accounts exist,
   * trustline present), so a bad setup fails as a clean 4xx before any signing.
   */
  async swap(req: SwapRequest): Promise<CommittedRoute> {
    const route = await this.post<Route>('/v2/swap', req)
    if (!route.execution || !route.uuid) {
      throw new StellarSwapError('server_error', '/v2/swap returned a route without execution or uuid', {
        details: route
      })
    }
    return route as CommittedRoute
  }

  /** `POST /v2/track` — report the broadcast hash / poll for status. */
  async track(req: TrackRequest): Promise<TrackResponse> {
    return this.post<TrackResponse>('/v2/track', req)
  }

  /**
   * `GET /v2/balance` — balances for an address on a chain, optionally scoped to one asset.
   * Used to detect whether the destination already holds a buy-asset trustline.
   */
  async balance(chain: string, address: string, identifier?: string): Promise<BalanceEntry[]> {
    const params = new URLSearchParams({ chain, address })
    if (identifier) params.set('identifier', identifier)
    const body = await this.get<BalanceEntry[] | { balances: BalanceEntry[] }>(`/v2/balance?${params.toString()}`)
    // The endpoint may return a bare array or a `{ balances }` envelope depending on version.
    return Array.isArray(body) ? body : (body.balances ?? [])
  }

  /**
   * `GET /v2/tokens?provider=…` — the provider's cross-chain asset catalog. Required for NEAR:
   * use the returned `identifier`s as sell/buy assets (never hand-build them). Returns a bare
   * array or a `{ tokens }` envelope depending on version.
   */
  async tokens(provider: string): Promise<TokenInfo[]> {
    const body = await this.get<TokenInfo[] | { tokens: TokenInfo[] }>(
      `/v2/tokens?provider=${encodeURIComponent(provider)}`
    )
    return Array.isArray(body) ? body : (body.tokens ?? [])
  }

  /** `GET /v2/providers` — provider metadata (executionType, suspended, contacts, …). */
  async providers(): Promise<unknown[]> {
    const body = await this.get<unknown[] | { providers: unknown[] }>('/v2/providers')
    return Array.isArray(body) ? body : (body.providers ?? [])
  }

  // --- transport -----------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.config.apiBaseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs)

    let res: Response
    try {
      res = await this.config.fetch(url, {
        method,
        headers: {
          'X-API-Key': this.config.apiKey,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      })
    } catch (err) {
      if (controller.signal.aborted) {
        throw new StellarSwapError('timeout', `Request to ${path} timed out after ${this.config.requestTimeoutMs}ms`, {
          cause: err
        })
      }
      throw new StellarSwapError('server_error', `Network error calling ${path}: ${(err as Error).message}`, {
        cause: err
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    const parsed = parseJson(text)

    if (!res.ok) {
      const providerBody = (parsed ?? {}) as { error?: string; provider?: string; errorCode?: string }
      const message =
        providerBody.error ??
        (typeof parsed === 'string' ? parsed : undefined) ??
        `${res.status} ${res.statusText} from ${path}`
      throw new StellarSwapError(codeForStatus(res.status), message, {
        status: res.status,
        details: parsed ?? text
      })
    }

    return parsed as T
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
