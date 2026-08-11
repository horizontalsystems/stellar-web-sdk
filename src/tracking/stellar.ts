/**
 * Outcome tracking for the four Stellar-native providers, against Horizon.
 * Ported from `uswap-server/src/providers/stellar/StellarTracker.ts`.
 *
 * The swap is one Stellar transaction whose hash the caller reports after broadcasting (for
 * StellarBroker, the fee-bump hash the session surfaces). The realized output is summed from that
 * transaction's `account_credited` effects for the recipient in the buy asset — which works
 * uniformly across classic path payments AND Soroban SAC transfers, because Horizon surfaces both
 * as effects. Nothing here trusts a claimed amount; only the hash is taken on faith, and Horizon
 * decides the rest.
 *
 * Horizon resolves a fee-bumped transaction by either the outer or the inner hash, so whichever
 * one the caller reports works.
 *
 * StellarBroker caveat: the broker may split one trade over SEVERAL transactions. With a single
 * reported hash the summed output is that transaction's share only, making the tracked amount a
 * LOWER BOUND rather than the full fill. The session result carries the true totals.
 */

import { fromStroops, toStroops } from '../core/amounts.js'
import { RouteTracking, TrackLeg, TrackResponse, TrackStatus } from '../core/types.js'
import { HorizonClient } from '../stellar/horizon.js'

interface HorizonEffect {
  type: string
  account?: string
  asset_type?: string
  asset_code?: string
  asset_issuer?: string
  amount?: string
  paging_token?: string
}

export async function trackStellar(
  horizon: HorizonClient,
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

  // Nothing broadcast yet — there is no transaction to look up.
  if (!hash) {
    return { ...base, status: 'not_started', fromAmount: tracking.fromAmount ?? '' }
  }

  const tx = await horizon.getTransaction(hash, signal)

  // Not indexed yet, or never submitted. Pending rather than failed — a caller polling will see
  // it resolve once the ledger closes.
  if (!tx) {
    return { ...base, status: 'pending', fromAmount: tracking.fromAmount ?? '' }
  }

  if (!tx.successful) {
    const leg: TrackLeg = {
      chainId: 'stellar',
      hash,
      type: 'swap',
      status: 'failed',
      ...base,
      fromAmount: tracking.fromAmount ?? '',
      toAmount: ''
    }
    return { ...base, status: 'failed', fromAmount: tracking.fromAmount ?? '', toAmount: '', legs: [leg] }
  }

  const effects = await horizon.transactionEffects(hash, signal)
  const toAmount = sumEffects(effects, 'account_credited', tracking.toAddress, tracking.toAsset)

  let fromAmount = tracking.fromAmount ?? ''
  if (tracking.fromAddress) {
    const debited = sumEffects(effects, 'account_debited', tracking.fromAddress, tracking.fromAsset)
    if (debited !== '0') fromAmount = debited
  }

  // A successful transaction that decoded zero credits reports completion WITHOUT an amount,
  // rather than a false zero — the credit may have landed under an address or asset form this
  // handle does not describe, and "0 received" would be a stronger claim than the evidence.
  const settled = toAmount === '0' ? '' : toAmount

  const leg: TrackLeg = {
    chainId: 'stellar',
    hash,
    type: 'swap',
    status: 'completed',
    ...base,
    fromAmount,
    toAmount: settled
  }

  return { ...base, status: 'completed', fromAmount, toAmount: settled, legs: [leg] }
}

/**
 * Sum one account's credited or debited effects in a single asset. Amounts are Horizon's 7-dp
 * decimal strings, summed in stroops so the total never goes through a float.
 */
export function sumEffects(
  effects: HorizonEffect[],
  type: string,
  account: string,
  assetIdentifier: string
): string {
  // `XLM.CODE-GISSUER…` → code + issuer; `XLM.XLM` → native.
  const body = assetIdentifier.slice(assetIdentifier.indexOf('.') + 1)
  const dash = body.indexOf('-')
  const code = dash > 0 ? body.slice(0, dash) : body
  const issuer = dash > 0 ? body.slice(dash + 1) : ''
  const isNative = code.toUpperCase() === 'XLM' && !issuer

  let stroops = 0n
  for (const effect of effects) {
    if (effect.type !== type || effect.account !== account || !effect.amount) continue
    const matches = isNative
      ? effect.asset_type === 'native'
      : effect.asset_code === code && effect.asset_issuer === issuer
    if (!matches) continue
    stroops += toStroops(effect.amount)
  }

  return fromStroops(stroops)
}

/** Terminal Stellar statuses, for a caller deciding whether to keep polling. */
export const STELLAR_TERMINAL: readonly TrackStatus[] = ['completed', 'failed']
