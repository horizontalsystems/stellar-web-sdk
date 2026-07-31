import { Swap } from '../components/Swap'

// Server Component: the SDK core is import-safe here (no browser globals at import time). The
// interactive part lives in <Swap> ('use client') — one quote auto-routes in-chain vs cross-chain.
export default function SwapPage() {
  return (
    <main>
      <h1>Stellar swap</h1>
      <p className="lead">
        One quote routes automatically — Stellar in-chain (StellarBroker / Soroswap / Aquarius /
        Stellar DEX) when it can serve the pair, else cross-chain. <b>Mainnet only</b> — a
        swap moves real funds. Use a dedicated, low-balance account; the secret key stays in your browser.
      </p>
      <Swap />
    </main>
  )
}
