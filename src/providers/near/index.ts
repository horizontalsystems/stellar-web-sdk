/**
 * NEAR adapter — cross-chain swaps over NEAR Intents' 1Click API.
 *
 * It speaks 1Click's REST contract directly rather than depending on
 * `@defuse-protocol/one-click-sdk-typescript`, which keeps the SDK's runtime dependency set at
 * exactly one package, and it resolves its asset catalog from 1Click's own `GET /v0/tokens`.
 *
 * Scope: a committed NEAR route returns the deposit address, amount and memo — the whole
 * `transfer` execution contract — and the connected wallet sends the deposit. Building the deposit
 * transaction for a non-Stellar origin chain (Bitcoin, EVM, Solana, …) is wallet work on that
 * chain and is outside this SDK's remit. Stellar-origin deposits, which it can build, are handled
 * by `src/execution/transfer.ts`.
 */

import { formatUnits, parseUnits } from '../../core/amounts.js'
import { Fee, Route, TokenInfo } from '../../core/types.js'
import { makeRoute, makeTransferExecution, trackingNear } from '../../routing/route.js'
import { httpJson, providerError } from '../http.js'
import { ProviderContext, ProviderQuoteRequest } from '../types.js'

export const PROVIDER = 'NEAR'

const DEFAULT_URL = 'https://1click.chaindefuser.com'

/** How long a committed quote's deposit address and price stay valid. */
const QUOTE_TTL_MS = 60 * 60 * 1000

/**
 * 1Click's `blockchain` field → the canonical chain code used in our asset identifiers. Chains
 * absent from this table keep their upstream code uppercased, so a newly listed chain still
 * appears in the catalog instead of vanishing from it.
 */
const CHAIN_CODES: Record<string, string> = {
  arb: 'ARB',
  avax: 'AVAX',
  base: 'BASE',
  bch: 'BCH',
  bera: 'BERA',
  bsc: 'BSC',
  btc: 'BTC',
  cardano: 'ADA',
  dash: 'DASH',
  doge: 'DOGE',
  eth: 'ETH',
  gnosis: 'GNO',
  ltc: 'LTC',
  monad: 'MONAD',
  near: 'NEAR',
  op: 'OP',
  pol: 'POL',
  sol: 'SOL',
  stellar: 'XLM',
  sui: 'SUI',
  ton: 'TON',
  tron: 'TRON',
  xlayer: 'XLAYER',
  xrp: 'XRP',
  zec: 'ZEC'
}

/** One entry of `GET /v0/tokens`. */
interface OneClickToken {
  assetId: string
  decimals: number
  blockchain: string
  symbol: string
  contractAddress?: string
  price?: number
  coingeckoId?: string | null
}

interface OneClickQuoteResponse {
  quote?: {
    amountIn: string
    amountInFormatted?: string
    minAmountIn?: string
    amountOut: string
    amountOutFormatted: string
    minAmountOut: string
    timeEstimate: number
    depositAddress?: string
    depositMemo?: string
  }
  message?: string
}

/**
 * The catalog, fetched once per SDK instance and memoized. Identifiers are built here rather than
 * hand-composed anywhere else — a cross-chain identifier is only meaningful if it round-trips back
 * to the `assetId` 1Click expects, and this is the single place that mapping lives.
 */
export async function fetchTokens(context: ProviderContext, signal?: AbortSignal): Promise<TokenInfo[]> {
  const res = await httpJson<OneClickToken[]>({
    url: `${context.endpoints.nearOneClickUrl ?? DEFAULT_URL}/v0/tokens`,
    headers: context.credentials.nearApiJwt ? { Authorization: `Bearer ${context.credentials.nearApiJwt}` } : {},
    signal,
    fetch: context.fetch,
    provider: PROVIDER
  })
  if (!res.ok || !Array.isArray(res.data)) {
    throw providerError(PROVIDER, 'unknownApiError', 'token catalog unavailable', {
      status: res.status,
      details: res.data
    })
  }

  return res.data.map((token) => {
    const chain = CHAIN_CODES[token.blockchain] ?? token.blockchain.toUpperCase()
    // Addresses are uppercased in the identifier (matching the catalog convention) while the
    // ticker keeps its case. EVM addresses are hex, so uppercasing is lossless; Stellar issuers
    // are StrKey, which is uppercase by definition.
    const address = token.contractAddress
    return {
      identifier: address ? `${chain}.${token.symbol}-${address.toUpperCase()}` : `${chain}.${token.symbol}`,
      chain,
      chainId: chain.toLowerCase(),
      decimals: token.decimals,
      ticker: token.symbol,
      ...(address ? { address: address.toUpperCase() } : {}),
      ...(token.coingeckoId ? { coingeckoId: token.coingeckoId } : {}),
      extensions: { providerId: token.assetId }
    } satisfies TokenInfo
  })
}

