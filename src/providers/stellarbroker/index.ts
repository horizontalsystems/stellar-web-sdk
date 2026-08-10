/**
 * STELLARBROKER adapter — Stellar-native multi-source router (it aggregates Soroswap, Phoenix,
 * Aquarius and the SDEX behind one quote).
 *
 * Ported from `uswap-server/src/providers/stellarbroker/`. Quoting is plain unauthenticated REST.
 * EXECUTION is what makes this provider different: there is no transaction to hand over, because
 * the broker builds and submits every transaction itself over an interactive WebSocket session
 * that the CLIENT runs and signs into. A committed quote therefore returns session parameters, not
 * an envelope — see `src/execution/stellarBroker/` for the session and its signing pipeline.
 *
 * `minBuyAmount` stays null on purpose. The committed numbers are a snapshot: the broker re-quotes
 * live in-session within `slippageTolerance`, so there is no client-verifiable on-chain floor to
 * promise. This is the one Stellar provider whose output is genuinely an estimate, which is also
 * why the waterfall treats its number the way it does (see `src/core/waterfall.ts`).
 */

import { parseStellarAssetIdentifier, stellarAssetId } from '../../core/assets.js'
import { normalizeStellarAmount } from '../../core/amounts.js'
import { Fee, Route } from '../../core/types.js'
import { makeRoute, makeStellarBrokerExecution } from '../../routing/route.js'
import { stellarPreflight } from '../../stellar/preflight.js'
import { httpJson, providerError } from '../http.js'
import { ProviderContext, ProviderQuoteRequest } from '../types.js'

export const PROVIDER = 'STELLARBROKER'

const DEFAULT_URL = 'https://api.stellar.broker'

/** Stellar ledgers close in ~5s and the broker splits a trade over a few sequential txs. */
const ESTIMATED_TIME = { inbound: 0, swap: 15, outbound: 0, total: 15 }

/**
 * Approximate network fee for the trade, in XLM. The broker's own cut is baked into the
 * transactions it builds as an on-chain fee leg — there is no fee parameter to set and no service
 * carve-out to report until the partner terms define one.
 */
const APPROX_FEE_XLM = '0.0001'

/** `GET /quote` result. Also the shape of the session's live `quote` message. */
interface StellarBrokerQuoteResult {
  status: 'success' | 'unfeasible' | 'rejected'
  sellingAsset: string
  buyingAsset: string
  slippageTolerance: number
  sellingAmount: string
  /** Expected output — absent on any non-success status. */
  estimatedBuyingAmount?: string
  directTrade?: { selling: string; buying: string; path: string[] }
  ts?: string
  /** Present only on `rejected` / `unfeasible`. */
  error?: string
}

export async function getQuote(
  request: ProviderQuoteRequest,
  context: ProviderContext,
  signal?: AbortSignal
): Promise<Route> {
  const sellAsset = parseStellarAssetIdentifier(request.sellAsset)
  const buyAsset = parseStellarAssetIdentifier(request.buyAsset)

  const sellingAsset = stellarAssetId(sellAsset)
  const buyingAsset = stellarAssetId(buyAsset)
  if (sellingAsset === buyingAsset) {
    throw providerError(PROVIDER, 'pairNotSupported', 'assets are identical', { origin: 'local' })
  }

  // The request carries slippage as a PERCENT (0.5 = 0.5%); the broker wants a fraction, capped
  // at 0.5 (50%).
  const slippageTolerance = Math.min(request.slippage / 100, 0.5)
  const sellingAmount = normalizeStellarAmount(request.sellAmount)

  const partnerKey = context.credentials.stellarBrokerPartnerKey

  if (!request.dry) {
    // Hard gate on commit: without a partner key the broker's WebSocket accepts the connection
    // and then silently drops it, so a keyless committed quote would die on an opaque timeout
    // AFTER the user confirmed — the worst possible moment. Declining here instead keeps SB out
    // of the committed path entirely and lets the waterfall fall through to a working provider.
    if (!partnerKey) {
      throw providerError(
        PROVIDER,
        'invalidParams',
        'a partner key is required to run a StellarBroker session — set credentials.stellarBrokerPartnerKey',
        { origin: 'local' }
      )
    }
    if (!request.sourceAddress) {
      throw providerError(PROVIDER, 'invalidParams', 'sourceAddress is required for a committed quote', {
        origin: 'local'
      })
    }
    // The broker's trade validator only accepts path payments whose destination IS the trader:
    // the swap settles on the trader's own account, so a third-party recipient is impossible.
    if (request.destinationAddress && request.destinationAddress !== request.sourceAddress) {
      throw providerError(
        PROVIDER,
        'invalidParams',
        'StellarBroker settles on the trader account; destination must equal source',
        { origin: 'local' }
      )
    }
    // Same pre-flight as the envelope-building providers: a missing account or an absent buy-asset
    // trustline would otherwise surface mid-session, potentially after partial signing.
    await stellarPreflight(context.horizon, PROVIDER, request.sourceAddress, request.sourceAddress, buyAsset)
  }

  const res = await httpJson<StellarBrokerQuoteResult>({
    url: `${context.endpoints.stellarBrokerUrl ?? DEFAULT_URL}/quote`,
    query: { sellingAsset, buyingAsset, sellingAmount, slippageTolerance },
    signal,
    fetch: context.fetch,
    provider: PROVIDER
  })

  const quote = res.data
  if (!res.ok || !quote || quote.status !== 'success' || !quote.estimatedBuyingAmount) {
    // `unfeasible` = no route or no liquidity (a provider-side decline); `rejected` = the broker
    // refused the request outright. Both carry the upstream message.
    const status = quote?.status
    throw providerError(
      PROVIDER,
      status === 'unfeasible' ? 'routeNotFound' : 'unknownApiError',
      quote?.error || `quote ${status ?? res.status}`,
      { status: res.status, details: quote }
    )
  }

  const fees: Fee[] = [
    { type: 'inbound', chain: 'XLM', asset: 'XLM.XLM', amount: APPROX_FEE_XLM, protocol: PROVIDER }
  ]

  if (request.dry) {
    return makeRoute({
      provider: PROVIDER,
      sellAsset: sellAsset.identifier,
      sellAmount: sellingAmount,
      buyAsset: buyAsset.identifier,
      expectedBuyAmount: quote.estimatedBuyingAmount,
      fees,
      estimatedTime: ESTIMATED_TIME
    })
  }

  return makeRoute({
    provider: PROVIDER,
    sellAsset: sellAsset.identifier,
    sellAmount: sellingAmount,
    buyAsset: buyAsset.identifier,
    expectedBuyAmount: quote.estimatedBuyingAmount,
    fees,
    estimatedTime: ESTIMATED_TIME,
    execution: makeStellarBrokerExecution({
      chain: 'XLM',
      sellingAsset,
      buyingAsset,
      sellingAmount,
      slippageTolerance,
      partnerKey
    })
  })
}
