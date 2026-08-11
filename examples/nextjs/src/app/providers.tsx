'use client'

import { useMemo, type ReactNode } from 'react'
import { StellarSwapProvider } from 'stellar-web-sdk/react'
import type { StellarSwapConfig } from 'stellar-web-sdk'

/**
 * Client boundary that builds one SDK and shares it via context.
 *
 * The SDK needs no backend and no configuration to start — it talks to the swap providers
 * directly. The only optional credentials are the upstream venues' own: Soroswap requires a key
 * (without one it declines and the other three Stellar providers still serve the pair), and
 * StellarBroker needs a partner key to commit a session.
 *
 * Credentials come from the repository-root `.env`, mapped onto `NEXT_PUBLIC_*` in
 * `next.config.mjs` so all three examples share one file.
 *
 * DEMO ONLY: `NEXT_PUBLIC_` vars ship to the browser. In production,
 * leave `credentials` unset and pass a `fetch` that routes the provider calls through a Next.js
 * route handler which attaches the keys server-side.
 */
export function Providers({ children }: { children: ReactNode }) {
  const soroswapApiKey = process.env.NEXT_PUBLIC_SOROSWAP_API_KEY ?? ''
  const stellarBrokerPartnerKey = process.env.NEXT_PUBLIC_STELLARBROKER_PARTNER_KEY ?? ''
  const nearApiJwt = process.env.NEXT_PUBLIC_NEAR_API_JWT ?? ''
  const validationCloudApiKey = process.env.NEXT_PUBLIC_VALIDATION_CLOUD_API_KEY ?? ''
  const validationCloudHost = process.env.NEXT_PUBLIC_VALIDATION_CLOUD_HOST ?? ''

  const config = useMemo<StellarSwapConfig>(
    () => ({
      credentials: {
        ...(soroswapApiKey ? { soroswapApiKey } : {}),
        ...(stellarBrokerPartnerKey ? { stellarBrokerPartnerKey } : {}),
        ...(nearApiJwt ? { nearApiJwt } : {})
      },
      // One key, resolved by the SDK into both the Horizon and Soroban RPC endpoints.
      ...(validationCloudApiKey
        ? {
            validationCloud: {
              apiKey: validationCloudApiKey,
              ...(validationCloudHost ? { host: validationCloudHost } : {})
            }
          }
        : {})
    }),
    [soroswapApiKey, stellarBrokerPartnerKey, nearApiJwt, validationCloudApiKey, validationCloudHost]
  )

  return <StellarSwapProvider config={config}>{children}</StellarSwapProvider>
}
