'use client'

import { useEffect, useState } from 'react'
import { useStellarSwap } from './context.js'
import { toStellarSwapError } from './internal.js'
import { TERMINAL_STATUSES } from '../core/types.js'
import type { CommittedRoute, TrackResponse } from '../core/types.js'
import type { StellarSwapError } from '../core/errors.js'

export interface UseTrackStatusOptions {
  /** Poll interval (ms). Default 15_000. */
  intervalMs?: number
  /** Give up after this long (ms). Default 1 hour. */
  timeoutMs?: number
  /** Set `false` to pause polling (e.g. before a swap has committed). Default `true`. */
  enabled?: boolean
}

export interface UseTrackStatusResult {
  status?: TrackResponse
  error?: StellarSwapError
  /** `true` while polling and the status is not yet terminal. */
  isPolling: boolean
}

/**
 * Poll a committed route's outcome until it reaches a terminal status (or times out) — against
 * Horizon, 1Click or Axelarscan, depending on the provider. Re-polls when the route or the hash
 * changes, and stops cleanly on unmount or when `enabled` flips false.
 *
 * Pass the `CommittedRoute` itself. A `uuid` also works for a route committed by this SDK instance,
 * but the uuid registry is in-memory, so it does not survive a reload — the route does.
 */
export function useTrackStatus(
  route: CommittedRoute | string | undefined,
  inboundTxHash?: string,
  options: UseTrackStatusOptions = {}
): UseTrackStatusResult {
  const sdk = useStellarSwap()
  const { intervalMs, timeoutMs, enabled = true } = options
  const [status, setStatus] = useState<TrackResponse>()
  const [error, setError] = useState<StellarSwapError>()
  const [isPolling, setIsPolling] = useState(false)

  // A route object is a fresh reference on every render, so the effect keys off its identity —
  // the uuid — rather than the object, or it would restart the poll on each render.
  const routeKey = typeof route === 'string' ? route : route?.uuid

  useEffect(() => {
    if (!route || !enabled) {
      // Nothing to poll — make sure a previously-true isPolling doesn't stick (the aborted
      // promise's .then/.catch never run, so reset here).
      setIsPolling(false)
      return
    }
    const controller = new AbortController()
    setError(undefined)
    setIsPolling(true)

    sdk
      .pollTrack(route, inboundTxHash, {
        intervalMs,
        timeoutMs,
        signal: controller.signal,
        onUpdate: (s) => {
          if (!controller.signal.aborted) setStatus(s)
        }
      })
      .then((final) => {
        if (!controller.signal.aborted) {
          setStatus(final)
          setIsPolling(false)
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(toStellarSwapError(err))
          setIsPolling(false)
        }
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by routeKey, see above
  }, [sdk, routeKey, inboundTxHash, intervalMs, timeoutMs, enabled])

  const terminal = status ? TERMINAL_STATUSES.includes(status.status) : false
  return { status, error, isPolling: isPolling && !terminal }
}
