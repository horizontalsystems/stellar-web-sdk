'use client'

import { useCallback, useRef, useState } from 'react'
import { useStellarSwap } from './context.js'
import { toStellarSwapError, useMountedRef } from './internal.js'
import type { QuoteParams, QuoteResult } from '../StellarSwapSDK.js'
import type { StellarSwapError } from '../core/errors.js'

export interface UseQuoteResult {
  /** Price a swap. Returns the result, or `undefined` if the call errored or was superseded. */
  quote: (params: QuoteParams) => Promise<QuoteResult | undefined>
  /** The latest successful quote. */
  data?: QuoteResult
  error?: StellarSwapError
  isLoading: boolean
  /** Clear `data`/`error`/`isLoading`. */
  reset: () => void
}

/**
 * Imperative quoting with request state. Only the most recent `quote()` call updates state — a
 * slow earlier request that resolves late is dropped, so rapid re-quoting (e.g. on amount change)
 * never flashes a stale price.
 */
export function useQuote(): UseQuoteResult {
  const sdk = useStellarSwap()
  const mounted = useMountedRef()
  const requestId = useRef(0)
  const [data, setData] = useState<QuoteResult>()
  const [error, setError] = useState<StellarSwapError>()
  const [isLoading, setIsLoading] = useState(false)

  const quote = useCallback(
    async (params: QuoteParams): Promise<QuoteResult | undefined> => {
      const id = ++requestId.current
      setIsLoading(true)
      setError(undefined)
      try {
        const result = await sdk.quote(params)
        if (!mounted.current || id !== requestId.current) return undefined
        setData(result)
        setIsLoading(false)
        return result
      } catch (err) {
        if (!mounted.current || id !== requestId.current) return undefined
        setError(toStellarSwapError(err))
        setIsLoading(false)
        return undefined
      }
    },
    [sdk, mounted]
  )

  const reset = useCallback(() => {
    requestId.current++
    setData(undefined)
    setError(undefined)
    setIsLoading(false)
  }, [])

  return { quote, data, error, isLoading, reset }
}
