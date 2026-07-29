import { Swap } from '../components/Swap'

// Server Component: the SDK core is import-safe here (no browser globals at import time). The
// interactive part lives in <Swap>, which is a client component ('use client').
export default function SwapPage() {
  return (
    <main>
      <h1>Stellar swap</h1>
      <p className="lead">
        Prices across StellarBroker / Soroswap / Aquarius / Stellar DEX and executes the waterfall
        pick client-side. <b>Mainnet only</b> — a swap moves real funds. Use a dedicated,
        low-balance account; the secret key stays in your browser and is never sent to a server.
      </p>
      <Swap />
    </main>
  )
}
