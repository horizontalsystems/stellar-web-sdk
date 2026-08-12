/**
 * SOROSWAP adapter — a Stellar DEX aggregator (its own AMM plus Phoenix, Aqua and the SDEX behind
 * one API). `POST /quote` prices the route; a committed quote passes the WHOLE quote object back
 * into `POST /quote/build`, which returns an unsigned envelope the client signs and broadcasts.
 *
 * Two pieces of defensive logic below are the reason this adapter is not a thin proxy over the
 * aggregator: the `aqua` venue exclusion and the `otherAmountThreshold` clamp. Both correct live
 * mispricings, and both change which route selection sees.
 *
 * Authentication: every Soroswap swap endpoint requires a `sk_…` bearer key (403 without one)
 * despite their OpenAPI marking them public.
 */

import { Networks, TransactionBuilder } from '@stellar/stellar-sdk'
import { parseStellarAssetIdentifier, sacContractId } from '../../core/assets.js'
import {
  apiAmountToStroops,
  floorAfterSlippage,
  fromStroops,
  normalizeStellarAmount,
  toStroops
} from '../../core/amounts.js'
import { Fee, Route } from '../../core/types.js'
import { makeRoute, makeSignedTxExecution, trackingStellar } from '../../routing/route.js'
import { stellarPreflight } from '../../stellar/preflight.js'
import { httpJson, providerError } from '../http.js'
import { ProviderContext, ProviderQuoteRequest } from '../types.js'

export const PROVIDER = 'SOROSWAP'

const DEFAULT_URL = 'https://api.soroswap.finance'

/** Soroban transactions carry resource fees on top of the base fee. The built XDR has the real one. */
const APPROX_FEE_XLM = '0.001'

const ESTIMATED_TIME = { inbound: 0, swap: 6, outbound: 0, total: 6 }

/**
 * Our share of the GROSS `feeBps`; Soroswap retains the remainder. Measured on-chain at 60/40,
 * undocumented by Soroswap, so a nominal 100 bps earns 60. Reported as two fee lines — SERVICE for
 * the net take, LIQUIDITY for Soroswap's cut — because recording the gross as service revenue
 * overstates it by 1.67x and breaks the invariant that the service line is net.
 */
const PARTNER_SHARE_BPS = 6000n

/** Passed back into `/quote/build` VERBATIM. Treat as opaque beyond the fields read here. */
interface SoroswapQuoteResponse {
  assetIn: string
  assetOut: string
  amountIn: string
  amountOut: string
  /** The floor Soroswap claims to enforce after slippage (min output for EXACT_IN). */
  otherAmountThreshold: number | string
  tradeType: string
  priceImpactPct?: string
  platform?: string
  rawTrade?: unknown
  routePlan?: { swapInfo: { protocol: string; path: string[] }; percent: string | number }[]
  platformFee?: { feeBps: number; feeAmount: number | string }
  [key: string]: unknown
}

