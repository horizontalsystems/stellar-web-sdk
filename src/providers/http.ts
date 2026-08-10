/**
 * The one HTTP path every provider adapter uses. Replaces the server's per-provider axios
 * singletons with a plain `fetch` call so the SDK keeps its single runtime dependency
 * (`@stellar/stellar-sdk`) and stays bundler-friendly.
 *
 * It threads the fan-out's `AbortSignal` through to the request, so a provider that blows its
 * time budget has its in-flight socket torn down rather than left running in the background.
 */

import { ProviderQuoteError, QuoteErrorCode } from './types.js'

export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** JSON-serialized as the body when present. */
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
  fetch: typeof fetch
  /** Provider name, for error attribution. */
  provider: string
}

export interface HttpResult<T> {
  ok: boolean
  status: number
  data: T
}

/**
 * Perform one upstream call and parse the body as JSON. Non-2xx responses do NOT throw — several
 * of these APIs use a 4xx (or a 200 with a failure field) as their ordinary "no route" signal, and
 * only the adapter knows which is which. Transport failures DO throw, as `networkError` /
 * `requestTimeOut`, because no adapter can interpret those any better than we can here.
 */
export async function httpJson<T>(req: HttpRequest): Promise<HttpResult<T>> {
  const url = req.query ? withQuery(req.url, req.query) : req.url
  const hasBody = req.body !== undefined

  let res: Response
  try {
    res = await req.fetch(url, {
      method: req.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...req.headers
      },
      ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
      ...(req.signal ? { signal: req.signal } : {})
    })
  } catch (err) {
    // Our own AbortController fired (the fan-out's budget), or the network failed outright.
    if (req.signal?.aborted) {
      throw new ProviderQuoteError('requestTimeOut', `${req.provider}: request aborted (time budget exceeded)`, {
        provider: req.provider,
        cause: err
      })
    }
    throw new ProviderQuoteError('networkError', `${req.provider}: ${(err as Error).message}`, {
      provider: req.provider,
      cause: err
    })
  }

  const text = await res.text().catch(() => '')
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    // A non-JSON body on a 2xx is a contract violation; on an error status it is just the
    // upstream's error page, which the adapter surfaces verbatim.
    if (res.ok) {
      throw new ProviderQuoteError('invalidResponseFormat', `${req.provider}: non-JSON response body`, {
        provider: req.provider,
        status: res.status,
        details: text.slice(0, 500)
      })
    }
    data = text
  }

  return { ok: res.ok, status: res.status, data: data as T }
}

function withQuery(url: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const qs = params.toString()
  if (!qs) return url
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`
}

/** Shorthand for the common "upstream said no" throw, with the provider attributed. */
export function providerError(
  provider: string,
  code: QuoteErrorCode,
  message: string,
  opts: { status?: number; details?: unknown; origin?: 'local' | 'provider' } = {}
): ProviderQuoteError {
  return new ProviderQuoteError(code, `${provider}: ${message}`, { provider, ...opts })
}
