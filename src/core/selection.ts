/**
 * Route selection — deciding which of the quoted routes to commit to.
 *
 * Kept apart from route discovery (`src/routing/registry.ts`, which decides who to ASK) and from
 * the fan-out (`src/routing/fanout.ts`, which runs them): choosing the wrong providers and ranking
 * their answers badly are different failures, and separating them keeps each one testable alone.
 */

import { RECIPIENT_CAPABLE_PROVIDERS, Route, STELLAR_PROVIDERS, StellarProvider } from './types.js'

/** The provider name a route resolves to (single-provider routes today). */
export function routeProvider(route: Route): string | undefined {
  return route.providers?.[0]
}

/**
 * Pick the best route: the one that returns the most, by `expectedBuyAmount`.
 *
 * No provider is preferred over another. Every adapter reports `expectedBuyAmount` already net of
 * the fees that come out of the traded amount, so the figures are directly comparable and the
 * largest one is the best quote on offer.
 *
 * This replaced an earlier StellarBroker-first rule, which selected a StellarBroker route even when
 * another provider quoted more, on the reasoning that SB's number was a conservative estimate. That
 * reasoning was never verifiable from a quote — see the caveat below — so it is gone: selection is
 * now decided by the numbers the providers actually publish.
 *
 * **Caveat worth knowing.** `expectedBuyAmount` is the right basis for comparison but not a
 * promise. STELLARBROKER's figure is an estimate with `minBuyAmount === null` — the broker
 * re-quotes live during its session — whereas every other Stellar provider's floor is enforced
 * on-chain. Two routes quoting the same amount are therefore not equally certain, and a caller who
 * would rather have a guaranteed floor than the highest estimate can filter on `minBuyAmount`
 * before ranking:
 *
 * ```ts
 * const guaranteed = bestByExpected(q.allRoutes.filter((r) => r.minBuyAmount !== null))
 * ```
 *
 * Network fees are also excluded from this comparison: they are additive, paid in XLM rather than
 * the buy asset, and differ between a classic path payment and a Soroban invoke. They appear as
 * `inbound` lines on `route.fees` for a caller who wants to account for them.
 *
 * The caller carries the picked provider into the commit so the committed quote matches the
 * shown price.
 */
export function selectRoute(routes: Route[]): Route | undefined {
  return bestByExpected(routes)
}

/**
 * Selection across Stellar in-chain and cross-chain (`transfer`) routes together: prefer a Stellar
 * in-chain route whenever one exists, and fall back to the best cross-chain route only when no
 * Stellar provider can serve the pair.
 *
 * This preference is about SETTLEMENT, not price, which is why it survives while the price-based
 * one did not: an in-chain swap settles in a single ledger (~5s) against an enforced floor, while a
 * cross-chain route settles over minutes across a bridge with its own failure and refund modes.
 * Those are different products, not competing quotes.
 *
 * In practice it rarely arbitrates anything — route discovery already sends a Stellar-native pair
 * only to the Stellar providers — so it matters mainly when a caller overrides the provider set by
 * hand. Within each group, the best `expectedBuyAmount` wins.
 */
export function selectUnifiedRoute(routes: Route[]): Route | undefined {
  const stellar = routes.filter((r) => (STELLAR_PROVIDERS as readonly string[]).includes(routeProvider(r) ?? ''))
  return stellar.length ? bestByExpected(stellar) : bestByExpected(routes)
}

/**
 * The route with the greatest `expectedBuyAmount`, compared as decimal strings so no amount ever
 * passes through a float. Ties keep the earliest route, which makes the result stable for a given
 * fan-out order rather than dependent on which provider happened to answer first.
 */
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
 * STELLAR_DEX).
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
