'use client'

import { useEffect, useRef } from 'react'
import { StellarSwapError } from '../core/errors.js'

/** Normalize anything thrown into a `StellarSwapError` so hook `error` state has one shape. */
export function toStellarSwapError(err: unknown): StellarSwapError {
  if (err instanceof StellarSwapError) return err
  if (err instanceof Error) {
    return new StellarSwapError('unknown', err.message, { cause: err })
  }
  return new StellarSwapError('unknown', String(err), { cause: err })
}

/**
 * A ref that is `true` only while the component is mounted. Guards `setState` after unmount and
 * lets each hook ignore results from a superseded request (compare a captured request id).
 */
export function useMountedRef() {
  const mounted = useRef(true)
  useEffect(() => {
    // Load-bearing despite the useRef(true) init: under React 18 StrictMode the effect is torn
    // down and re-run, so the cleanup sets false and this restores it on remount.
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}
