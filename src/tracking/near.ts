/**
 * Outcome tracking for NEAR, against 1Click's own status endpoint.
 * Ported from `uswap-server/src/providers/near/NearTracker.ts`.
 *
 * A cross-chain swap is not one transaction, so it is reported as three legs — the deposit on the
 * origin chain, the swap on NEAR, and the payout on the destination chain — each with its own hash
 * and status as 1Click reports them.
 *
 * The swap is keyed by deposit address, plus the memo on MEMO-mode chains (Stellar among them),
 * where 1Click shares one deposit address across quotes and a lookup without the memo does not
 * resolve.
 */

import { RouteTracking, TrackLeg, TrackResponse, TrackStatus } from '../core/types.js'
import { httpJson } from '../providers/http.js'
import { ProviderContext } from '../providers/types.js'

const DEFAULT_URL = 'https://1click.chaindefuser.com'

interface OneClickStatusResponse {
  status?: string
  quoteResponse?: {
    quoteRequest?: { originAsset?: string; destinationAsset?: string; recipient?: string }
    quote?: { amountInUsd?: string }
  }
  swapDetails?: {
    amountInFormatted?: string
    depositedAmountFormatted?: string
    amountOutFormatted?: string
    nearTxHashes?: string[]
    originChainTxHashes?: { hash: string }[]
    destinationChainTxHashes?: { hash: string }[]
  }
  message?: string
}

/** 1Click's execution status → the SDK's status vocabulary. */
function toTrackStatus(status: string | undefined): TrackStatus {
  switch (status) {
    case 'KNOWN_DEPOSIT_TX':
    case 'INCOMPLETE_DEPOSIT':
      return 'pending'
    case 'PENDING_DEPOSIT':
      return 'not_started'
    case 'PROCESSING':
      return 'swapping'
    case 'SUCCESS':
      return 'completed'
    case 'REFUNDED':
      return 'refunded'
    case 'FAILED':
      return 'failed'
    default:
      return 'unknown'
  }
}

export async function trackNear(
  context: ProviderContext,
  tracking: RouteTracking,
  hash: string | undefined,
  signal?: AbortSignal
): Promise<TrackResponse> {
  const base = {
    providers: [tracking.provider],
    fromAsset: tracking.fromAsset,
    toAsset: tracking.toAsset,
    toAddress: tracking.toAddress,
    ...(tracking.fromAddress ? { fromAddress: tracking.fromAddress } : {})
  }

  if (!tracking.depositAddress) {
    return { ...base, status: 'unknown', fromAmount: tracking.fromAmount ?? '' }
  }

  const res = await httpJson<OneClickStatusResponse>({
    url: `${context.endpoints.nearOneClickUrl ?? DEFAULT_URL}/v0/status`,
    query: {
      depositAddress: tracking.depositAddress,
      ...(tracking.depositMemo ? { depositMemo: tracking.depositMemo } : {})
    },
    headers: context.credentials.nearApiJwt ? { Authorization: `Bearer ${context.credentials.nearApiJwt}` } : {},
    signal,
    fetch: context.fetch,
    provider: 'NEAR'
  })

  // 404 means 1Click has not seen a deposit for this address yet — the swap simply has not
  // started, which is a status rather than an error.
  if (res.status === 404) {
    return { ...base, status: 'not_started', fromAmount: tracking.fromAmount ?? '' }
  }
  if (!res.ok || !res.data) {
    return { ...base, status: 'unknown', fromAmount: tracking.fromAmount ?? '' }
  }

  const body = res.data
  const details = body.swapDetails ?? {}
  const status = toTrackStatus(body.status)

  const fromAmount = details.amountInFormatted ?? details.depositedAmountFormatted ?? tracking.fromAmount ?? ''
  // Only 1Click's SETTLED amount is reported. Falling back to the quote-time figure would
  // fabricate a delivered amount for a swap that never delivered — an expired, refunded or
  // not-yet-started one. An empty string means "no amount yet".
  const toAmount = details.amountOutFormatted ?? ''
  const toAddress = body.quoteResponse?.quoteRequest?.recipient ?? tracking.toAddress

  const nearTxHashes = details.nearTxHashes ?? []
  const originHashes = details.originChainTxHashes ?? []
  const destinationHashes = details.destinationChainTxHashes ?? []
  const inboundCompleted = nearTxHashes.length > 0

  const legs: TrackLeg[] = [
    {
      hash: originHashes.length > 0 ? originHashes[originHashes.length - 1]!.hash : (hash ?? ''),
      type: 'native_send',
      status: inboundCompleted ? 'completed' : 'not_started',
      fromAsset: tracking.fromAsset,
      fromAmount,
      ...(tracking.fromAddress ? { fromAddress: tracking.fromAddress } : {}),
      toAsset: tracking.fromAsset,
      toAmount: fromAmount,
      toAddress: tracking.depositAddress
    },
    {
      chainId: 'near',
      hash: inboundCompleted ? nearTxHashes[nearTxHashes.length - 1]! : '',
      type: 'swap',
      status: inboundCompleted ? status : 'not_started',
      fromAsset: tracking.fromAsset,
      fromAmount,
      toAsset: tracking.toAsset,
      toAmount,
      toAddress
    },
    {
      hash: destinationHashes.length > 0 ? destinationHashes[destinationHashes.length - 1]!.hash : '',
      type: 'native_send',
      status: destinationHashes.length > 0 ? 'completed' : 'not_started',
      fromAsset: tracking.toAsset,
      fromAmount: toAmount,
      toAsset: tracking.toAsset,
      toAmount,
      toAddress
    }
  ]

  const usd = body.quoteResponse?.quote?.amountInUsd

  return {
    ...base,
    status,
    fromAmount,
    toAmount,
    toAddress,
    legs,
    ...(usd ? { meta: { sellAmountUsd: usd } } : {})
  }
}
