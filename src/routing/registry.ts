/**
 * Route discovery — which provider adapters can serve a given pair, and how to reach them.
 *
 * Discovery covers both the provider table and pair classification, and is deliberately separate
 * from both the fan-out (`fanout.ts`, which runs the chosen adapters) and the solver
 * (`../core/selection.ts`, which ranks the routes they return): asking the wrong set of providers
 * and ranking their answers badly are different failures, and keeping them apart is what makes
 * each one testable on its own.
 */

import { tryParseStellarAssetIdentifier } from '../core/assets.js'
import { isThirdPartyRecipient, providersForRecipient } from '../core/selection.js'
import { ProviderGetQuote } from '../providers/types.js'
import { getQuote as aquariusQuote, PROVIDER as AQUARIUS } from '../providers/aquarius/index.js'
import { getQuote as axelarQuote, PROVIDER as AXELAR_ITS } from '../providers/axelar/index.js'
import { findAxelarEntry } from '../providers/axelar/config.js'
import { getQuote as nearQuote, PROVIDER as NEAR } from '../providers/near/index.js'
import { getQuote as soroswapQuote, PROVIDER as SOROSWAP } from '../providers/soroswap/index.js'
import { getQuote as stellarBrokerQuote, PROVIDER as STELLARBROKER } from '../providers/stellarbroker/index.js'
import { getQuote as stellarDexQuote, PROVIDER as STELLAR_DEX } from '../providers/stellardex/index.js'

export interface RegisteredProvider {
  name: string
  getQuote: ProviderGetQuote
}

/** Every adapter this SDK ships, keyed by the provider name that appears on a route. */
export const PROVIDER_REGISTRY: RegisteredProvider[] = [
  { name: STELLARBROKER, getQuote: stellarBrokerQuote },
  { name: SOROSWAP, getQuote: soroswapQuote },
  { name: AQUARIUS, getQuote: aquariusQuote },
  { name: STELLAR_DEX, getQuote: stellarDexQuote },
  { name: NEAR, getQuote: nearQuote },
  { name: AXELAR_ITS, getQuote: axelarQuote }
]

export function providerByName(name: string): RegisteredProvider | undefined {
  return PROVIDER_REGISTRY.find((p) => p.name === name)
}

/** How a pair is routed. Drives which adapters are asked and how the request is shaped. */
export type PairKind = 'stellar' | 'axelar' | 'cross-chain'

export interface DiscoveryInput {
  sellAsset: string
  buyAsset: string
  sourceAddress?: string
  destinationAddress?: string
  /** Explicit override. A caller naming providers has already decided; discovery is skipped. */
  providers?: string[]
}

export interface Discovery {
  kind: PairKind
  /** Provider names to fan out to, in registry order. */
  providers: string[]
  /** True when the pick will be a cross-chain route rather than a Stellar in-chain one. */
  crossChain: boolean
  /** True when the recipient differs from the source, which narrows the Stellar provider set. */
  thirdPartyRecipient: boolean
}

/**
 * Classify a pair and select the providers to ask.
 *
 *  - **Stellar-native** (both assets parse as Stellar identifiers) → the four Stellar providers,
 *    narrowed to the recipient-capable subset when the recipient is a third party.
 *  - **Axelar ITS** (the same token on both sides, one side Stellar, both in the ITS catalog) →
 *    AXELAR_ITS. Checked BEFORE the generic cross-chain fallback, because such a pair is also
 *    cross-chain and would otherwise be routed to NEAR, which cannot bridge it 1:1.
 *  - anything else cross-chain → NEAR.
 */
export function discoverProviders(input: DiscoveryInput): Discovery {
  const axelar = isAxelarPair(input.sellAsset, input.buyAsset)
  const stellarPair =
    !axelar && !!tryParseStellarAssetIdentifier(input.sellAsset) && !!tryParseStellarAssetIdentifier(input.buyAsset)

  const kind: PairKind = axelar ? 'axelar' : stellarPair ? 'stellar' : 'cross-chain'
  const thirdPartyRecipient =
    stellarPair && !!input.sourceAddress && isThirdPartyRecipient(input.sourceAddress, input.destinationAddress)

  let providers: string[]
  if (input.providers && input.providers.length > 0) {
    providers = input.providers
  } else if (axelar) {
    providers = [AXELAR_ITS]
  } else if (stellarPair) {
    // STELLARBROKER and AQUARIUS settle on the trader's own account and cannot pay a different
    // destination, so a third-party recipient narrows the fan-out to the two that can.
    providers = providersForRecipient(thirdPartyRecipient)
  } else {
    providers = [NEAR]
  }

  return { kind, providers, crossChain: kind !== 'stellar', thirdPartyRecipient }
}

/**
 * An Axelar ITS pair: the same ITS asset on two different chains. Resolved against the ITS catalog
 * rather than by parsing chain codes, so a pair is only classified as Axelar when the adapter can
 * actually serve it.
 */
export function isAxelarPair(sellAsset: string, buyAsset: string): boolean {
  const sell = findAxelarEntry(sellAsset)
  const buy = findAxelarEntry(buyAsset)
  if (!sell || !buy) return false
  return sell.asset.symbol === buy.asset.symbol && sell.entry.chain !== buy.entry.chain
}
