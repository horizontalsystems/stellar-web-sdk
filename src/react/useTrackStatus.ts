'use client'

import { useEffect, useState } from 'react'
import { useStellarSwap } from './context.js'
import { toStellarSwapError } from './internal.js'
import { TERMINAL_STATUSES } from '../core/types.js'
import type { TrackResponse } from '../core/types.js'
import type { StellarSwapError } from '../core/errors.js'

export interface UseTrackStatusOptions {
  /** Poll interval (ms). Default 60_000 — matches the server's tracking cadence. */
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
 * Poll `/v2/track` for a `uuid` until it reaches a terminal status (or times out). Re-polls when
 * `uuid` changes and stops cleanly on unmount. Pass the broadcast hash on first mount so the
 * server can bind it; subsequent polls only need the `uuid`.
 */
export function useTrackStatus(
  uuid: string | undefined,
  inboundTxHash?: string,
  options: UseTrackStatusOptions = {}
): UseTrackStatusResult {
  const sdk = useStellarSwap()
  const { intervalMs, timeoutMs, enabled = true } = options
  const [status, setStatus] = useState<TrackResponse>()
  const [error, setError] = useState<StellarSwapError>()
  const [isPolling, setIsPolling] = useState(false)

  useEffect(() => {
    if (!uuid || !enabled) return
    const controller = new AbortController()
    setError(undefined)
    setIsPolling(true)

    sdk
      .pollTrack(uuid, inboundTxHash, {
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
  }, [sdk, uuid, inboundTxHash, intervalMs, timeoutMs, enabled])

  const terminal = status ? TERMINAL_STATUSES.includes(status.status) : false
  return { status, error, isPolling: isPolling && !terminal }
}
