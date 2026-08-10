# stellar-web-sdk

Web SDK for Stellar swaps against **uswap-server**. It aggregates six swap sources — four
Stellar-native providers plus **NEAR** and **Axelar ITS** for cross-chain routes — behind one API
and runs execution **client-side**:

| Provider | Execution | `minBuyAmount` | Third-party recipient |
|---|---|---|---|
| **STELLARBROKER** | interactive WebSocket session | `null` (no on-chain floor) | no |
| **SOROSWAP** | signed transaction | enforced | yes |
| **AQUARIUS** | signed transaction | enforced | no |
| **STELLAR_DEX** | signed transaction | enforced | yes |
| **NEAR** (cross-chain) | deposit to address | enforced | yes |
| **AXELAR_ITS** (cross-chain) | signed transaction | enforced (1:1 bridge) | yes |

**The SDK ships the provider adapters themselves.** Quote fetching, quote normalization, route
construction, route discovery, the provider fan-out and the routing solver all run in this package —
`src/providers/` holds one adapter per venue, `src/routing/` holds discovery and the fan-out, and
`src/core/waterfall.ts` holds the selection policy. The SDK talks to StellarBroker, Soroswap,
Aquarius, Horizon, 1Click and Axelar directly. No hosted service sits in the pricing path.

```ts
new StellarSwapSDK({ routing: 'local' })   // default — this package's adapters, no server needed
new StellarSwapSDK({ routing: 'server', apiBaseUrl, apiKey })   // price via uswap-server /v2 instead
```

Every upstream serves CORS-enabled responses, so local routing works in a browser as well as in
Node. Two upstreams take an API key (Soroswap; 1Click optionally) — pass them via `credentials`
server-side, or leave them unset and point `config.fetch` at your own proxy for a public web app.

Execution is client-side too:

- **Soroswap / Aquarius / Stellar DEX / Axelar ITS** — the SDK builds or receives the envelope,
  signs it, and submits it to Horizon itself.
- **StellarBroker** — the SDK talks to the broker directly, opening its own WebSocket to
  `wss://api.stellar.broker/ws` and running the trade. Because every StellarBroker transaction is
  built by the broker, the SDK runs a full signing-security pipeline (shape validation,
  cryptographic trader-signature detection, per-tx debit budget, classic fee-bumps, and Soroban
  two-phase auth-entry signing) before signing each one.
- **NEAR** — a deposit to an address; the SDK builds Stellar-origin deposits and returns the
  instruction for any other origin chain.

The one thing local routing does **not** replace is post-trade **tracking** (`/v2/track`), which
reconciles outcomes on Horizon after the fact. Configure `apiBaseUrl` + `apiKey` to use it in either
routing mode. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full component map of what runs
where, and [`BENCHMARKS.md`](BENCHMARKS.md) for measured routing performance and a pricing-parity
comparison against the hosted server.

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
  // routing: 'local' is the default — the SDK's own adapters price every route.
  credentials: {
    soroswapApiKey: process.env.SOROSWAP_API_KEY,               // required for Soroswap routes
    stellarBrokerPartnerKey: process.env.SB_PARTNER_KEY         // required to COMMIT an SB route
  },
  // Optional: a uswap-server for post-trade tracking (sdk.track()).
  apiBaseUrl: 'https://swap-dev.unstoppable.money/api',
  apiKey: process.env.USWAP_API_KEY,
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

## Route selection policy

`sdk.quote()` fans out across the eligible providers and then applies **two preference rules**.
Both deliberately override raw price, so both are stated here in full — see
[`src/core/waterfall.ts`](src/core/waterfall.ts) for the implementation.

### Rule 1 — the StellarBroker-first waterfall (`selectRoute`)

1. If a `STELLARBROKER` route exists → **pick it, even when a fallback quotes a higher
   `expectedBuyAmount`.**
2. Else → the fallback with the greatest `expectedBuyAmount`.
3. Nothing → no route.

**What this means in practice:** the SDK will select a StellarBroker route that shows a *lower*
number than a Soroswap, Aquarius or Stellar DEX route quoted at the same moment. The rationale is
that SB's figure is an estimate rather than an enforced floor — the broker re-quotes live during
the session, within the slippage tolerance — and in practice it settles above its estimate. This
is the reason `minBuyAmount` is `null` on every StellarBroker route: there is no on-chain floor to
promise, whereas every other Stellar provider's floor is enforced by the transaction itself.

