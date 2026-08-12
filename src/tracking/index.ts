/**
 * Outcome tracking — reading a committed swap's real outcome from its source of truth.
 *
 * Each provider is followed wherever its truth actually lives: the four Stellar-native providers
 * against Horizon, NEAR against 1Click's status endpoint, Axelar ITS against the Axelarscan GMP
 * API. These are public sources: an outcome is always read from the chain or the venue, never
 * from a record the SDK keeps.
 *
 * The one thing a server does that a page cannot is keep polling after the page is gone. A caller
 * that needs that — for a cross-chain route settling minutes later — should persist the route's
 * `tracking` handle and resume polling on the next visit.
 */

import { StellarSwapError } from '../core/errors.js'
import { RouteTracking, TrackResponse } from '../core/types.js'
import { ProviderContext } from '../providers/types.js'
import { HorizonClient } from '../stellar/horizon.js'
import { trackAxelar } from './axelar.js'
import { trackNear } from './near.js'
import { trackStellar } from './stellar.js'

export { trackStellar, sumEffects } from './stellar.js'
export { trackNear } from './near.js'
export { trackAxelar } from './axelar.js'

const STELLAR_NATIVE = ['STELLARBROKER', 'SOROSWAP', 'AQUARIUS', 'STELLAR_DEX']

/**
 * Read the current outcome of a committed route.
 *
 * `inboundTxHash` is the broadcast transaction hash where the provider is keyed by one — every
 * Stellar-native provider, and Axelar's source-chain transaction. NEAR is keyed by its deposit
 * address instead and needs no hash, so tracking a NEAR route works before anything is sent.
 */
export async function trackRoute(
  tracking: RouteTracking,
  inboundTxHash: string | undefined,
  context: ProviderContext,
  horizon: HorizonClient,
  signal?: AbortSignal
): Promise<TrackResponse> {
  if (STELLAR_NATIVE.includes(tracking.provider)) {
    return trackStellar(horizon, tracking, inboundTxHash, signal)
  }
  if (tracking.provider === 'NEAR') {
    return trackNear(context, tracking, inboundTxHash, signal)
  }
  if (tracking.provider === 'AXELAR_ITS') {
    return trackAxelar(context, tracking, inboundTxHash, signal)
  }
  throw new StellarSwapError('invalid_params', `No tracker for provider ${tracking.provider}`)
}
