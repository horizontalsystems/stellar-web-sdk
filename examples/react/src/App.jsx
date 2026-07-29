import { useMemo, useState } from 'react'
import { StellarSwapSDK } from 'stellar-web-sdk'
import { StellarSwapProvider } from 'stellar-web-sdk/react'
import { Swap } from './components/Swap.jsx'
import { Note } from './components/Note.jsx'
import { DEFAULT_API_BASE_URL } from './lib/constants.js'

export function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL)
  const [apiKey, setApiKey] = useState('')

  // Build one SDK once both credentials are present; pass the instance straight to the provider.
  const sdk = useMemo(
    () => (apiBaseUrl && apiKey ? new StellarSwapSDK({ apiBaseUrl, apiKey }) : null),
    [apiBaseUrl, apiKey]
  )

  return (
    <main>
      <h1>Stellar swap</h1>
      <p className="lead">
        React hooks (<code>stellar-web-sdk/react</code>) on a plain esbuild bundle. <b>Mainnet only</b> —
        a swap moves real funds. Use a dedicated, low-balance account; the secret key stays in your browser.
      </p>

      <fieldset>
        <label>
          API base URL
          <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} />
        </label>
        <label>
          API key (X-API-Key)
          <input type="password" placeholder="your SDK key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
      </fieldset>

      {sdk ? (
        <StellarSwapProvider sdk={sdk}>
          <Swap />
        </StellarSwapProvider>
      ) : (
        <Note kind="info">Enter an API key to begin.</Note>
      )}
    </main>
  )
}