export async function getQuote(
  request: ProviderQuoteRequest,
  context: ProviderContext,
  signal?: AbortSignal
): Promise<Route> {
  const sellAsset = parseStellarAssetIdentifier(request.sellAsset)
  const buyAsset = parseStellarAssetIdentifier(request.buyAsset)
  if (sellAsset.identifier === buyAsset.identifier) {
    throw providerError(PROVIDER, 'pairNotSupported', 'assets are identical', { origin: 'local' })
  }

  const apiKey = context.credentials.soroswapApiKey
  const baseUrl = context.endpoints.soroswapUrl ?? DEFAULT_URL
  const network = context.endpoints.soroswapNetwork ?? 'mainnet'

  // Every classic asset (and native XLM) has a canonical Stellar Asset Contract. Derive its C… id
  // locally — a deterministic hash, no RPC — since that is the one asset form all Soroswap venues
  // accept. Derived against PUBLIC specifically: the SAC id is network-scoped.
  const assetIn = sacContractId(sellAsset, Networks.PUBLIC)
  const assetOut = sacContractId(buyAsset, Networks.PUBLIC)

  // Truncate to the 7-dp grid so the amount sent upstream equals the amount echoed on the route
  // (rounding would spend up to a stroop more than requested).
  const sellAmount = normalizeStellarAmount(request.sellAmount)
  const sellAmountRaw = toStroops(sellAmount)
  const slippageBps = Math.round(request.slippage * 100)

  // Service fee. Soroswap charges it on the INPUT and collects it on-chain, so `referralId` is
  // mandatory at build once `feeBps` was quoted — never quote a fee without a wallet to receive
  // it. The wallet must already trust a classic sell asset or the fee payment fails.
  const feeConfig = context.serviceFees[PROVIDER]
  const feeWallet = feeConfig?.wallet
  const serviceBps = feeWallet && feeConfig?.bps && feeConfig.bps > 0 ? feeConfig.bps : 0

  const quoteRes = await httpJson<SoroswapQuoteResponse & { message?: string }>({
    url: `${baseUrl}/quote`,
    method: 'POST',
    query: { network },
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: {
      assetIn,
      assetOut,
      amount: String(sellAmountRaw),
      tradeType: 'EXACT_IN',
      protocols: context.tunables.soroswapProtocols,
      slippageBps,
      ...(serviceBps > 0 ? { feeBps: serviceBps } : {})
    },
    signal,
    fetch: context.fetch,
    provider: PROVIDER
  })

  if (!quoteRes.ok) throw toSoroswapError(quoteRes.status, quoteRes.data)
  const quote = quoteRes.data

  // Route sanity gate. Soroswap's aggregator will route through stale or thin pools: a route via
  // an unknown intermediate Soroban token has been observed quoting 52% above market. Such a route
  // either reverts on-chain or fills at the sick pool's real price — the shown number is fiction
  // either way, and the fan-out would PREFER it on price. Impact beyond the threshold in EITHER
  // direction means the pricing pool is unhealthy, so the route is dropped and the honest venues
  // serve instead. An absent field skips the gate.
  const priceImpactPct = Number(quote.priceImpactPct)
  const maxImpact = context.tunables.soroswapMaxPriceImpactPct
  if (Number.isFinite(priceImpactPct) && Math.abs(priceImpactPct) > maxImpact) {
    throw providerError(
      PROVIDER,
      'routeNotFound',
      `route rejected: price impact ${priceImpactPct}% exceeds ${maxImpact}% (unhealthy pool route)`
    )
  }

  const amountOutRaw = apiAmountToStroops(quote.amountOut)
  const expectedBuyAmount = fromStroops(amountOutRaw)

  // `otherAmountThreshold` is meant to be the slippage-adjusted on-chain floor, but Soroswap's
  // Aquarius-protocol routes return it EQUAL to `amountOut` — no buffer at all, regardless of the
  // `slippageBps` sent. Recording that verbatim would yield a false fully-enforced floor: the
  // committed transaction would carry zero tolerance and revert on any drift, and a `minBuyAmount`
  // equal to expected would register a miss the moment a fill lands a stroop short. So clamp to
  // our own computed floor and keep the more conservative value — a no-op on well-behaved routes.
  const providerThresholdRaw = apiAmountToStroops(quote.otherAmountThreshold)
  const computedFloorRaw = floorAfterSlippage(amountOutRaw, request.slippage)
  const floorRaw = providerThresholdRaw < computedFloorRaw ? providerThresholdRaw : computedFloorRaw
  const minBuyAmount = fromStroops(floorRaw)

  const fees: Fee[] = []
  if (serviceBps > 0) {
    const grossFeeRaw = (sellAmountRaw * BigInt(serviceBps)) / 10000n
    const ourFeeRaw = (grossFeeRaw * PARTNER_SHARE_BPS) / 10000n
    const soroswapFeeRaw = grossFeeRaw - ourFeeRaw
    if (ourFeeRaw > 0n) {
      fees.push({
        type: 'service',
        chain: 'XLM',
        asset: sellAsset.identifier,
        amount: fromStroops(ourFeeRaw),
        protocol: PROVIDER
      })
    }
    if (soroswapFeeRaw > 0n) {
      fees.push({
        type: 'liquidity',
        chain: 'XLM',
        asset: sellAsset.identifier,
        amount: fromStroops(soroswapFeeRaw),
        protocol: PROVIDER
      })
    }
  }
  fees.push({ type: 'inbound', chain: 'XLM', asset: 'XLM.XLM', amount: APPROX_FEE_XLM, protocol: PROVIDER })

  if (request.dry) {
    return makeRoute({
      provider: PROVIDER,
      sellAsset: sellAsset.identifier,
      sellAmount,
      buyAsset: buyAsset.identifier,
      expectedBuyAmount,
      minBuyAmount,
      fees,
      estimatedTime: ESTIMATED_TIME
    })
  }

  if (!request.sourceAddress) {
    throw providerError(PROVIDER, 'invalidParams', 'sourceAddress is required for a committed quote', {
      origin: 'local'
    })
  }
  if (!apiKey) {
    throw providerError(PROVIDER, 'invalidParams', 'an API key is required to build a Soroswap transaction', {
      origin: 'local'
    })
  }
  const source = request.sourceAddress
  const destination = request.destinationAddress ?? source

  await stellarPreflight(context.horizon, PROVIDER, source, destination, buyAsset)

  const buildRes = await httpJson<{ xdr?: string; message?: string }>({
    url: `${baseUrl}/quote/build`,
    method: 'POST',
    query: { network },
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      // Send the clamped floor back so the built transaction enforces real slippage tolerance on
      // the routes that ignored it. If build derives its minimum from the opaque `rawTrade`
      // instead, this at least cannot tighten it — the clamped floor is never above the original.
      quote: { ...quote, otherAmountThreshold: String(floorRaw) },
      from: source,
      ...(destination !== source ? { to: destination } : {}),
      ...(serviceBps > 0 ? { referralId: feeWallet! } : {})
    },
    signal,
    fetch: context.fetch,
    provider: PROVIDER
  })

  if (!buildRes.ok || !buildRes.data?.xdr) throw toSoroswapError(buildRes.status, buildRes.data)
  const xdr = buildRes.data.xdr

  return makeRoute({
    provider: PROVIDER,
    sellAsset: sellAsset.identifier,
    sellAmount,
    buyAsset: buyAsset.identifier,
    expectedBuyAmount,
    minBuyAmount,
    fees,
    estimatedTime: ESTIMATED_TIME,
    // The built transaction carries Soroswap's own timebounds — surface the real deadline.
    expiresAt: xdrExpiry(xdr, context.config.networkPassphrase),
    execution: makeSignedTxExecution({ chain: 'XLM', xdr }),
    tracking: trackingStellar({
      provider: PROVIDER,
      fromAsset: sellAsset.identifier,
      toAsset: buyAsset.identifier,
      toAddress: destination,
      fromAddress: source,
      fromAmount: sellAmount
    })
  })
}