/** Resolve a request identifier against the catalog. Case-insensitive, per catalog convention. */
function findAsset(tokens: TokenInfo[], identifier: string): TokenInfo {
  const wanted = identifier.toLowerCase()
  const token = tokens.find((t) => t.identifier.toLowerCase() === wanted)
  if (!token) {
    throw providerError(PROVIDER, 'tokenNotSupported', `asset ${identifier} is not in the 1Click catalog`, {
      origin: 'local'
    })
  }
  return token
}

export async function getQuote(
  request: ProviderQuoteRequest,
  context: ProviderContext,
  signal?: AbortSignal
): Promise<Route> {
  const tokens = await getCatalog(context, signal)
  const sellToken = findAsset(tokens, request.sellAsset)
  const buyToken = findAsset(tokens, request.buyAsset)

  const sellAmount = request.sellAmount
  const amountBaseUnits = parseUnits(sellAmount, sellToken.decimals).toString()

  if (!request.dry) {
    if (!request.destinationAddress) {
      throw providerError(PROVIDER, 'invalidParams', 'destinationAddress is required for a committed quote', {
        origin: 'local'
      })
    }
    if (!request.refundAddress) {
      throw providerError(PROVIDER, 'invalidParams', 'refundAddress is required for a committed quote', {
        origin: 'local'
      })
    }
  }

  const expiration = new Date(Date.now() + QUOTE_TTL_MS)

  // Stellar-origin deposits share ONE deposit address across quotes and are keyed by memo, so the
  // memo is not optional there — a status lookup without it does not resolve. Other chains get a
  // unique address per quote.
  const depositMode = sellToken.chain === 'XLM' ? 'MEMO' : 'SIMPLE'
  // A NEAR-origin asset that is not native NEAR already lives inside the intents contract.
  const depositType = sellToken.chain === 'NEAR' && sellToken.identifier !== 'NEAR.NEAR' ? 'INTENTS' : 'ORIGIN_CHAIN'

  const feeConfig = context.serviceFees[PROVIDER]
  const appFees =
    feeConfig?.wallet && feeConfig.bps && feeConfig.bps > 0
      ? [{ recipient: feeConfig.wallet, fee: feeConfig.bps }]
      : []

  const res = await httpJson<OneClickQuoteResponse>({
    url: `${context.endpoints.nearOneClickUrl ?? DEFAULT_URL}/v0/quote`,
    method: 'POST',
    headers: context.credentials.nearApiJwt ? { Authorization: `Bearer ${context.credentials.nearApiJwt}` } : {},
    body: {
      dry: request.dry,
      depositMode,
      swapType: 'EXACT_INPUT',
      // 1Click takes slippage in basis points; the request carries percent.
      slippageTolerance: Math.trunc(request.slippage * 100),
      originAsset: sellToken.extensions!.providerId,
      depositType,
      destinationAsset: buyToken.extensions!.providerId,
      amount: amountBaseUnits,
      refundTo: request.refundAddress ?? placeholderAddress(sellToken.chain),
      refundType: 'ORIGIN_CHAIN',
      recipient: request.destinationAddress ?? placeholderAddress(buyToken.chain),
      recipientType: 'DESTINATION_CHAIN',
      deadline: expiration.toISOString(),
      quoteWaitingTimeMs: 0,
      ...(appFees.length ? { appFees } : {})
    },
    signal,
    fetch: context.fetch,
    provider: PROVIDER
  })

  if (!res.ok || !res.data?.quote) {
    // 1Click answers a pair it cannot price with a 400 and a message (an origin chain being down,
    // for instance). Surface it as no-route so the fan-out classifies it like any other decline.
    throw providerError(PROVIDER, res.status === 400 ? 'routeNotFound' : 'unknownApiError', res.data?.message ?? `HTTP ${res.status}`, {
      status: res.status,
      details: res.data
    })
  }
  const quote = res.data.quote

  const fees: Fee[] = []
  if (appFees.length) {
    // 1Click keeps half of the app fee and forwards the rest, so the service line is reported net
    // and 1Click's half as liquidity — the same split convention every other adapter uses, and the
    // reason the service figure can be read as actual revenue.
    const grossBase = (BigInt(quote.amountIn) * BigInt(feeConfig!.bps!)) / 10000n
    const oneClickCut = grossBase / 2n
    fees.push({
      type: 'service',
      chain: sellToken.chain,
      asset: sellToken.identifier,
      amount: formatUnits(grossBase - oneClickCut, sellToken.decimals),
      protocol: PROVIDER
    })
    fees.push({
      type: 'liquidity',
      chain: sellToken.chain,
      asset: sellToken.identifier,
      amount: formatUnits(oneClickCut, sellToken.decimals),
      protocol: PROVIDER
    })
  }

  const estimatedTime = { inbound: 0, swap: quote.timeEstimate, outbound: 0, total: quote.timeEstimate }

  if (request.dry) {
    return makeRoute({
      provider: PROVIDER,
      sellAsset: sellToken.identifier,
      sellAmount,
      buyAsset: buyToken.identifier,
      expectedBuyAmount: quote.amountOutFormatted,
      minBuyAmount: formatUnits(BigInt(quote.minAmountOut), buyToken.decimals),
      fees,
      estimatedTime,
      expiresAt: expiration.getTime()
    })
  }

  if (!quote.depositAddress) {
    throw providerError(PROVIDER, 'unknownApiError', 'committed quote returned no deposit address', {
      details: quote
    })
  }

  return makeRoute({
    provider: PROVIDER,
    sellAsset: sellToken.identifier,
    sellAmount,
    buyAsset: buyToken.identifier,
    expectedBuyAmount: quote.amountOutFormatted,
    minBuyAmount: formatUnits(BigInt(quote.minAmountOut), buyToken.decimals),
    fees,
    estimatedTime,
    expiresAt: expiration.getTime(),
    meta: { near: { depositMemo: quote.depositMemo, sellAsset: sellToken.identifier } },
    execution: makeTransferExecution({
      chain: sellToken.chain,
      depositAddress: quote.depositAddress,
      amount: sellAmount,
      asset: sellToken.identifier,
      ...(quote.depositMemo ? { attachment: { type: 'text', value: quote.depositMemo } } : {}),
      sourceAddress: request.sourceAddress,
      // Only a Stellar-origin deposit can be built here; every other origin chain is the
      // connected wallet's job, and the execution block says so explicitly.
      canBuildTx: sellToken.chain === 'XLM'
    }),
    tracking: trackingNear({
      fromAsset: sellToken.identifier,
      toAsset: buyToken.identifier,
      toAddress: request.destinationAddress!,
      depositAddress: quote.depositAddress,
      ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
      ...(request.sourceAddress ? { fromAddress: request.sourceAddress } : {}),
      fromAmount: sellAmount
    })
  })
}

