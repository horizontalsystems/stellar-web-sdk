# stellar-web-sdk — Next.js example

A minimal App Router app that prices and executes a Stellar swap through the SDK's React hooks
(`stellar-web-sdk/react`).

## Run

```sh
# from the repo root — build the SDK incl. the React entry first
npm install
npm run build:all

cd examples/nextjs
npm install
npm run dev                        # http://localhost:3000
```

> `stellar-web-sdk` is linked via `file:../..`, so `npm run build:all` at the root must run first
> (it emits `dist/react`).

No configuration is required — the SDK needs no backend and quotes without any key. Optional
provider keys are read from the **repository-root `.env`** and mapped onto `NEXT_PUBLIC_*` in
`next.config.mjs`, so all three examples share one file. See `.env.local.example` for the
per-example alternative.

## Structure

```
src/
  app/
    layout.tsx      # imports globals.css, wraps children in <Providers>
    page.tsx        # Server Component — heading + <Swap/>
    providers.tsx   # 'use client' — builds one SDK, shares it via <StellarSwapProvider>
    globals.css
  components/
    Swap.tsx        # 'use client' — the swap panel (hooks + lifecycle)
    Note.tsx        # coloured status paragraph
  lib/
    assets.ts       # asset constants
```

## What it shows

`src/components/Swap.tsx` runs the full swap lifecycle:

1. `useQuote()` fans out to every eligible provider and picks the best `expectedBuyAmount`.
2. `sdk.checkTrustline()` / `sdk.activateTrustline()` gate the buy asset — buying a classic asset
   the trader doesn't yet trust fails on-chain, so an **Activate trustline** button appears when needed.
3. `useExecuteSwap()` runs commit → execute → track, surfacing live StellarBroker session state
   (`brokerPhase`, `brokerQuote`, progress).
4. `useTrackStatus()` polls the committed order to a terminal status.

`src/app/page.tsx` is a Server Component that just renders `<Swap/>` — the SDK core is import-safe in
Server Components (no browser globals at import time); only the provider and hooks are client-only,
which is why `providers.tsx` and `Swap.tsx` carry `'use client'`.

## Running a real swap

The SDK is **mainnet only** — StellarBroker has no testnet — so completing a swap moves real funds.
To exercise the Swap button end-to-end you need a funded Stellar mainnet account:

1. Optionally set provider keys (see above) and restart `npm run dev`.
2. Paste the **secret key** of a *dedicated, low-balance* account into the form. It's wrapped as a
   `keypairSigner` and stays in your browser — it is never sent to a server. (The SDK's `StellarSigner`
   is a raw ed25519 signer; browser wallet extensions like Freighter don't expose raw-hash signing, so
   they can't back it without adapter work — the secret-key signer is the intended client-side path.)
3. Quote → activate the trustline if prompted → Swap. The result panel shows the tracking hash and
   polls the status to completion.

Quoting works without a signer (a dry price check), so you can try the pricing with no key at all.

## Production note — keep provider keys server-side

This demo passes the keys in via `NEXT_PUBLIC_` vars, which ship to the browser. That is fine for a
local demo and wrong for production: a key in a bundle is public by construction.

For a real app, leave `credentials` unset and give the SDK a `fetch` that routes upstream calls
through a route handler which attaches the keys server-side:

```ts
// app/api/venue/[...path]/route.ts
export async function POST(req: Request, { params }: { params: { path: string[] } }) {
  return fetch(`https://api.soroswap.finance/${params.path.join('/')}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SOROSWAP_API_KEY!}`
    },
    body: await req.text()
  })
}
```

```ts
const config = {
  // no `credentials` in the browser bundle
  fetch: (url, init) => globalThis.fetch(rewriteToProxy(url), init)
}
```

StellarBroker sessions still run directly from the browser over WebSocket; only the REST calls go
through the proxy.
