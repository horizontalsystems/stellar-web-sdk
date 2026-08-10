# Routing performance benchmarks

Reproduce with:

```sh
npm run build
node bench/routing.mjs --iterations 30 [--amount 100] [--json results.json]
```

The harness is [`bench/routing.mjs`](bench/routing.mjs). It measures four things: per-provider
quote latency, what the parallel fan-out buys over running the adapters one after another, the
pure-CPU cost of route discovery and the waterfall solver, and — when a `uswap-server` is
configured — local routing against a hosted `/v2/rate` round trip.

## What these numbers are, and are not

Three of the four measurements are latency against **live third-party venues**. They move with
network conditions, upstream load and time of day, and they are not a controlled measurement. They
are reported as a distribution over repeated runs rather than a single figure, and the run
conditions are printed with the results, so re-running the harness reproduces the *shape* — the
relative ordering of providers, the parallelism gain, the ratio between local and hosted — rather
than the exact milliseconds.

The route-selection measurement in §3 *is* controlled: it is pure computation over an in-memory
route list, with no network involved.

Percentiles use nearest-rank. At 30 iterations p95 is the second-slowest sample, so treat it as
"a bad run" rather than a tail estimate.

## Run conditions

| | |
|---|---|
| Date | 2026-08-10T12:00:41Z |
| Runtime | Node v24.5.0, macOS (darwin 22.6.0) |
| Iterations | 30 |
| Pair | 100 `XLM.XLM` → `XLM.USDC-GA5ZSE…` |
| Slippage | 1% |
| Network | residential connection, single host, mainnet endpoints |
| Routing | `routing: 'local'` — the SDK's own adapters, no server in the path |

## 1. Per-provider quote latency (ms)

Wall-clock for one adapter's complete dry quote: the upstream call plus normalization and route
construction.

| Provider | n | min | p50 | p95 | max | mean |
|---|---:|---:|---:|---:|---:|---:|
| STELLARBROKER | 30 | 678 | 753 | 891 | 980 | 761 |
| SOROSWAP | 30 | 215 | 475 | 565 | 659 | 455 |
| AQUARIUS | 30 | 137 | 143 | 196 | 215 | 148 |
| STELLAR_DEX | 30 | 293 | 307 | 376 | 860 | 333 |

StellarBroker is consistently the slowest, which is expected: its `GET /quote` is itself an
aggregation across Soroswap, Phoenix, Aquarius and the SDEX, so it pays for a fan-out of its own
before answering. Aquarius is the fastest by a wide margin — a single AMM path-find. Because the
adapters run concurrently, StellarBroker's latency alone sets the floor for the whole quote.

## 2. Fan-out wall-clock vs serial sum (ms)

| Metric | n | min | p50 | p95 | max | mean |
|---|---:|---:|---:|---:|---:|---:|
| Fan-out (actual) | 30 | 678 | 754 | 891 | 981 | 761 |
| Sum if run serially | 30 | 1381 | 1697 | 1857 | 2695 | 1697 |

**Parallelism gain at p50: 2.25×** (1697 ms serial → 754 ms fanned out).

The fan-out's wall-clock tracks the *slowest* provider almost exactly (754 ms vs StellarBroker's
753 ms p50), which is what a correct parallel fan-out should look like — the other three adapters
cost nothing in wall-clock terms.

Over these 30 runs the fan-out returned 3–4 of 4 routes: one iteration had a single provider
decline, which the fan-out reports as a per-provider error while still returning the rest. That is
the designed behaviour, not a failed run — a quote succeeds as long as one route comes back.

Both time budgets are configurable via `tunables` and default to the hosted server's values: 12 s
per provider, 15 s for the whole fan-out.

## 3. Route selection overhead (pure CPU, 100,000 runs each)

| Operation | Cost |
|---|---|
| Waterfall solver over 4 routes | **0.23 µs/call** |
| Route discovery (pair classification + provider selection) | **1.11 µs/call** |
| Combined, as a share of a p50 quote | **0.0002%** |

Route selection is computationally free relative to the network. Any effort spent optimizing the
routing policy for speed would be wasted; the only thing that moves quote latency is the number and
choice of upstream calls.

## 4. Local routing vs hosted `/v2/rate` (ms)

| Path | n | min | p50 | p95 | max | mean |
|---|---:|---:|---:|---:|---:|---:|
| Local (SDK adapters) | 30 | 678 | 754 | 891 | 981 | 761 |
| Hosted `/v2/rate` | 30 | 858 | 964 | 1152 | 1402 | 979 |

Local routing is **~210 ms faster at p50** (a 22% reduction). Both paths run the same adapters
against the same venues; the difference is one network hop. Routing locally removes the client →
server leg, leaving the client to talk to the venues directly.

This is a latency comparison only. The hosted path still provides swap tracking, which local
routing does not replace — see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Pricing parity with the hosted server

Not a performance measure, but the check that makes the latency numbers meaningful: the ported
adapters must produce the *same routes*, not merely faster ones. Quoting 100 XLM → USDC through
both paths simultaneously:

| Provider | Local | Hosted | Delta |
|---|---|---|---|
| SOROSWAP | 16.3576019 | 16.3576019 | 0.0000% |
| STELLARBROKER | 16.3635666 | 16.3635666 | 0.0000% |
| STELLAR_DEX | 16.3634545 | 16.3576019 | 0.0358% |
| AQUARIUS | 16.3494113 | 16.1859171 | 1.0101% |

The STELLAR_DEX delta is live order-book movement between the two calls — repeated runs show it
sitting on either side of zero.

The Aquarius delta was **not** noise: it reproduced at exactly 1.0101% across every run, which is
the signature of a 100 bps fee (1/0.99 − 1). The hosted deployment has an Aquarius service fee
configured; the SDK's default is no fee. Configuring `serviceFees: { AQUARIUS: { bps: 100, … } }`
locally reproduces the hosted figure exactly — `16.1859171` on both sides, with identical fee
lines. Fee configuration is the only source of divergence between the two paths.
