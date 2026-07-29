# stellar-web-sdk

Web SDK for Stellar swaps against **uswap-server**. It aggregates the four Stellar-native swap
sources behind one API and runs execution **client-side**:

| Provider | Execution | `minBuyAmount` | Third-party recipient |
|---|---|---|---|
| **STELLARBROKER** | interactive WebSocket session | `null` (no on-chain floor) | no |
| **SOROSWAP** | signed transaction | enforced | yes |
| **AQUARIUS** | signed transaction | enforced | no |
| **STELLAR_DEX** | signed transaction | enforced | yes |

The SDK implements the **StellarBroker-first waterfall**. Pricing, committing, and tracking go
through uswap-server (`/v2/rate`, `/v2/swap`, `/v2/track`), but **execution is client-side and does
not always go through the server**:

- **Soroswap / Aquarius / Stellar DEX** — the SDK signs the server-built envelope and submits it to
  Horizon itself.
- **StellarBroker** — the SDK talks to the broker **directly**. `/v2/swap` only hands back the
  session parameters (assets, amount, slippage, partner key); the SDK then opens its own WebSocket to
  `wss://api.stellar.broker/ws` and runs the trade — uswap-server never proxies the session. (SB's
  REST quote endpoint is likewise public/unauthenticated; the SDK still sources quotes through
  `/v2/rate` so all four providers compare under one waterfall.)

Every StellarBroker transaction is built by the broker, so the SDK runs a full signing-security
pipeline (shape validation, cryptographic trader-signature detection, per-tx debit budget, classic
fee-bumps, and Soroban two-phase auth-entry signing) before signing each one.

It mirrors the finished iOS reference implementation and the contract in
[`docs/STELLAR_WEB_SDK_GUIDE.md`](docs/STELLAR_WEB_SDK_GUIDE.md) and `uswap-server/API.md`.

## Install

```sh
npm install stellar-web-sdk @stellar/stellar-sdk
```

Runtime requirements: `fetch` (Node 18+/browser) and, for StellarBroker sessions, `WebSocket`
(Node 22+/browser). Both can be injected via config for older runtimes.

## Quick start

```ts
import { StellarSwapSDK, keypairSigner } from 'stellar-web-sdk'

const sdk = new StellarSwapSDK({
  apiBaseUrl: 'https://swap-dev.unstoppable.money/api', // uswap-server base (parent of /v2)
  apiKey: process.env.USWAP_API_KEY!,                    // SDK-specific key — ask esen
  // horizonUrl defaults to https://horizon.stellar.org; networkPassphrase defaults to PUBLIC
})

const trader = 'GTRADER…'
const signer = keypairSigner(process.env.STELLAR_SECRET!) // or your own StellarSigner (see below)

// 1) Quote — fans out to the right providers and applies the SB-first waterfall.
const quote = await sdk.quote({
  sellAsset: 'XLM.XLM',
  buyAsset: 'XLM.USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  sellAmount: '100',
  slippage: 1,           // PERCENT (1 = 1%)
  sourceAddress: trader, // destination defaults to source
})
if (!quote.route) throw new Error('no route')

// 2) Trustline gate — buying a classic asset the recipient doesn't trust is rejected on-chain.
const trust = await sdk.checkTrustline(trader, quote.route.buyAsset)
if (trust.required) {
  await sdk.activateTrustline(signer, quote.route.buyAsset) // submits a changeTrust, then re-quote
}

// 3) Commit against the picked provider (creates the order + returns execution + uuid).
const route = await sdk.commit({
  sellAsset: 'XLM.XLM',
  buyAsset: quote.route.buyAsset,
  sellAmount: '100',
  slippage: 1,
  sourceAddress: trader,
  provider: quote.provider!, // carry the waterfall's pick so price matches
})

// 4) Execute (dispatches on execution.method) and track — one call.
const { execution, track } = await sdk.executeAndTrack(route, signer, {
  callbacks: {
    onQuote: (q) => console.log('live SB quote', q.estimatedBuyingAmount),
    onProgress: (p) => console.log('progress', p),
  },
})
console.log('tracking hash', execution.inboundTxHash, 'status', track?.status)

// 5) Poll to completion.
const final = await sdk.pollTrack(route.uuid, execution.inboundTxHash, {
  onUpdate: (s) => console.log(s.status),
})
```

## React & Next.js

React bindings live at the `stellar-web-sdk/react` entry point (`react >= 18` is an optional peer
dependency). Everything there is `'use client'` — the SDK holds live `fetch`/`WebSocket` handles, so
mount it under a client boundary. The **core** entry (`stellar-web-sdk`) touches no browser globals at
import time, so it's safe to import in React Server Components / the Next.js App Router.

