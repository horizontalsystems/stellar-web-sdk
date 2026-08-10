# Architecture — what runs where

This document answers one question precisely: **which components of the Stellar integration live in
this open repository, and which remain in the hosted `uswap-server`.**

Short answer: as of the client-side adapter port, every component involved in *discovering,
pricing, selecting and executing* a swap runs in this package and is readable here. The hosted
server retains only post-trade tracking, and is optional.

## The pipeline, component by component

| # | Component | Where it runs | Source |
|---|---|---|---|
| 1 | **Provider adapters** — one per venue | **This repo** | [`src/providers/*/index.ts`](src/providers) |
| 2 | **Quote fetching** — the upstream calls | **This repo** | each adapter + [`src/providers/http.ts`](src/providers/http.ts) |
| 3 | **Quote normalization** — venue response → canonical amounts, fees, floors | **This repo** | each adapter |
| 4 | **Route construction** — the `Route` + `execution` block | **This repo** | [`src/routing/route.ts`](src/routing/route.ts) |
| 5 | **Route discovery / provider fan-out** | **This repo** | [`registry.ts`](src/routing/registry.ts), [`fanout.ts`](src/routing/fanout.ts) |
| 6 | **Routing / solver logic** — the waterfall | **This repo** | [`src/core/waterfall.ts`](src/core/waterfall.ts) |
| 7 | **Developer-facing SDK** | **This repo** | [`src/StellarSwapSDK.ts`](src/StellarSwapSDK.ts), [`src/react`](src/react) |
| 8 | **Execution** — signing, submission, the broker session | **This repo** | [`src/execution`](src/execution) |
| 9 | **Swap tracking** — post-trade outcome reconciliation | Hosted `uswap-server` | `POST /v2/track` |

