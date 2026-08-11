import { useMemo, useState } from 'react'
import { createSdk, envStatus } from './lib/sdk.js'
import { StellarSwapProvider } from 'stellar-web-sdk/react'
import { Swap } from './components/Swap.jsx'

export function App() {
  const [soroswapApiKey, setSoroswapApiKey] = useState('')
  const [brokerPartnerKey, setBrokerPartnerKey] = useState('')

  // The SDK needs no backend, so it is always constructible. Both keys below belong to the
  // upstream venues, and both are optional: without the Soroswap key that one provider declines
  // and the rest still serve the pair; the broker key is only needed to commit a session.
  const sdk = useMemo(
    () => createSdk({ soroswapApiKey, stellarBrokerPartnerKey: brokerPartnerKey }),
    [soroswapApiKey, brokerPartnerKey]
  )

  return (
    <main>
      <h1>Stellar swap</h1>
      <p className="lead">
        React hooks (<code>stellar-web-sdk/react</code>) on a plain esbuild bundle. <b>Mainnet only</b> —
        a swap moves real funds. Use a dedicated, low-balance account; the secret key stays in your browser.
      </p>

      <fieldset>
        <p className="note info">
          From the repo-root <code>.env</code>: soroswap key <b>{envStatus.soroswap ? 'set' : 'not set'}</b> ·
          broker partner key <b>{envStatus.broker ? 'set' : 'not set'}</b> · RPC <b>{envStatus.rpc}</b>.
          The fields below override them.
        </p>
        <label>
          Soroswap API key (optional)
          <input type="password" placeholder="sk_… — without it Soroswap declines" value={soroswapApiKey} onChange={(e) => setSoroswapApiKey(e.target.value)} />
        </label>
        <label>
          StellarBroker partner key (optional — needed to commit an SB route)
          <input type="password" placeholder="partner key" value={brokerPartnerKey} onChange={(e) => setBrokerPartnerKey(e.target.value)} />
        </label>
      </fieldset>

      <StellarSwapProvider sdk={sdk}>
        <Swap />
      </StellarSwapProvider>
    </main>
  )
}
