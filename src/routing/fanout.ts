/**
 * The provider fan-out — run every discovered adapter in parallel under a time budget, and
 * normalize what comes back into routes plus per-provider errors.
 *
 * What lives here is only what decides what a caller sees: the two-level time budget, the abort
 * cascade, the local declines that never spend an upstream call, and the error normalization.
 *
 * The budget is two-level on purpose. Each provider gets its own allowance so one slow venue
 * cannot consume the whole quote, and the fan-out gets an overall allowance so the *sum* of
 * near-miss providers still can't. When either expires the provider's AbortController fires, so
 * `fetch` tears down the in-flight socket instead of leaving it running.
 */

import { ProviderError, Route } from '../core/types.js'
import { ProviderQuoteError } from '../providers/types.js'
import { ProviderContext, ProviderQuoteRequest } from '../providers/types.js'
import { RegisteredProvider } from './registry.js'

export interface FanoutResult {
  routes: Route[]
  errors: ProviderError[]
  /** Per-provider wall-clock, in ms. Populated for every provider that was actually called. */
  timings: Record<string, number>
}

interface ProviderOk {
  kind: 'ok'
  provider: string
  route: Route
  ms: number
}

interface ProviderErr {
  kind: 'err'
  provider: string
  error: unknown
  ms: number
}

/**
 * Run one provider under a bounded budget. The signal is threaded into the adapter so a
 * cooperative `fetch` tears down its socket; a timer-based rejection is layered on top as a safety
 * net, because a non-cooperative code path (a pure-compute stall, an SDK that ignores signals)
 * would otherwise block the whole fan-out on one provider.
 */
async function runOne(
  provider: RegisteredProvider,
  request: ProviderQuoteRequest,
  context: ProviderContext,
  overallSignal: AbortSignal,
  overallDeadline: number
): Promise<ProviderOk | ProviderErr> {
  const start = Date.now()
  const budget = Math.max(0, Math.min(context.tunables.providerTimeoutMs, overallDeadline - start))

  const controller = new AbortController()
  // Cascade: aborting the whole fan-out aborts each provider still in flight.
  const onOverallAbort = () => controller.abort()
  if (overallSignal.aborted) onOverallAbort()
  else overallSignal.addEventListener('abort', onOverallAbort, { once: true })

  const timer = setTimeout(() => controller.abort(), budget)

  const safetyNet = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(
        new ProviderQuoteError('requestTimeOut', `${provider.name}: timed out after ${budget}ms`, {
          provider: provider.name
        })
      )
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener('abort', onAbort, { once: true })
  })

  // Start the work but detach it from the race's error handling. If the safety net wins, the
  // original promise is orphaned — JavaScript cannot actually cancel it — so a no-op catch keeps a
  // late rejection from surfacing as an unhandled rejection.
  const work = provider.getQuote(request, context, controller.signal)
  work.catch(() => {})

  try {
    const route = await Promise.race([work, safetyNet])
    return { kind: 'ok', provider: provider.name, route, ms: Date.now() - start }
  } catch (error) {
    return { kind: 'err', provider: provider.name, error, ms: Date.now() - start }
  } finally {
    clearTimeout(timer)
    overallSignal.removeEventListener('abort', onOverallAbort)
  }
}

/**
 * Fan out every provider in parallel and collect the routes.
 *
 * A provider that declines is NOT an error for the caller: `errors` records why each one declined,
 * so a client that explicitly asked for a provider learns what happened instead of seeing a silent
 * gap, while the fan-out as a whole still succeeds as long as one route came back.
 */
export async function runFanout(
  providers: RegisteredProvider[],
  request: ProviderQuoteRequest,
  context: ProviderContext,
  signal?: AbortSignal
): Promise<FanoutResult> {
  const errors: ProviderError[] = []
  const timings: Record<string, number> = {}

  // A same-asset "swap" has no route by definition. Decline locally rather than spend a call on
  // every provider, but still report it per-provider so the reason is visible.
  const sameAsset = request.sellAsset.toLowerCase() === request.buyAsset.toLowerCase()
  const runnable = providers.filter((p) => {
    if (sameAsset) {
      errors.push({
        provider: p.name,
        error: 'sellAsset and buyAsset are the same',
        errorCode: 'routeNotFound'
      })
      return false
    }
    return true
  })

  if (runnable.length === 0) return { routes: [], errors, timings }

  const overallController = new AbortController()
  const onCallerAbort = () => overallController.abort()
  if (signal) {
    if (signal.aborted) onCallerAbort()
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  const overallDeadline = Date.now() + context.tunables.overallTimeoutMs
  const overallTimer = setTimeout(() => overallController.abort(), context.tunables.overallTimeoutMs)

  let results: (ProviderOk | ProviderErr)[]
  try {
    results = await Promise.all(
      runnable.map((p) => runOne(p, request, context, overallController.signal, overallDeadline))
    )
  } finally {
    clearTimeout(overallTimer)
    signal?.removeEventListener('abort', onCallerAbort)
  }

  const routes: Route[] = []
  for (const result of results) {
    timings[result.provider] = result.ms
    if (result.kind === 'ok') {
      routes.push(result.route)
    } else {
      errors.push(toProviderError(result.provider, result.error))
    }
  }

  return { routes, errors, timings }
}

/** Normalize whatever an adapter threw into the wire-shaped per-provider error. */
export function toProviderError(provider: string, error: unknown): ProviderError {
  if (error instanceof ProviderQuoteError) {
    return {
      provider,
      error: error.message,
      errorCode: error.quoteCode,
      ...(error.minimumAmount ? { minimumAmount: Number(error.minimumAmount) } : {}),
      ...(error.maximumAmount ? { maximumAmount: Number(error.maximumAmount) } : {})
    }
  }
  return { provider, error: error instanceof Error ? error.message : String(error) }
}
