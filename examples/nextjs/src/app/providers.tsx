'use client'

import { useMemo, type ReactNode } from 'react'
import { StellarSwapProvider } from 'stellar-web-sdk/react'
import type { StellarSwapConfig } from 'stellar-web-sdk'

/**
 * Client boundary that builds one SDK and shares it via context.
 *
 * DEMO ONLY: the uswap-server API key is read from a `NEXT_PUBLIC_` var, so it ships to the
 * browser. In production, keep the key server-side — point `apiBaseUrl` at a Next.js route
 * handler that injects `X-API-Key` and proxies to uswap-server.
 */
export function Providers({ children }: { children: ReactNode }) {
  const apiBaseUrl = process.env.NEXT_PUBLIC_USWAP_API_BASE_URL ?? ''
  const apiKey = process.env.NEXT_PUBLIC_USWAP_API_KEY ?? ''

  const config = useMemo<StellarSwapConfig | undefined>(
    () => (apiBaseUrl && apiKey ? { apiBaseUrl, apiKey } : undefined),
    [apiBaseUrl, apiKey]
  )

  // Building the SDK with an empty apiBaseUrl/apiKey throws (`apiBaseUrl is required`). Show a
  // setup notice instead of crashing the whole tree so the fix is obvious.
  if (!config) return <MissingEnvNotice apiBaseUrl={apiBaseUrl} apiKey={apiKey} />

  return <StellarSwapProvider config={config}>{children}</StellarSwapProvider>
}

function MissingEnvNotice({ apiBaseUrl, apiKey }: { apiBaseUrl: string; apiKey: string }) {
  return (
    <main>
      <h1>Setup needed</h1>
      <p className="lead">
        The SDK needs uswap-server credentials. Create <code>examples/nextjs/.env.local</code> (copy
        from <code>.env.local.example</code>) and set both values, then restart <code>npm run dev</code>
        — <code>NEXT_PUBLIC_*</code> vars are inlined at startup.
      </p>
      <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 8, fontSize: 13, overflowX: 'auto' }}>
{`NEXT_PUBLIC_USWAP_API_BASE_URL=https://swap-dev.unstoppable.money/api
NEXT_PUBLIC_USWAP_API_KEY=your-sdk-api-key`}
      </pre>
      <p className="note info">
        apiBaseUrl: {apiBaseUrl ? <code>{apiBaseUrl}</code> : <b>missing</b>} · apiKey:{' '}
        {apiKey ? 'set' : <b>missing</b>}
      </p>
    </main>
  )
}
