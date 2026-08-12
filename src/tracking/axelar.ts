/**
 * Outcome tracking for an Axelar ITS transfer, against the Axelarscan GMP API.
 *
 * Stellar ITS runs in HUB mode, so one user transfer produces TWO GMP records: source → Axelar
 * (hop 1), then Axelar → destination (hop 2). Searching by the user's source transaction hash
 * returns hop 1; its `callback.transactionHash` is the hub transaction that keys hop 2, whose
 * `executed.transactionHash` is the delivery on the far side. Completion means hop 2 executed —
 * hop 1 executing only means the transfer reached the hub, not that anything was delivered.
 *
 * Stuck-gas states map to `action_required` rather than failure: an underpaid transfer is paused,
 * not lost, and anyone can top up the gas through Axelarscan's recovery flow. A hub error is also
 * `action_required` — the funds have left the source chain and ITS has no refund path, so recovery
 * is always re-execution. Neither is ever auto-reported as failed.
 */

import { apiAmountToStroops, formatUnits, fromStroops } from '../core/amounts.js'
import { RouteTracking, TrackLeg, TrackResponse, TrackStatus } from '../core/types.js'
import { httpJson } from '../providers/http.js'
import { ProviderContext } from '../providers/types.js'

const DEFAULT_GMP_URL = 'https://api.gmp.axelarscan.io'

/** A GMP record, narrowed to the fields tracking reads. */
interface GmpRecord {
  status?: string
  simplified_status?: string
  is_insufficient_fee?: boolean
  not_enough_gas_to_execute?: boolean
  call?: { chain?: string; transactionHash?: string; returnValues?: { destinationChain?: string } }
  executed?: { chain?: string; transactionHash?: string }
  /** Hub-mode linkage: the ITS Hub emits the second hop from this Axelar-chain transaction. */
  callback?: { chain?: string; transactionHash?: string }
  interchain_transfer?: { symbol?: string; amount?: number | string; decimals?: number; destinationAddress?: string }
  value?: number
}

export async function trackAxelar(
  context: ProviderContext,
  tracking: RouteTracking,
  hash: string | undefined,
  signal?: AbortSignal
): Promise<TrackResponse> {
  if (!hash) return build(tracking, 'not_started', undefined, undefined, undefined)

  const records = await searchGmp(context, hash, signal)
  if (!records) return build(tracking, 'unknown', hash, undefined, undefined)

  // Hop 1 is the record whose CALL transaction is ours. `searchGMP` also matches records by their
  // executed hash, so this must filter rather than take the first. Hash forms differ per chain —
  // 0x-prefixed lowercase on EVM, bare uppercase on Stellar — so they are compared normalized.
  const hop1 = records.find((r) => sameHash(r.call?.transactionHash, hash))
  if (!hop1) {
    // Not indexed by Axelar yet; the transaction may still be in flight on the source chain.
    return build(tracking, 'pending', hash, undefined, undefined)
  }

  // Axelarscan returns `value: 0` on a large share of records — zero means "not priced", not a
  // zero-value transfer, so it is dropped rather than reported.
  const usd = typeof hop1.value === 'number' && Number.isFinite(hop1.value) && hop1.value > 0 ? hop1.value : undefined

  const stuck1 = stuckReason(hop1)
  if (stuck1) return build(tracking, 'action_required', hash, undefined, usd, stuck1)
  if (!executed(hop1)) return build(tracking, 'swapping', hash, undefined, usd)

  const hubTx = hop1.callback?.transactionHash
  if (!hubTx) return build(tracking, 'swapping', hash, undefined, usd)

  const hubRecords = await searchGmp(context, hubTx, signal)
  if (!hubRecords) return build(tracking, 'swapping', hash, undefined, usd)

  // The hub transaction's own record is the one whose call it is AND whose destination is the
  // final chain — hop 1 reappears here matched by its executed hash.
  const hop2 = hubRecords.find(
    (r) => sameHash(r.call?.transactionHash, hubTx) && r.call?.returnValues?.destinationChain !== 'axelar'
  )
  if (!hop2) return build(tracking, 'swapping', hash, undefined, usd)

  const stuck2 = stuckReason(hop2)
  if (stuck2) return build(tracking, 'action_required', hash, undefined, usd, stuck2)
  if (!executed(hop2)) return build(tracking, 'swapping', hash, undefined, usd)

  return build(tracking, 'completed', hash, hop2, usd)
}

