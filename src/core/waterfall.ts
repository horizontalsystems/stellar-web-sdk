import { RECIPIENT_CAPABLE_PROVIDERS, Route, STELLAR_PROVIDERS, StellarProvider } from './types.js'

/** The provider name a route resolves to (single-provider routes today). */
export function routeProvider(route: Route): string | undefined {
  return route.providers?.[0]
}

/**
 * The StellarBroker-first waterfall (guide §3 — implement EXACTLY this):
 *
 *   1. If a STELLARBROKER route exists → pick it, even when a fallback shows a nominally
 *      higher `expectedBuyAmount`. SB's number is an estimate and it usually wins after
 *      execution; this is the grant's agreed policy.
 *   2. Else → the fallback route with the max `expectedBuyAmount`.
 *   3. Nothing → `undefined`.
 *
 * The caller carries the picked provider into `/v2/swap` so the committed quote matches the
 * shown price.
 */
export function selectRoute(routes: Route[]): Route | undefined {
  if (!routes || routes.length === 0) return undefined

  const broker = routes.find((r) => routeProvider(r) === 'STELLARBROKER')
  if (broker) return broker

  return bestByExpected(routes)
}

/**
 * Unified selection across Stellar in-chain and cross-chain (`transfer`) routes: PREFER a Stellar
 * in-chain route (SB-first waterfall) whenever one exists, and only fall back to the best
 * cross-chain route when Stellar can't serve the pair. This is the "in-chain if possible, else NEAR"
 * policy — Stellar always wins for a Stellar-native pair, regardless of the cross-chain quote.
 */
export function selectUnifiedRoute(routes: Route[]): Route | undefined {
  const stellar = routes.filter((r) => (STELLAR_PROVIDERS as readonly string[]).includes(routeProvider(r) ?? ''))
  return stellar.length ? selectRoute(stellar) : bestByExpected(routes)
}

/** The route with the greatest `expectedBuyAmount` (decimal-string safe compare). */
export function bestByExpected(routes: Route[]): Route | undefined {
  let best: Route | undefined
  for (const r of routes) {
    if (!best || compareDecimals(r.expectedBuyAmount, best.expectedBuyAmount) > 0) best = r
  }
  return best
}

/**
 * Which providers to quote given whether a third-party recipient is involved. SB and AQUARIUS
 * settle on the trader's own account and can't pay a different destination — when the recipient
 * differs from the source, restrict the fan-out to the recipient-capable providers (SOROSWAP,
 * STELLAR_DEX). See guide §3.
 */
export function providersForRecipient(hasThirdPartyRecipient: boolean): StellarProvider[] {
  if (!hasThirdPartyRecipient) return [...STELLAR_PROVIDERS]
  return [...RECIPIENT_CAPABLE_PROVIDERS]
}

/** Whether `destination` is a third party relative to `source` (case-sensitive account compare). */
export function isThirdPartyRecipient(source: string, destination: string | undefined): boolean {
  return !!destination && destination !== source
}

/**
 * Compare two non-negative decimal strings without floating point. Returns -1/0/1.
 * Both are assumed well-formed (`\d+(\.\d+)?`); malformed input sorts as smaller.
 */
export function compareDecimals(a: string, b: string): number {
  const pa = splitDecimal(a)
  const pb = splitDecimal(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  // Compare integer parts by numeric value (strip leading zeros).
  const ia = pa.int.replace(/^0+(?=\d)/, '')
  const ib = pb.int.replace(/^0+(?=\d)/, '')
  if (ia.length !== ib.length) return ia.length < ib.length ? -1 : 1
  if (ia !== ib) return ia < ib ? -1 : 1
  // Equal integer parts → compare fractional parts left-padded to equal length.
  const len = Math.max(pa.frac.length, pb.frac.length)
  const fa = pa.frac.padEnd(len, '0')
  const fb = pb.frac.padEnd(len, '0')
  if (fa === fb) return 0
  return fa < fb ? -1 : 1
}

function splitDecimal(v: string): { int: string; frac: string } | undefined {
  if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v.trim())) return undefined
  const t = v.trim()
  const dot = t.indexOf('.')
  return dot >= 0 ? { int: t.slice(0, dot), frac: t.slice(dot + 1) } : { int: t, frac: '' }
}
