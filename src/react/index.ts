'use client'

/**
 * React bindings for stellar-web-sdk — `stellar-web-sdk/react`.
 *
 * A `<StellarSwapProvider>` that holds one SDK instance, plus hooks for the swap lifecycle
 * (quote → commit/execute → track). Client-only: mount the provider under a `'use client'`
 * boundary in the Next.js App Router. `react` is an optional peer dependency.
 */

export { StellarSwapProvider, useStellarSwap } from './context.js'
export type { StellarSwapProviderProps } from './context.js'

export { useQuote } from './useQuote.js'
export type { UseQuoteResult } from './useQuote.js'

export { useExecuteSwap } from './useExecuteSwap.js'
export type {
  UseExecuteSwapResult,
  ExecuteSwapParams,
  SwapStatus
} from './useExecuteSwap.js'

export { useTrackStatus } from './useTrackStatus.js'
export type { UseTrackStatusOptions, UseTrackStatusResult } from './useTrackStatus.js'
