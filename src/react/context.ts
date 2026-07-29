'use client'

import { createContext, createElement, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { StellarSwapSDK } from '../StellarSwapSDK.js'
import type { StellarSwapConfig } from '../core/config.js'
import { StellarSwapError } from '../core/errors.js'

const StellarSwapContext = createContext<StellarSwapSDK | null>(null)

export interface StellarSwapProviderProps {
  children: ReactNode
  /** A ready-made SDK instance. Takes precedence over `config`. */
  sdk?: StellarSwapSDK
  /**
   * Config to build the SDK from. Pass a STABLE reference (module const or `useMemo`) — a new
   * object literal every render rebuilds the SDK each render. Prefer `sdk` if you already hold one.
   */
  config?: StellarSwapConfig
}

/**
 * Makes one `StellarSwapSDK` available to the hooks below. Client-only (`'use client'`): the SDK
 * holds live `fetch`/`WebSocket` handles, so mount it under a client boundary in the Next.js App
 * Router. Give it either a prebuilt `sdk` or a stable `config`.
 */
export function StellarSwapProvider({ children, sdk, config }: StellarSwapProviderProps) {
  const value = useMemo(() => {
    if (sdk) return sdk
    if (config) return new StellarSwapSDK(config)
    throw new StellarSwapError('invalid_config', '<StellarSwapProvider> needs either `sdk` or `config`')
  }, [sdk, config])

  return createElement(StellarSwapContext.Provider, { value }, children)
}

/** Read the SDK from context. Throws if called outside a `<StellarSwapProvider>`. */
export function useStellarSwap(): StellarSwapSDK {
  const sdk = useContext(StellarSwapContext)
  if (!sdk) {
    throw new StellarSwapError('invalid_config', 'useStellarSwap must be used within <StellarSwapProvider>')
  }
  return sdk
}
