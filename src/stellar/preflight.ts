/**
 * Committed-quote account pre-flight, shared by every Stellar-settling adapter.
 *
 * The point is to convert three failures that would otherwise surface late — mid-WebSocket
 * session, or as an on-chain revert AFTER the user has confirmed and signed — into a clean
 * client-side error before anything is built or handed over.
 */

import { StellarAsset, isNativeAsset } from '../core/assets.js'
import { ProviderQuoteError } from '../providers/types.js'
import { HorizonAccount, HorizonClient, accountHoldsTrustline } from './horizon.js'

/**
 * Verify, before building or handing off anything, that:
 *
 *  1. the SOURCE account exists — builders need its sequence number, and StellarBroker would
 *     otherwise fail deep inside the session;
 *  2. the DESTINATION account exists — including for native XLM buys, because neither a path
 *     payment nor a SAC transfer can create the recipient account;
 *  3. for a classic buy asset, the destination holds its trustline — otherwise the swap reverts
 *     with `op_no_trust`.
 *
 * Returns the SOURCE account so a builder can reuse its sequence without a second read. When
 * destination === source (StellarBroker and Aquarius always; the default elsewhere) this costs
 * exactly one Horizon read.
 */
export async function stellarPreflight(
  horizon: HorizonClient,
  provider: string,
  source: string,
  destination: string,
  buyAsset: StellarAsset
): Promise<HorizonAccount> {
  const account = await horizon.getAccount(source)
  if (!account) {
    throw new ProviderQuoteError('invalidParams', `${provider}: source account ${source} does not exist`, { provider })
  }

  const destAccount = destination === source ? account : await horizon.getAccount(destination)
  if (!destAccount) {
    throw new ProviderQuoteError('invalidParams', `${provider}: destination account ${destination} does not exist`, {
      provider
    })
  }

  if (!isNativeAsset(buyAsset) && !accountHoldsTrustline(destAccount, buyAsset)) {
    throw new ProviderQuoteError(
      'invalidParams',
      `${provider}: destination account has no trustline for ${buyAsset.identifier}`,
      { provider }
    )
  }

  return account
}