That trade — a possibly-lower shown number against no enforced minimum — is a policy choice, not
an optimization. If it is not the trade you want, `selectRoute` and `bestByExpected` are both
exported, and `quote()` returns every route in `allRoutes`, so you can rank them yourself:

```ts
import { bestByExpected } from 'stellar-web-sdk'
const q = await sdk.quote({ … })
const bestPriced = bestByExpected(q.allRoutes)   // ignore the SB preference entirely
```

### Rule 2 — Stellar in-chain over cross-chain (`selectUnifiedRoute`)

When a pair can be served both in-chain and cross-chain, **any Stellar in-chain route wins over any
cross-chain route, regardless of quoted output.** Rule 1 then picks among the Stellar routes. Only
when no Stellar provider can serve the pair does the best cross-chain route win.

The rationale is settlement, not price: an in-chain swap settles in one ledger (~5s) with an
enforced floor, while a cross-chain route settles in minutes across a bridge with its own failure
and refund modes.

### Recipient restriction

If `destinationAddress` differs from `sourceAddress`, discovery automatically restricts the fan-out
to the recipient-capable providers (`SOROSWAP`, `STELLAR_DEX`). STELLARBROKER and AQUARIUS settle on
the trader's own account and cannot pay a third party at all — this is a hard capability limit, not
a preference.

## Unified routing (Stellar in-chain + cross-chain NEAR)

`quote()`/`commit()`/`execute()` handle every path in one flow, routed **automatically from the
assets**:

- **Stellar-native** pair (both assets Stellar) → the four Stellar in-chain providers (SB-first waterfall).
- **Axelar ITS** pair — the same token bridged Stellar ↔ Ethereum (`XLM.XLM`↔`ETH.XLM-0x…`, `SHX`↔`SHX`)
  → the **AXELAR_ITS** provider (a signed Stellar tx, so the normal `execute()` signs & submits it).
- any other **cross-chain** pair → the **NEAR** provider (1Click), deposit-to-address.

You don't choose up front — read `QuoteResult.crossChain`. Cross-chain assets are `CHAIN.TICKER-ADDRESS`
identifiers from each provider's catalog (`crossChainTokens('NEAR' | 'AXELAR_ITS')`).

```ts
// (optional) discover cross-chain assets — never hand-build identifiers.
const tokens = await sdk.crossChainTokens('NEAR')   // [{ identifier: 'ETH.ETH', decimals: 18, … }]

// 1) One quote — auto-routes. `sellAsset`/`buyAsset` are Stellar (XLM.XLM) or cross-chain (ETH.USDC-0x…).
const q = await sdk.quote({
  sellAsset: 'XLM.XLM',
  buyAsset: 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', // cross-chain here → NEAR
  sellAmount: '500',
  slippage: 1,                        // PERCENT
  sourceAddress: 'GTRADER…',
  destinationAddress: '0x…',          // destination-chain address (cross-chain / third-party)
})
q.crossChain   // true → routed via NEAR; false → Stellar in-chain

// 2) Commit the picked provider (refundAddress defaults to sourceAddress for cross-chain).
const route = await sdk.commit({ ...quoteParams, provider: q.provider! })

// 3) Execute — dispatches on execution.method. Stellar origin + signer signs & submits the deposit;
//    any other origin returns the deposit instruction to send yourself.
const exec = await sdk.execute(route, signer)
if (exec.method === 'transfer' && !exec.submitted) {
  // exec.deposit = { chain, depositAddress, amount, asset, attachment: { type, value } }
  // send it from your wallet, then sdk.track(route.uuid, hash)
} else {
  await sdk.track(route.uuid, exec.inboundTxHash)   // then pollTrack to completion
}
```

Cross-chain routes carry `execution.method === 'transfer'` (see `TransferExecution`). `crossChainTokens()`
lists cross-chain assets and `depositFor(route)` returns the deposit without submitting.

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

- `new StellarSwapSDK(config)` — `routing` (`'local'` default / `'server'`), `credentials`,
  `endpoints`, `tunables`, `serviceFees`, optional `apiBaseUrl` + `apiKey` (required for
  `'server'` routing and for tracking), `horizonUrl`, `networkPassphrase`, `brokerWsUrl`, `fetch`,
  `WebSocket`, `requestTimeoutMs`.