Wrap your tree once, then drive the lifecycle with hooks:

```tsx
'use client'
import { StellarSwapProvider, useQuote, useExecuteSwap } from 'stellar-web-sdk/react'
import { keypairSigner } from 'stellar-web-sdk'

// Give the provider a STABLE config (module const / useMemo) or a prebuilt `sdk` instance.
const config = { apiBaseUrl: '/api/uswap', apiKey: '…' }

function App() {
  return (
    <StellarSwapProvider config={config}>
      <Swap />
    </StellarSwapProvider>
  )
}

function Swap() {
  const q = useQuote()                 // { quote, data, error, isLoading, reset }
  const swap = useExecuteSwap()        // commit → execute → track, + live broker state

  return (
    <>
      <button onClick={() => q.quote({ sellAsset: 'native', buyAsset: 'USDC:GA5Z…', sellAmount: '10', slippage: 1, sourceAddress: 'GTRADER…' })}>
        Quote
      </button>
      <button
        disabled={!q.data?.provider || swap.isLoading}
        onClick={() => swap.swap({
          sellAsset: 'native', buyAsset: 'USDC:GA5Z…', sellAmount: '10', slippage: 1,
          sourceAddress: 'GTRADER…', provider: q.data!.provider!, signer: keypairSigner('S…'),
        })}
      >
        {swap.isLoading ? swap.status : 'Swap'}
      </button>
      {/* broker routes stream live state: swap.brokerPhase / swap.brokerQuote / swap.brokerProgress */}
    </>
  )
}
```

Hooks: `useStellarSwap()` (the SDK from context), `useQuote()`, `useExecuteSwap()`, and
`useTrackStatus(uuid, hash?, opts?)` for standalone polling. `useQuote`/`useExecuteSwap` drop
superseded/aborted results, so rapid re-quoting never flashes a stale price.

> **Keep your API key server-side.** A `NEXT_PUBLIC_` key ships to the browser. In production point
> `apiBaseUrl` at a Next.js route handler that injects `X-API-Key` and proxies uswap-server (StellarBroker
> WebSocket sessions still run directly from the browser). A runnable App Router example — including that
> proxy pattern — is in [`examples/nextjs`](examples/nextjs).

Build the React entry with `npm run build:all` (or `build:react`); the default `npm run build` only
emits the framework-agnostic core, so it stays green without React installed.

Runnable examples of the full swap flow live in [`examples/`](examples): **vanilla JS** (core SDK,
no framework), **React** (these hooks on a plain esbuild bundle), and **Next.js** (App Router,
including the key-proxy pattern).

## The waterfall (client policy)

`sdk.quote()` implements the policy from the guide exactly:

1. `/v2/rate` across the eligible providers.
2. If a `STELLARBROKER` route exists → pick it, **even when a fallback shows a higher number**
   (SB's number is an estimate and it usually wins after execution — the grant's agreed policy).
3. Else → the fallback with the greatest `expectedBuyAmount`.
4. Nothing → no route.

If `destinationAddress` differs from `sourceAddress`, the fan-out is automatically restricted to the
recipient-capable providers (`SOROSWAP`, `STELLAR_DEX`) — SB and AQUARIUS settle on the trader's own
account.

## Signing — the `StellarSigner` interface

Key custody stays with the caller. The SDK only ever asks for a **raw ed25519 signature over
specific bytes**, which is enough to implement classic fee-bumps and Soroban two-phase auth signing:

```ts
export interface StellarSigner {
  readonly publicKey: string                              // G…
  sign(data: Uint8Array): Promise<Uint8Array> | Uint8Array // raw ed25519 signature (64 bytes)
}
```

`keypairSigner(secret)` wraps an in-memory `S…` seed. For a browser wallet or hardware device,
implement the two members with your device's raw-signing primitive.

## StellarBroker session safety

Execution is a **direct** connection: from the committed route's session parameters the SDK opens
`wss://api.stellar.broker/ws?partner=<key>` and drives the trade against the broker itself
(uswap-server is not in this path). The broker builds every transaction and submits it — the client
only signs. Because the SDK is signing broker-authored transactions over a direct link, the signing
pipeline (`SigningPipeline`) is the client's only defense; it runs on **every** `tx` message, in
order:

1. **Shape** — each op is an `InvokeHostFunction` or a path payment that pays the trader (swap leg)
   or a trader/unset-sourced strict-send fee leg. Anything else is refused.