/**
 * Read the max-time bound out of the built envelope so `expiresAt` reflects the REAL on-chain
 * deadline. Absent or unparseable bounds fall back to a conservative 60s, because Soroban
 * footprints go stale quickly.
 */
function xdrExpiry(xdr: string, networkPassphrase: string): number {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as unknown as {
      timeBounds?: { maxTime?: string | number }
      innerTransaction?: { timeBounds?: { maxTime?: string | number } }
    }
    const maxTime = Number(tx.timeBounds?.maxTime ?? tx.innerTransaction?.timeBounds?.maxTime ?? 0)
    if (maxTime > 0) return maxTime * 1000
  } catch {
    // fall through to the conservative default
  }
  return Date.now() + 60_000
}

/** Normalize a Soroswap failure. A 400 doubles as their no-route signal — there is no separate body. */
function toSoroswapError(status: number, body: unknown) {
  const message =
    (body as { message?: string } | undefined)?.message ?? (typeof body === 'string' ? body : `HTTP ${status}`)
  if (status === 400) return providerError(PROVIDER, 'routeNotFound', message, { status, details: body })
  if (status === 401 || status === 403) {
    return providerError(PROVIDER, 'unknownApiError', `API key missing or invalid: ${message}`, { status, details: body })
  }
  return providerError(PROVIDER, 'networkError', message, { status, details: body })
}
