#!/usr/bin/env node
/**
 * Routing performance benchmark.
 *
 * Measures the three things that determine how long a quote takes:
 *
 *   1. per-provider quote latency — how long each adapter takes to answer, live;
 *   2. fan-out wall-clock vs the serial sum — what running the adapters in parallel actually buys;
 *   3. solver + discovery cost — the pure-CPU part of route selection.
 *
 * The first two are latency against live venues, which is not a controlled measurement: it moves with network conditions,
 * upstream load and the time of day. It is reported as a distribution over repeated runs, and the
 * conditions are recorded alongside the numbers, so the figures are reproducible in the only sense
 * that matters here — re-run it and you get the same shape.
 *
 * Usage:
 *   node bench/routing.mjs [--iterations 10] [--amount 100] [--json out.json]
 *
 * Credentials are read from the environment (SOROSWAP_API_KEY, STELLARBROKER_PARTNER_KEY). Every
 * provider runs without them except Soroswap, which declines with a clear per-provider error
 * rather than being silently reported as a failure.
 */

import { writeFileSync } from 'node:fs'
import { StellarSwapSDK, PROVIDER_REGISTRY, discoverProviders, selectUnifiedRoute, makeRoute } from '../dist/index.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const ITERATIONS = Number(flag('iterations', 10))
const AMOUNT = flag('amount', '100')
const JSON_OUT = flag('json', null)

const USDC = 'XLM.USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const PAIR = { sellAsset: 'XLM.XLM', buyAsset: USDC, sellAmount: AMOUNT, slippage: 1 }

const credentials = {
  ...(process.env.SOROSWAP_API_KEY ? { soroswapApiKey: process.env.SOROSWAP_API_KEY } : {}),
  ...(process.env.STELLARBROKER_PARTNER_KEY ? { stellarBrokerPartnerKey: process.env.STELLARBROKER_PARTNER_KEY } : {})
}

const sdk = new StellarSwapSDK({ credentials })

/** Percentile of a sorted-on-demand sample, using nearest-rank. */
function pct(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

function stats(values) {
  if (!values.length) return null
  return {
    n: values.length,
    min: Math.min(...values),
    p50: pct(values, 50),
    p95: pct(values, 95),
    max: Math.max(...values),
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length)
  }
}

function row(label, s) {
  if (!s) return `${label.padEnd(16)} (no samples)`
  return [
    label.padEnd(16),
    String(s.n).padStart(4),
    String(s.min).padStart(7),
    String(s.p50).padStart(7),
    String(s.p95).padStart(7),
    String(s.max).padStart(7),
    String(s.mean).padStart(7)
  ].join(' ')
}

const HEADER = ['metric'.padEnd(16), '   n', '    min', '    p50', '    p95', '    max', '   mean'].join(' ')

console.log('stellar-web-sdk — routing performance benchmark')
console.log(`node ${process.version} · ${new Date().toISOString()} · ${ITERATIONS} iterations · ${AMOUNT} XLM → USDC`)
console.log(`soroswap key: ${credentials.soroswapApiKey ? 'set' : 'ABSENT (provider will decline)'}`)
console.log()

// ---------------------------------------------------------------------------
// 1 + 2. Live fan-out: per-provider latency and the parallelism gain.
// ---------------------------------------------------------------------------

const perProvider = {}
const fanoutWall = []
const serialSum = []
const routeCounts = []
const picks = {}

for (let i = 0; i < ITERATIONS; i++) {
  const started = Date.now()
  const q = await sdk.quote(PAIR)
  fanoutWall.push(Date.now() - started)

  let sum = 0
  for (const [provider, ms] of Object.entries(q.timings)) {
    ;(perProvider[provider] ??= []).push(ms)
    sum += ms
  }
  serialSum.push(sum)
  routeCounts.push(q.allRoutes.length)
  if (q.provider) picks[q.provider] = (picks[q.provider] ?? 0) + 1
}

console.log('## 1. Per-provider quote latency (ms, live)')
console.log(HEADER)
for (const provider of PROVIDER_REGISTRY.map((p) => p.name)) {
  if (perProvider[provider]) console.log(row(provider, stats(perProvider[provider])))
}
console.log()

console.log('## 2. Fan-out wall-clock vs serial sum (ms)')
console.log(HEADER)
console.log(row('fan-out (actual)', stats(fanoutWall)))
console.log(row('sum if serial', stats(serialSum)))
const wallP50 = pct(fanoutWall, 50)
const serialP50 = pct(serialSum, 50)
const speedup = wallP50 ? (serialP50 / wallP50).toFixed(2) : 'n/a'
console.log(`\nparallelism gain at p50: ${speedup}x (${serialP50}ms serial → ${wallP50}ms fanned out)`)
console.log(`routes returned per quote: ${Math.min(...routeCounts)}–${Math.max(...routeCounts)} of 4`)
console.log(`selected provider: ${Object.entries(picks).map(([p, n]) => `${p} ${n}/${ITERATIONS}`).join(', ')}`)
console.log()

// ---------------------------------------------------------------------------
// 3. Solver and discovery — the pure-CPU part, measured in isolation.
// ---------------------------------------------------------------------------

const SOLVER_RUNS = 100_000
const sample = ['STELLARBROKER', 'SOROSWAP', 'AQUARIUS', 'STELLAR_DEX'].map((provider, i) =>
  makeRoute({
    provider,
    sellAsset: 'XLM.XLM',
    sellAmount: AMOUNT,
    buyAsset: USDC,
    expectedBuyAmount: String(16 + i * 0.01),
    fees: [],
    estimatedTime: { inbound: 0, swap: 6, outbound: 0, total: 6 }
  })
)

let t0 = performance.now()
for (let i = 0; i < SOLVER_RUNS; i++) selectUnifiedRoute(sample)
const solverUs = ((performance.now() - t0) * 1000) / SOLVER_RUNS

t0 = performance.now()
for (let i = 0; i < SOLVER_RUNS; i++) discoverProviders({ sellAsset: 'XLM.XLM', buyAsset: USDC })
const discoveryUs = ((performance.now() - t0) * 1000) / SOLVER_RUNS

console.log('## 3. Route selection overhead (pure CPU)')
console.log(`selection over 4 routes : ${solverUs.toFixed(2)} µs/call  (${SOLVER_RUNS.toLocaleString()} runs)`)
console.log(`route discovery         : ${discoveryUs.toFixed(2)} µs/call  (${SOLVER_RUNS.toLocaleString()} runs)`)
console.log(`combined share of a p50 fan-out: ${((((solverUs + discoveryUs) / 1000) / wallP50) * 100).toFixed(4)}%`)
console.log()

if (JSON_OUT) {
  const payload = {
    meta: {
      timestamp: new Date().toISOString(),
      node: process.version,
      iterations: ITERATIONS,
      amount: AMOUNT,
      pair: 'XLM.XLM->USDC',
      soroswapKey: !!credentials.soroswapApiKey
    },
    perProvider: Object.fromEntries(Object.entries(perProvider).map(([k, v]) => [k, stats(v)])),
    fanout: stats(fanoutWall),
    serialSum: stats(serialSum),
    speedup: Number(speedup),
    solverUs,
    discoveryUs
  }
  writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2))
  console.log(`wrote ${JSON_OUT}`)
}