- `quote(params)` → `{ route?, provider?, crossChain, allRoutes, providerErrors, timings }`
- `crossChainTokens(provider?)` → the cross-chain asset catalog (`'NEAR'` default, or `'AXELAR_ITS'`)
- `checkTrustline(recipient, buyAsset)` / `activateTrustline(signer, asset, limit?)`
- `commit(params)` → `CommittedRoute` (has `execution` + `uuid`)
- `previewSignedTransaction(route)` → fee + enforced minimum for a confirm screen
- `execute(route, signer?, opts?)` → `ExecutionResult` (signer optional only for a non-Stellar-origin
  cross-chain route, which returns `result.deposit` instead of submitting)
- `depositFor(route)` → the cross-chain deposit instruction without submitting
- `executeAndTrack(route, signer, opts?)` → `{ execution, track? }`
- `track(uuid, inboundTxHash?)` / `pollTrack(uuid, inboundTxHash, opts?)`

The routing stack is exported piece by piece, so each component can be inspected, tested or
replaced without going through the SDK facade:

- **Adapters** — `quoteStellarBroker`, `quoteSoroswap`, `quoteAquarius`, `quoteStellarDex`,
  `quoteNear`, `quoteAxelar`. Each is `(request, context, signal) => Promise<Route>`.
- **Discovery** — `discoverProviders`, `PROVIDER_REGISTRY`, `providerByName`, `isAxelarPair`
- **Fan-out** — `runFanout`, `toProviderError`, `LocalRouter`
- **Route construction** — `makeRoute`, `makeSignedTxExecution`, `makeStellarBrokerExecution`,
  `makeTransferExecution`
- **Solver** — `selectRoute`, `selectUnifiedRoute`, `bestByExpected`, `providersForRecipient`
- **Adapter internals** — `pickBestPath` (STELLAR_DEX path robustness), `stellarPreflight`,
  `encodeInterchainTransfer`, `findAxelarEntry`, `fetchNearTokens`

Plus the execution and utility building blocks: `UswapClient`, `TrustlineManager`, `HorizonClient`,
`SignedTransactionExecutor`, `TransferExecutor`, `StellarBrokerSession`, `SigningPipeline`, and all
asset/amount utilities.

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
    waterfall.ts        route selection policy (SB-first + in-chain preference)
  providers/            THE PROVIDER ADAPTERS — quote fetching + normalization
    types.ts            adapter contract, error codes, context, tunables
    http.ts             the one fetch path every adapter uses
    stellarbroker/      SB REST quote → session parameters
    soroswap/           aggregator quote + build → signed envelope
    aquarius/           AMM find-path → Soroban swap_chained invoke
    stellardex/         Horizon path-finding → pathPaymentStrictSend
    near/               1Click quote + asset catalog → deposit instruction
    axelar/             ITS catalog, GMP fee, Soroban/EVM transfer + ABI encoder
  routing/              route discovery, fan-out, construction
    registry.ts         provider table + pair classification (discovery)
    fanout.ts           parallel fan-out with two-level time budgets
    route.ts            Route + execution-block construction
    LocalRouter.ts      discovery → fan-out → solver, assembled
  client/
    UswapClient.ts      typed REST wrapper for /v2 (routing: 'server' + tracking)
  stellar/              on-chain interaction
    horizon.ts          Horizon submit, account reads, path-finding
    trustline.ts        trustline detection + changeTrust
    preflight.ts        committed-quote account/trustline pre-flight
  execution/            client-native execution engines
    signedTransaction.ts        sign + submit a server-built envelope
    stellarBroker/
      messages.ts               WebSocket protocol message shapes
      SigningPipeline.ts        the security pipeline (shape/debit/2-phase signing)
      StellarBrokerSession.ts   session driver (connect → quote → trade → settle)

bench/      routing performance harness (bench/routing.mjs)
examples/   runnable vanilla / React / Next.js apps
test/       dependency-free test suite (test/*.test.mjs)
```

## Development

```sh
npm install
npm run build      # tsc → dist/
npm test           # builds, then runs the dependency-free test suite (test/*.test.mjs)
npm run typecheck
npm run bench      # routing performance benchmark against live venues
```

The tests are offline and dependency-free. They exercise the security pipeline against real XDR
(classic swap-leg fee-bumps, the Soroban two-phase flow, debit-budget and shape rejections, and the
full WebSocket session against a mock broker), and the routing layer against stub adapters — route
discovery and its recipient restrictions, the fan-out's time budgets and error normalization, both
selection rules, STELLAR_DEX path robustness, amount math, and the Axelar ABI encoding against a
viem-generated reference vector.
