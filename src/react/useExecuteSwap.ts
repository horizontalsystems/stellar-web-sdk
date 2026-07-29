'use client'

import { useCallback, useRef, useState } from 'react'
import { useStellarSwap } from './context.js'
import { toStellarSwapError, useMountedRef } from './internal.js'
import type { CommitParams, ExecutionResult } from '../StellarSwapSDK.js'
import type { StellarSigner } from '../core/signer.js'
import type { CommittedRoute, TrackResponse } from '../core/types.js'
import type { BrokerSessionPhase } from '../execution/stellarBroker/StellarBrokerSession.js'
import type { BrokerQuote } from '../execution/stellarBroker/messages.js'
import type { StellarSwapError } from '../core/errors.js'

export type SwapStatus =
  | 'idle'
  | 'committing'
  | 'executing'
  | 'tracking'
  | 'success'
  | 'error'

export interface ExecuteSwapParams extends CommitParams {
  /** The trader's signer (e.g. `keypairSigner(...)` or a wallet-kit adapter). */
  signer: StellarSigner
  /** Report the broadcast hash to `/v2/track` after execution. Default `true`. */
  track?: boolean
}

export interface UseExecuteSwapResult {
  /** Commit → execute → (optionally) track, in one call. */
  swap: (params: ExecuteSwapParams) => Promise<ExecutionResult | undefined>
  /** Abort an in-flight swap (broker session or track poll). */
  cancel: () => void
  reset: () => void
  status: SwapStatus
  route?: CommittedRoute
  execution?: ExecutionResult
  trackStatus?: TrackResponse
  /** Live StellarBroker quote (broker routes only) — show this, not the committed snapshot. */
  brokerQuote?: BrokerQuote
  brokerPhase?: BrokerSessionPhase
  brokerProgress?: { sold?: string; bought?: string }
  error?: StellarSwapError
  isLoading: boolean
}

/**
 * Orchestrates a full swap for a chosen provider: `commit` → `execute` → `track`. Surfaces the
 * live StellarBroker session state (quote / phase / progress) so a broker route can drive UI
 * without wiring callbacks by hand. Only one swap runs at a time; `cancel()` aborts it.
 */
export function useExecuteSwap(): UseExecuteSwapResult {
  const sdk = useStellarSwap()
  const mounted = useMountedRef()
  const abortRef = useRef<AbortController>()

  const [status, setStatus] = useState<SwapStatus>('idle')
  const [route, setRoute] = useState<CommittedRoute>()
  const [execution, setExecution] = useState<ExecutionResult>()
  const [trackStatus, setTrackStatus] = useState<TrackResponse>()
  const [brokerQuote, setBrokerQuote] = useState<BrokerQuote>()
  const [brokerPhase, setBrokerPhase] = useState<BrokerSessionPhase>()
  const [brokerProgress, setBrokerProgress] = useState<{ sold?: string; bought?: string }>()
  const [error, setError] = useState<StellarSwapError>()

  const set = useCallback(
    <T>(setter: (v: T) => void, value: T) => {
      if (mounted.current) setter(value)
    },
    [mounted]
  )

  const swap = useCallback(
    async (params: ExecuteSwapParams): Promise<ExecutionResult | undefined> => {
      const { signer, track = true, ...commitParams } = params
      const controller = new AbortController()
      abortRef.current?.abort()
      abortRef.current = controller

      set(setError, undefined)
      set(setTrackStatus, undefined)
      set(setBrokerQuote, undefined)
      set(setBrokerProgress, undefined)
      set(setStatus, 'committing')

      try {
        const committed = await sdk.commit(commitParams)
        if (controller.signal.aborted) return undefined
        set(setRoute, committed)
        set(setStatus, 'executing')

        const result = await sdk.execute(committed, signer, {
          signal: controller.signal,
          callbacks: {
            onQuote: (q) => set(setBrokerQuote, q),
            onPhase: (p) => set(setBrokerPhase, p),
            onProgress: (pr) => set(setBrokerProgress, pr)
          }
        })
        if (controller.signal.aborted) return undefined
        set(setExecution, result)

        if (track && result.inboundTxHash) {
          set(setStatus, 'tracking')
          const t = await sdk.track(committed.uuid, result.inboundTxHash)
          if (!controller.signal.aborted) set(setTrackStatus, t)
        }

        set(setStatus, 'success')
        return result
      } catch (err) {
        if (controller.signal.aborted) return undefined
        set(setError, toStellarSwapError(err))
        set(setStatus, 'error')
        return undefined
      }
    },
    [sdk, set]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = undefined
    setStatus('idle')
    setRoute(undefined)
    setExecution(undefined)
    setTrackStatus(undefined)
    setBrokerQuote(undefined)
    setBrokerPhase(undefined)
    setBrokerProgress(undefined)
    setError(undefined)
  }, [])

  const isLoading = status === 'committing' || status === 'executing' || status === 'tracking'

  return {
    swap,
    cancel,
    reset,
    status,
    route,
    execution,
    trackStatus,
    brokerQuote,
    brokerPhase,
    brokerProgress,
    error,
    isLoading
  }
}