2. **Trader-signature detection** — a tx already carrying the trader's signature is the Soroban
   fee-bump round-trip. Detected by **cryptographic verification**, never by the 4-byte hint or
   signature-presence (SB's channel accounts pre-sign classic txs).
3. **Per-tx debit budget** — worst-case trader spend in the **selling asset** must be
   `≤ sellingAmount × 1.02`, and at most **5 distinct debiting txs** per session. This is per-tx +
   tx-count only, **never cumulative** — SB rebuilds retries on different channel accounts, so a
   cumulative ceiling would kill legitimate retries.
4. **Sign** — classic: fee-bump with `feeSource = trader`; Soroban first pass: sign each auth entry
   (`signatureExpirationLedger = maxLedger + 1`) + the inner tx, no fee-bump (the server round-trips
   it); Soroban second pass: only wrap + sign the fee-bump.

On any failure **after** a signature, the session still returns the last signed fee-bump hash so the
swap can be tracked — a partial fill may already have moved value. `executeAndTrack` reports it
before rethrowing.

## API surface

- `new StellarSwapSDK(config)` — `apiBaseUrl`, `apiKey`, optional `horizonUrl`, `networkPassphrase`,
  `brokerWsUrl`, `fetch`, `WebSocket`, `requestTimeoutMs`.
- `quote(params)` → `{ route?, provider?, allRoutes, providerErrors }`
- `checkTrustline(recipient, buyAsset)` / `activateTrustline(signer, asset, limit?)`
- `commit(params)` → `CommittedRoute` (has `execution` + `uuid`)
- `previewSignedTransaction(route)` → fee + enforced minimum for a confirm screen
- `execute(route, signer, opts?)` → `ExecutionResult`
- `executeAndTrack(route, signer, opts?)` → `{ execution, track? }`
- `track(uuid, inboundTxHash?)` / `pollTrack(uuid, inboundTxHash, opts?)`

Advanced building blocks are also exported: `UswapClient`, `TrustlineManager`, `HorizonClient`,
`SignedTransactionExecutor`, `StellarBrokerSession`, `SigningPipeline`, the waterfall helpers, and
all asset/amount utilities.

## Gotchas honored by this SDK

- `wss://` is required explicitly for the broker (browsers auto-upgrade `https://` WS URLs; nothing
  else does).
- Every `ping` is answered with `pong{uid}`, including while waiting for `connected`/`quote`.
- Asset codes are **case-sensitive** end to end — never normalized.
- `/v2` `slippage` is a **percent**; the broker's `slippageTolerance` is a **fraction** — the
  server-provided execution params are used verbatim, never converted.
- Amounts are truncated (not rounded) to the 7-dp stroop grid.
- `destinationAddress` is sent to `/v2/swap` even when it equals the source.

## Project structure

```
src/
  index.ts              public entry — re-exports the SDK surface
  StellarSwapSDK.ts     top-level orchestrator (quote → commit → execute → track)
  core/                 dependency-light primitives
    types.ts            wire types for the /v2 contract
    errors.ts           StellarSwapError + error codes
    config.ts           config resolution / defaults
    amounts.ts          stroop math (7-dp truncation)
    assets.ts           asset parsing, SB/Horizon forms, SAC derivation
    signer.ts           StellarSigner interface + keypair signer + sig helpers
    waterfall.ts        SB-first route selection policy
  client/
    UswapClient.ts      typed REST wrapper for /v2/rate, /v2/swap, /v2/track, …
  stellar/              on-chain interaction
    horizon.ts          Horizon submit + account reads
    trustline.ts        trustline detection + changeTrust
  execution/            client-native execution engines
    signedTransaction.ts        sign + submit a server-built envelope
    stellarBroker/
      messages.ts               WebSocket protocol message shapes
      SigningPipeline.ts        the security pipeline (shape/debit/2-phase signing)
      StellarBrokerSession.ts   session driver (connect → quote → trade → settle)

docs/    reference: STELLAR_WEB_SDK_GUIDE.md, STELLAR_SWAP_KIT.md, provider API docs
demo/    browser test harness (see demo/README.md)
test/    dependency-free test suite (test/*.test.mjs)
```

## Development

```sh
npm install
npm run build      # tsc → dist/
npm test           # builds, then runs the dependency-free test suite (test/*.test.mjs)
npm run typecheck
npm run demo       # build + serve the browser demo (see demo/README.md)
```

The tests exercise the security pipeline against real XDR: classic swap-leg fee-bumps, the Soroban
two-phase flow, debit-budget and shape rejections, and the full WebSocket session against a mock
broker.
