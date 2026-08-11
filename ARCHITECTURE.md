# Architecture — what runs where

This document answers one question precisely: **which components of the Stellar integration live in
this open repository.**

Short answer: **all of them.** Every component involved in discovering, pricing, selecting,
executing and tracking a swap runs in this package and is readable here. The SDK talks to the swap
providers directly and has no backend of any kind.

## The pipeline, component by component

| # | Component | Where it runs | Source |
|---|---|---|---|
| 1 | **Provider adapters** — one per venue | **This repo** | [`src/providers/*/index.ts`](src/providers) |
| 2 | **Quote fetching** — the upstream calls | **This repo** | each adapter + [`src/providers/http.ts`](src/providers/http.ts) |
| 3 | **Quote normalization** — venue response → canonical amounts, fees, floors | **This repo** | each adapter |
| 4 | **Route construction** — the `Route` + `execution` block | **This repo** | [`src/routing/route.ts`](src/routing/route.ts) |
| 5 | **Route discovery / provider fan-out** | **This repo** | [`registry.ts`](src/routing/registry.ts), [`fanout.ts`](src/routing/fanout.ts) |
| 6 | **Routing / solver logic** — route selection | **This repo** | [`src/core/selection.ts`](src/core/selection.ts) |
| 7 | **Developer-facing SDK** | **This repo** | [`src/StellarSwapSDK.ts`](src/StellarSwapSDK.ts), [`src/react`](src/react) |
| 8 | **Execution** — signing, submission, the broker session | **This repo** | [`src/execution`](src/execution) |
| 9 | **Outcome tracking** — settled amounts, read from the chain | **This repo** | [`src/tracking`](src/tracking) |

Nothing in this pipeline depends on a hosted service.

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

## Construction

```ts
const sdk = new StellarSwapSDK()   // no arguments required
```

Every upstream host serves CORS-enabled responses (verified across all six), so the whole stack runs
in a browser as well as in Node.

## Credentials in a browser

Two upstreams take a key: Soroswap (required) and 1Click (optional, for rate limits). A key placed
in a browser bundle is public by construction. The SDK does not pretend otherwise:

- **Server-side / trusted environments** — pass keys via `credentials`.
- **Public web apps** — leave `credentials` unset and point `config.fetch` at your own proxy, which
  attaches keys server-side. [`examples/nextjs`](examples/nextjs) demonstrates this.

Without a Soroswap key the adapter declines with a clear per-provider error and the other three
Stellar providers still serve the pair.

## Tracking

Each provider is followed wherever its truth actually lives:

| Provider | Followed via | Keyed by |
|---|---|---|
| STELLARBROKER / SOROSWAP / AQUARIUS / STELLAR_DEX | Horizon transaction + effects | transaction hash |
| NEAR | 1Click `GET /v0/status` | deposit address (+ memo) |
| AXELAR_ITS | Axelarscan GMP `searchGMP` | source-chain hash, across two hub hops |

The settled amount is always **read**, never taken on trust: for a Stellar swap it is summed from
the recipient's `account_credited` effects in the buy asset, which works uniformly across classic
path payments and Soroban SAC transfers. A successful transaction that decodes no matching credit
reports completion *without* an amount rather than a false zero.

What a committed route carries for this is a `tracking` handle built by the adapter that produced
it — the identifiers its venue is keyed by. That handle travels on the route, so tracking needs no
stored record anywhere: `sdk.track(route, hash)` is enough. A `uuid` also works for a route
committed by the same SDK instance, but that registry is in-memory; persist the route to survive a
reload.

The one thing a server does that a page cannot is keep polling after the page is gone. For a
cross-chain route settling minutes later, persist the handle and resume on the next visit.

One known limitation, inherited and unchanged: StellarBroker may split a large order across several
transactions in one ledger, and a single reported hash covers only that transaction's share — so a
split fill's tracked amount is a **lower bound**. The session result carries the true totals.

## What was deliberately not ported

Three things sat next to the funded components in the server but are not part of them:

- **Fee resolution from a database.** The server read per-user fee rows and a register of verified
  fee wallets. Here this is plain configuration (`serviceFees`), defaulting to no fee. The fee
  *math* — each venue's mechanism, the gross/net split conventions — is ported in full.
- **Sanction haircuts, analytics rows, Prometheus counters, swap records, affiliate splits,
  provider suspension flags.** Operational concerns of running a hosted service, none of which
  changes which route wins or what it pays out.
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
