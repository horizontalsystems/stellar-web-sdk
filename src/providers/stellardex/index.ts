/**
 * STELLAR_DEX adapter — the native, zero-third-party path: Horizon path-finding over the SDEX
 * order book AND the classic liquidity pools. One adapter covers both because protocol 18
 * path-finding traverses them together; the venue split is not constrainable and is only knowable
 * after the trade.
 *
 * Everything here is client-native: the
 * quote is a Horizon read, and a committed quote builds the `pathPaymentStrictSend` transaction
 * locally. The on-chain `destMin` makes `minBuyAmount` a genuinely enforced floor — the payment
 * fails with `op_under_dest_min` rather than under-delivering.
 */

import { Account, Asset, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { parseStellarAssetIdentifier, toStellarSdkAsset } from '../../core/assets.js'
import { floorAfterSlippage, fromStroops, normalizeStellarAmount, toStroops } from '../../core/amounts.js'
import { Fee, Route } from '../../core/types.js'
import { makeRoute, makeSignedTxExecution, trackingStellar } from '../../routing/route.js'
import { HorizonPathRecord } from '../../stellar/horizon.js'
import { stellarPreflight } from '../../stellar/preflight.js'
import { providerError } from '../http.js'
import { ProviderContext, ProviderQuoteRequest } from '../types.js'

export const PROVIDER = 'STELLAR_DEX'

/**
 * Max fee BID per operation, in stroops. Stellar charges the *effective* fee (usually the
 * 100-stroop minimum), so a generous bid only buys surge-pricing headroom — it is not spent.
 */
const MAX_FEE_STROOPS = '10000' // 0.001 XLM

/** How long the built transaction stays valid. A late fill is safe because destMin is enforced. */
const TX_TIMEOUT_SECONDS = 300

/** A single transaction against one ledger close (~5s). */
const ESTIMATED_TIME = { inbound: 0, swap: 6, outbound: 0, total: 6 }

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

  const sellAmount = normalizeStellarAmount(request.sellAmount)
  const sellAmountRaw = toStroops(sellAmount)

  // Service fee, if configured. This provider builds its own transaction, so the fee needs no
  // protocol hook: it is a second classic `payment` operation in the SAME atomic transaction.
  // The swap leg then trades the NET amount, so the user's total spend is exactly `sellAmount`.
  // A fee is only quoted when a collecting wallet is configured — quoting one we cannot collect
  // would make the dry and committed prices disagree.
  const feeConfig = context.serviceFees[PROVIDER]
  const feeWallet = feeConfig?.wallet
  const serviceBps = feeWallet && feeConfig?.bps && feeConfig.bps > 0 ? feeConfig.bps : 0

  const serviceFeeRaw = (sellAmountRaw * BigInt(serviceBps)) / 10000n
  // Dust guard: below 10000/bps stroops the fee truncates to zero, and a zero-amount payment
  // operation makes the SDK throw on an otherwise legal request. Such sells simply charge nothing.
  // Every downstream gate keys off this, not off `serviceBps`.
  const chargeFee = serviceFeeRaw > 0n
  const swapAmountRaw = sellAmountRaw - serviceFeeRaw
  if (swapAmountRaw <= 0n) {
    throw providerError(PROVIDER, 'amountTooSmall', 'amount too small to cover the service fee', { origin: 'local' })
  }
  const swapAmount = fromStroops(swapAmountRaw)

  const records = await context.horizon.strictSendPaths(
    { sourceAsset: sellAsset, sourceAmount: swapAmount, destinationAsset: buyAsset },
    signal
  )

  const best = pickBestPath(records, context.tunables.stellarDexPathTolerancePct)
  if (!best) {
    throw providerError(
      PROVIDER,
      'routeNotFound',
      `no SDEX/AMM path from ${sellAsset.identifier} to ${buyAsset.identifier}`
    )
  }

  const expectedBuyAmount = best.destination_amount
  // destMin is enforced on-chain — the path payment fails rather than under-deliver.
  const minBuyAmountRaw = floorAfterSlippage(toStroops(expectedBuyAmount), request.slippage)
  const minBuyAmount = fromStroops(minBuyAmountRaw)

  const fees: Fee[] = []
  if (chargeFee) {
    fees.push({
      type: 'service',
      chain: 'XLM',
      asset: sellAsset.identifier,
      amount: fromStroops(serviceFeeRaw),
      protocol: PROVIDER
    })
  }
  // TransactionBuilder's fee is PER OPERATION, so the fee payment doubles the bid.
  const operationCount = chargeFee ? 2 : 1
  fees.push({
    type: 'inbound',
    chain: 'XLM',
    asset: 'XLM.XLM',
    amount: fromStroops(BigInt(MAX_FEE_STROOPS) * BigInt(operationCount)),
    protocol: PROVIDER
  })

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
  const source = request.sourceAddress
  const destination = request.destinationAddress ?? source

  // Both accounts must exist (a path payment cannot create the recipient, native buys included)
  // and the destination must trust a classic buy asset.
  const account = await stellarPreflight(context.horizon, PROVIDER, source, destination, buyAsset)

  const builder = new TransactionBuilder(new Account(source, account.sequence), {
    fee: MAX_FEE_STROOPS,
    networkPassphrase: context.config.networkPassphrase
  }).addOperation(
    Operation.pathPaymentStrictSend({
      sendAsset: toStellarSdkAsset(sellAsset),
      // The NET amount; the fee payment below carries the rest, together exactly `sellAmount`.
      sendAmount: swapAmount,
      destination,
      destAsset: toStellarSdkAsset(buyAsset),
      destMin: minBuyAmount,
      path: best.path.map((hop) =>
        hop.asset_type === 'native' ? Asset.native() : new Asset(hop.asset_code!, hop.asset_issuer!)
      )
    })
  )

  if (chargeFee) {
    // Same atomic transaction: the fee only collects when the swap lands, and vice versa.
    builder.addOperation(
      Operation.payment({
        destination: feeWallet!,
        asset: toStellarSdkAsset(sellAsset),
        amount: fromStroops(serviceFeeRaw)
      })
    )
  }

  const xdr = builder.setTimeout(TX_TIMEOUT_SECONDS).build().toXDR()

  return makeRoute({
    provider: PROVIDER,
    sellAsset: sellAsset.identifier,
    sellAmount,
    buyAsset: buyAsset.identifier,
    expectedBuyAmount,
    minBuyAmount,
    fees,
    estimatedTime: ESTIMATED_TIME,
    expiresAt: Date.now() + TX_TIMEOUT_SECONDS * 1000,
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
 * Prefer ROBUST paths over marginally better exotic ones: among the alternatives, take the one
 * with the FEWEST hops whose output is within `tolerancePct` of the maximum, breaking ties on
 * higher output.
 *
 * Blindly taking the maximum output loses swaps. A path through two thin exotic hops can outbid
 * the direct order book by a hair at quote time and then have its books consumed or pulled in the
 * ~10s before ledger inclusion, landing `op_under_dest_min`, while the direct book stayed above
 * the floor the whole time. Thin-hop quotes evaporate; deep direct books do not. An exotic path
 * still wins when it is better by more than the tolerance.
 */
export function pickBestPath(records: HorizonPathRecord[], tolerancePct: number): HorizonPathRecord | undefined {
  let bestStroops = -1n
  for (const record of records) {
    const stroops = toStroops(record.destination_amount)
    if (stroops > bestStroops) bestStroops = stroops
  }
  if (bestStroops < 0n) return undefined

  // floor(best × (1 − tolerance%)) in integer stroops.
  const toleranceBps = BigInt(Math.round(tolerancePct * 100))
  const threshold = (bestStroops * (10000n - toleranceBps)) / 10000n

  let best: HorizonPathRecord | undefined
  let pickedStroops = -1n
  for (const record of records) {
    const stroops = toStroops(record.destination_amount)
    if (stroops < threshold) continue
    if (
      !best ||
      record.path.length < best.path.length ||
      (record.path.length === best.path.length && stroops > pickedStroops)
    ) {
      best = record
      pickedStroops = stroops
    }
  }
  return best
}