// The catalog changes rarely and costs a round trip, so it is memoized per context object.
const catalogCache = new WeakMap<ProviderContext, Promise<TokenInfo[]>>()

export async function getCatalog(context: ProviderContext, signal?: AbortSignal): Promise<TokenInfo[]> {
  const cached = catalogCache.get(context)
  if (cached) return cached
  // Cache the PROMISE so concurrent fan-outs share one fetch; drop it on failure so a transient
  // outage doesn't poison the instance for its whole lifetime.
  const pending = fetchTokens(context, signal).catch((err) => {
    catalogCache.delete(context)
    throw err
  })
  catalogCache.set(context, pending)
  return pending
}

/**
 * A syntactically valid burn address per chain, used to fill the required `refundTo`/`recipient`
 * fields on a DRY quote. 1Click validates their format even though a dry quote never uses them.
 */
function placeholderAddress(chain: string): string {
  switch (chain) {
    case 'BTC':
      return 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqthqst8'
    case 'BCH':
      return 'bitcoincash:qznlsyn36euz2ymh3m65n95am8szxdpwagtxgz25t0'
    case 'ADA':
      return 'addr1q8rt33dyrsusl0u05dmj0g5ms3m8nhsgcamrmkum5w3nkcu8r4m30k2hqywcpmfryn7wd0evqualdzcyseegnj2s53kqv647qd'
    case 'DOGE':
      return 'D1111111111111111111BgQR68'
    case 'LTC':
      return 'ltc1q2p64nkkwyrn4hclcrw6png5wz97dz400ru3046'
    case 'NEAR':
      return 'placeholder.near'
    case 'XRP':
      return 'rrrrrrrrrrrrrrrrrrrrrhoLvTp'
    case 'SOL':
      return '11111111111111111111111111111111'
    case 'XLM':
      return 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
    case 'SUI':
      return '0x0000000000000000000000000000000000000000000000000000000000000000'
    case 'TON':
      return 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ'
    case 'TRON':
      return 'TBXS93pVhr1bC1c7U9CPvjxs7wVRgorabE'
    case 'ZEC':
      return 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs'
    default:
      // Every remaining chain in the catalog is EVM-shaped.
      return '0x0000000000000000000000000000000000000000'
  }
}