Components 1–8 have no dependency on `uswap-server`. Component 9 is the only one that does, and it
is optional — see [Tracking](#tracking-the-one-hosted-piece) below.

## The six provider adapters

Each is a plain `getQuote(request, context, signal) => Promise<Route>` function. All were ported
from `uswap-server/src/providers/`, keeping the venue-specific corrections that were learned in
production — those corrections are the substance of the integration, and they are documented inline
at the point where each applies.

| Provider | Upstream | Execution | Enforced floor | Notable adapter logic |
|---|---|---|---|---|
| **STELLARBROKER** | `GET /quote` (unauthenticated) | interactive WebSocket session | none — live re-quote in session | partner-key gate on commit; trader-only settlement |
| **SOROSWAP** | `POST /quote` + `/quote/build` (bearer key) | signed Stellar envelope | on-chain, clamped | `aqua` venue exclusion; price-impact gate; `otherAmountThreshold` clamp |
| **AQUARIUS** | `POST /find-path/` (public) | signed Soroban invoke | on-chain `out_min` | gross-vs-net fee math; mandatory simulation |
| **STELLAR_DEX** | Horizon `/paths/strict-send` | signed path payment | on-chain `destMin` | robustness-weighted path selection |
| **NEAR** | 1Click `/v0/quote` | deposit to address | contractual | catalog resolution; memo-mode deposits |
| **AXELAR_ITS** | Axelarscan GMP + chain RPC | signed Soroban invoke / EVM tx | 1:1, deterministic | static ITS catalog; dual chain-name encodings |

Three of these carry corrections that change which route wins, and are worth calling out because
they are the difference between an adapter and a proxy:

- **Soroswap's `aqua` exclusion.** Soroswap's Aquarius integration ignores `slippageBps` and routes
  through stale pools that quote far off market while reporting near-zero price impact. Excluding
  the venue loses nothing: the fan-out carries the direct Aquarius adapter, which prices the same
  liquidity honestly.
- **Soroswap's threshold clamp.** `otherAmountThreshold` comes back equal to `amountOut` on some
  routes — a floor with no buffer. Taken verbatim it would produce a transaction that reverts on any
  drift, and a `minBuyAmount` that reads as fully enforced when it is not.
- **STELLAR_DEX path selection.** Taking the highest-output path loses swaps: thin exotic hops
  outbid the direct order book at quote time and then evaporate before ledger inclusion. The
  adapter prefers the fewest-hop path within a tolerance of the best price.

## Routing modes

```ts
new StellarSwapSDK({ routing: 'local' })    // default — adapters in this package
new StellarSwapSDK({ routing: 'server', apiBaseUrl, apiKey })  // price via /v2 instead
```

`'local'` is the default and needs no server. Every upstream host serves CORS-enabled responses
(verified across all six), so it works in a browser as well as in Node.

`'server'` remains supported. It is the right choice when you want provider API keys kept off the
client entirely, or when you want the hosted deployment's fee configuration to apply.

Both modes produce the same `Route` shape and run the same waterfall, so switching between them
changes nothing downstream. See [`BENCHMARKS.md`](BENCHMARKS.md) for a measured pricing-parity
comparison between the two.

## Credentials in a browser

Two upstreams take a key: Soroswap (required) and 1Click (optional, for rate limits). A key placed
in a browser bundle is public by construction. The SDK does not pretend otherwise:

- **Server-side / trusted environments** — pass keys via `credentials`.
- **Public web apps** — leave `credentials` unset and point `config.fetch` at your own proxy, which
  attaches keys server-side. [`examples/nextjs`](examples/nextjs) demonstrates this.

Without a Soroswap key the adapter declines with a clear per-provider error and the other three
Stellar providers still serve the pair.

## Tracking: the one hosted piece

`POST /v2/track` reconciles a swap's outcome on Horizon after the fact. That is a server's job —
it means watching a chain over minutes, after the page that submitted the swap may be gone — and
this SDK does not replicate it. `sdk.track()` throws a clear configuration error when no server is
set.

Local routing is not blind without it. A `signed_transaction` route's outcome is known the moment
Horizon returns from the submit, because that call blocks until ledger inclusion — the result is on
`ExecutionResult.submit`. A StellarBroker session reports its own settled amounts. Only cross-chain
routes, whose far side settles minutes later, genuinely benefit from server-side tracking.

There is one known limitation, inherited and unchanged: StellarBroker splits large orders across
several transactions in a single ledger, and `/v2/track` accepts only one hash — so the tracked
amount for a split SB fill is a **lower bound**, not the full fill. The session result carries the
true totals.

## What was deliberately not ported

Three things in `uswap-server` sit next to the funded components but are not part of them. They are
hosting policy — none of them changes which route wins or what a route pays out:

- **Fee resolution from a database.** The server reads per-user fee rows and a register of verified
  fee wallets. Client-side this is plain configuration (`serviceFees`), defaulting to no fee. The
  fee *math* — each venue's mechanism, the gross/net split conventions — is ported in full.
- **Sanction haircuts, analytics rows, Prometheus counters, swap records, affiliate splits,
  provider suspension flags.** Operational concerns of running a hosted service.
- **Deposit transaction building for non-Stellar chains.** The server builds deposit transactions
  for the twenty-odd origin chains NEAR supports. That is wallet work on other chains, outside a
  Stellar SDK's remit; a committed NEAR route returns the full deposit instruction and the
  connected wallet sends it. Stellar-origin deposits *are* built here.

## Package dependencies

One runtime dependency: `@stellar/stellar-sdk`. React is an optional peer.

The server's provider layer uses `axios`, `viem`, `ethers`, `@defuse-protocol/one-click-sdk`,
`sequelize` and an internal `uswap` package. None were carried over — the adapters use `fetch`, the
1Click REST contract directly, and a [~60-line ABI encoder](src/providers/axelar/abi.ts) for the
single EVM call Axelar needs, asserted against a viem-generated reference vector in
[`test/routing.test.mjs`](test/routing.test.mjs).
