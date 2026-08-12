# Routing performance benchmarks

Reproduce with:

```sh
npm run build
node bench/routing.mjs --iterations 30 [--amount 100] [--json results.json]
```

The harness is [`bench/routing.mjs`](bench/routing.mjs). It measures three things: per-provider
quote latency, what the parallel fan-out buys over running the adapters one after another, and the
pure-CPU cost of route discovery and route selection.

## What these numbers are, and are not

The first two measurements are latency against **live third-party venues**. They move with network
conditions, upstream load and time of day, and they are not a controlled measurement. They are
reported as a distribution over repeated runs rather than a single figure, and the run conditions
are printed with the results, so re-running the harness reproduces the *shape* — the relative
ordering of providers, the parallelism gain — rather than the exact milliseconds.

The route-selection measurement in §3 *is* controlled: it is pure computation over an in-memory
route list, with no network involved.

Percentiles use nearest-rank. At 30 iterations p95 is the second-slowest sample, so treat it as
"a bad run" rather than a tail estimate.

## Run conditions

| | |
|---|---|
| Date | 2026-08-11T09:47:35Z |
| Runtime | Node v24.5.0, macOS (darwin 22.6.0) |
| Iterations | 30 |
| Pair | 100 `XLM.XLM` → `XLM.USDC-GA5ZSE…` |
| Slippage | 1% |
| Network | residential connection, single host, mainnet endpoints |
| Backend | none — the SDK calls each venue directly |

## 1. Per-provider quote latency (ms)

Wall-clock for one adapter's complete dry quote: the upstream call plus normalization and route
construction.

| Provider | n | min | p50 | p95 | max | mean |
|---|---:|---:|---:|---:|---:|---:|
| STELLARBROKER | 30 | 673 | 792 | 1010 | 1076 | 828 |
| SOROSWAP | 30 | 214 | 418 | 605 | 1156 | 437 |
| AQUARIUS | 30 | 130 | 136 | 216 | 704 | 160 |
| STELLAR_DEX | 30 | 291 | 305 | 407 | 1030 | 339 |

StellarBroker is consistently the slowest, which is expected: its `GET /quote` is itself an
aggregation across Soroswap, Phoenix, Aquarius and the SDEX, so it pays for a fan-out of its own
before answering. Aquarius is the fastest by a wide margin — a single AMM path-find. Because the
adapters run concurrently, StellarBroker's latency alone sets the floor for the whole quote.

## 2. Fan-out wall-clock vs serial sum (ms)

| Metric | n | min | p50 | p95 | max | mean |
|---|---:|---:|---:|---:|---:|---:|
| Fan-out (actual) | 30 | 673 | 792 | 1077 | 1184 | 834 |
| Sum if run serially | 30 | 1374 | 1653 | 1983 | 3897 | 1765 |

**Parallelism gain at p50: 2.09×** (1653 ms serial → 792 ms fanned out).

The fan-out's wall-clock tracks the *slowest* provider almost exactly (792 ms vs StellarBroker's
792 ms p50), which is what a correct parallel fan-out should look like — the other three adapters
cost nothing in wall-clock terms.

Over these 30 runs the fan-out returned 3–4 of 4 routes: some iterations had a single provider
decline, which the fan-out reports as a per-provider error while still returning the rest. That is
the designed behaviour, not a failed run — a quote succeeds as long as one route comes back.

Both time budgets are configurable via `tunables`, defaulting to 12 s per provider and 15 s for the
whole fan-out.

## 3. Route selection overhead (pure CPU, 100,000 runs each)

| Operation | Cost |
|---|---|
| Route selection over 4 routes | **0.23 µs/call** |
| Route discovery (pair classification + provider selection) | **1.13 µs/call** |
| Combined, as a share of a p50 quote | **0.0002%** |

Route selection is computationally free relative to the network. Any effort spent optimizing the
routing policy for speed would be wasted; the only thing that moves quote latency is the number and
choice of upstream calls.

## A note on service fees

Quotes here are measured with the default configuration, which applies **no service fee**. Setting
one changes the quoted output by exactly that fee — a 100 bps `serviceFees: { AQUARIUS: { bps: 100,
… } }` moves Aquarius's figure by 1.0101% (1/0.99 − 1), and the fee lines on the route show it.
Worth knowing before comparing these numbers against another deployment's: a whole-percent gap
between two otherwise identical quotes is usually fee configuration, not routing.