async function searchGmp(
  context: ProviderContext,
  txHash: string,
  signal?: AbortSignal
): Promise<GmpRecord[] | undefined> {
  const res = await httpJson<{ data?: GmpRecord[] }>({
    url: `${context.endpoints.axelarGmpUrl ?? DEFAULT_GMP_URL}/`,
    method: 'POST',
    body: { method: 'searchGMP', txHash },
    signal,
    fetch: context.fetch,
    provider: 'AXELAR_ITS'
  }).catch(() => undefined)

  if (!res?.ok) return undefined
  return Array.isArray(res.data?.data) ? res.data.data : []
}

function executed(r: GmpRecord): boolean {
  return r.status === 'executed' || r.status === 'express_executed'
}

/** Non-terminal blocked states that need a human — a gas top-up or a re-execution via Axelarscan. */
function stuckReason(r: GmpRecord): string | undefined {
  if (r.status === 'insufficient_fee' || r.is_insufficient_fee || r.not_enough_gas_to_execute) {
    return 'insufficient_gas'
  }
  if (r.status === 'error') return 'provider_error'
  return undefined
}

function sameHash(a?: string, b?: string): boolean {
  if (!a || !b) return false
  return a.toLowerCase().replace(/^0x/, '') === b.toLowerCase().replace(/^0x/, '')
}

function build(
  tracking: RouteTracking,
  status: TrackStatus,
  hash: string | undefined,
  hop2: GmpRecord | undefined,
  sellAmountUsd: number | undefined,
  pauseReason?: string
): TrackResponse {
  // The delivered amount comes from the ITS decoration on the final hop, in base units scaled by
  // the payload's OWN `decimals` rather than a hardcoded 7. Every ITS asset configured today is
  // 7-dp, but reading the field keeps the figure honest if a non-7dp asset is ever added — a
  // silent factor-of-ten error here would be reported as fact rather than throwing.
  let toAmount = ''
  if (hop2?.interchain_transfer?.amount != null) {
    try {
      const raw = apiAmountToStroops(hop2.interchain_transfer.amount)
      const decimals = typeof hop2.interchain_transfer.decimals === 'number' ? hop2.interchain_transfer.decimals : 7
      toAmount = decimals === 7 ? fromStroops(raw) : formatUnits(raw, decimals)
    } catch {
      toAmount = tracking.fromAmount ?? ''
    }
  }

  const fromAmount = tracking.fromAmount ?? ''

  // Two legs, source deposit then destination delivery. The source leg is confirmed the moment
  // Axelar has indexed the call.
  const legs: TrackLeg[] = [
    {
      chainId: tracking.fromChain?.toLowerCase(),
      hash: hash ?? '',
      type: 'native_send',
      status: status === 'pending' || status === 'not_started' ? status : 'completed',
      fromAsset: tracking.fromAsset,
      fromAmount,
      ...(tracking.fromAddress ? { fromAddress: tracking.fromAddress } : {}),
      toAsset: tracking.fromAsset,
      toAmount: fromAmount,
      // The source-side recipient is the ITS contract performing the burn or lock, not an account.
      toAddress: ''
    },
    {
      chainId: tracking.toChain?.toLowerCase(),
      hash: hop2?.executed?.transactionHash ?? '',
      type: 'native_send',
      status: status === 'completed' ? 'completed' : 'not_started',
      fromAsset: tracking.toAsset,
      fromAmount: toAmount,
      // The destination sender is the ITS executable performing the mint or unlock.
      fromAddress: '',
      toAsset: tracking.toAsset,
      toAmount,
      toAddress: tracking.toAddress
    }
  ]

  return {
    status,
    providers: [tracking.provider],
    fromAsset: tracking.fromAsset,
    fromAmount,
    ...(tracking.fromAddress ? { fromAddress: tracking.fromAddress } : {}),
    toAsset: tracking.toAsset,
    toAmount,
    toAddress: tracking.toAddress,
    legs,
    ...(pauseReason || sellAmountUsd != null
      ? {
          meta: {
            ...(pauseReason ? { pauseReason } : {}),
            ...(sellAmountUsd != null ? { sellAmountUsd: String(sellAmountUsd) } : {})
          }
        }
      : {})
  }
}
