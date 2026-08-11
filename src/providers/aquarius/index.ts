/**
 * AQUARIUS adapter — the Soroban AMM (volatile + stable pools) on Stellar.
 *
 * Ported from `uswap-server/src/providers/aquarius/`. `POST /find-path/` returns a ready
 * `swap_chain_xdr` — which is the `swaps_chain` ARGUMENT, not a transaction. A committed quote
 * assembles the `swap_chained(user, swaps_chain, token_in, in_amount, out_min)` invocation itself,
 * simulates it over Soroban RPC (mandatory: simulation is what injects the footprint, the auth
 * entries and the resource fees), and returns the prepared envelope. `out_min` is enforced
 * on-chain, so `minBuyAmount` is a real floor — computed by us from the quote and the requested
 * slippage rather than taken from the API.
 */

import { Account, Address, Networks, Operation, TransactionBuilder, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk'
import { parseStellarAssetIdentifier, sacContractId } from '../../core/assets.js'
import {
  apiAmountToStroops,
  floorAfterSlippage,
  fromStroops,
  normalizeStellarAmount,
  toStroops
} from '../../core/amounts.js'
import { Fee, Route } from '../../core/types.js'
import { makeRoute, makeSignedTxExecution, replaceInboundFee, trackingStellar } from '../../routing/route.js'
import { stellarPreflight } from '../../stellar/preflight.js'
import { httpJson, providerError } from '../http.js'
import { ProviderContext, ProviderQuoteRequest } from '../types.js'

export const PROVIDER = 'AQUARIUS'

const DEFAULT_URL = 'https://amm-api.aqua.network/api/external/v2'
const DEFAULT_SOROBAN_RPC = 'https://mainnet.sorobanrpc.com'

/** The Aquarius AMM router — `swap_chained` lives here. */
const DEFAULT_ROUTER = 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK'

/** A Soroban invoke with up to 4 pool hops; resource fees dominate. The prepared tx has the real one. */
const APPROX_FEE_XLM = '0.001'

const TX_TIMEOUT_SECONDS = 300
const ESTIMATED_TIME = { inbound: 0, swap: 6, outbound: 0, total: 6 }

/** Always HTTP 200 — `success: false` with zeroed fields is how "no route" arrives. */
interface AquariusSwapOutput {
  success: boolean
  /** base64 XDR of the `swaps_chain` argument — feed straight into `swap_chained`, never rebuild. */
  swap_chain_xdr: string
  pools: string[]
  tokens: string[]
  tokens_addresses: string[]
  /** Estimated GROSS output (strict-send), base units. */
  amount: number | string
  /** `amount` adjusted for `provider_fee`. See the note below on why this is NOT the net. */
  amount_with_fee: number | string
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

  // Aquarius quotes and invokes with Soroban contract ids; classic assets ride their SAC wrapper.
  const tokenIn = sacContractId(sellAsset, Networks.PUBLIC)
  const tokenOut = sacContractId(buyAsset, Networks.PUBLIC)

  const sellAmount = normalizeStellarAmount(request.sellAmount)
  const sellAmountRaw = toStroops(sellAmount)

  // A service fee here needs OUR OWN wrapper contract: the Aquarius router has no fee parameter at
  // all. A `ProviderSwapFeeCollector` is deployed once via their factory, and the committed swap
  // then invokes the COLLECTOR's 6-argument `swap_chained` instead of the router's 5-argument one.
  // Sending `provider_fee` on find-path alone collects NOTHING — it only makes routing account for
  // the cut. So the collector address is the single arming switch: unset ⇒ plain router, no fee.
  const feeConfig = context.serviceFees[PROVIDER]
  const feeCollector = feeConfig?.feeCollectorContract
  const serviceBps = feeCollector && feeConfig?.bps && feeConfig.bps > 0 ? feeConfig.bps : 0

  const res = await httpJson<AquariusSwapOutput>({
    url: `${context.endpoints.aquariusUrl ?? DEFAULT_URL}/find-path/`,
    method: 'POST',
    body: {
      token_in_address: tokenIn,
      token_out_address: tokenOut,
      amount: String(sellAmountRaw),
      // A fraction with at most 6 fractional digits. This influences routing only; the enforced
      // limit is `out_min` below.
      slippage: (request.slippage / 100).toFixed(6),
      ...(serviceBps > 0 ? { provider_fee: (serviceBps / 10000).toFixed(6) } : {})
    },
    signal,
    fetch: context.fetch,
    provider: PROVIDER
  })

  const path = res.data
  if (!res.ok || !path?.success) {
    throw providerError(
      PROVIDER,
      'routeNotFound',
      `no route from ${sellAsset.identifier} to ${buyAsset.identifier}`,
      { status: res.status, details: path }
    )
  }

  const grossOutRaw = apiAmountToStroops(path.amount)
  // `amount` is the GROSS route output: it equals the router-to-collector transfer to the stroop,
  // and the collector then keeps exactly `fee_fraction` of it. So the user's net is simply
  // gross × (1 − bps).
  //
  // Do NOT use `amount_with_fee` for this. It empirically sits about two fees below `amount`
  // (Aquarius documents it only as "amount adjusted for provider_fee"), so treating it as the net
  // under-quotes every route by a whole fee and over-reports the fee actually earned by ~2x. The
  // contract is the source of truth, and it charges once.
  const netOutRaw = serviceBps > 0 ? (grossOutRaw * BigInt(10000 - serviceBps)) / 10000n : grossOutRaw
  // Our slippage guard: `swap_chained` reverts if the realized output is below `out_min`.
  const outMinRaw = floorAfterSlippage(netOutRaw, request.slippage)

  const expectedBuyAmount = fromStroops(netOutRaw)
  const minBuyAmount = fromStroops(outMinRaw)

  const fees: Fee[] = []
  if (serviceBps > 0 && netOutRaw < grossOutRaw) {
    fees.push({
      type: 'service',
      chain: 'XLM',
      // Output-side fee, so it is denominated in the BUY asset.
      asset: buyAsset.identifier,
      amount: fromStroops(grossOutRaw - netOutRaw),
      protocol: PROVIDER
    })
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
  // `swap_chained` pays out to `user` — the signer — so a third-party recipient is impossible.
  if (request.destinationAddress && request.destinationAddress !== request.sourceAddress) {
    throw providerError(
      PROVIDER,
      'invalidParams',
      'Aquarius settles on the trader account; destination must equal source',
      { origin: 'local' }
    )
  }
  const source = request.sourceAddress

  const account = await stellarPreflight(context.horizon, PROVIDER, source, source, buyAsset)

  // With a fee, call OUR collector's `swap_chained` — the same five arguments plus `fee_fraction`
  // (basis points in the collector's deploy-time denominator, pinned to 10000 so this is the
  // configured bps verbatim). Without one, the plain router with five arguments.
  const invoke = Operation.invokeContractFunction({
    contract: serviceBps > 0 ? feeCollector! : context.endpoints.aquariusRouterContract ?? DEFAULT_ROUTER,
    function: 'swap_chained',
    args: [
      new Address(source).toScVal(),
      // The API's base64 XDR decodes STRAIGHT into the swaps_chain ScVal — never rebuild it.
      xdr.ScVal.fromXDR(path.swap_chain_xdr, 'base64'),
      new Address(tokenIn).toScVal(),
      nativeToScVal(sellAmountRaw, { type: 'u128' }),
      nativeToScVal(outMinRaw, { type: 'u128' }),
      ...(serviceBps > 0 ? [nativeToScVal(serviceBps, { type: 'u32' })] : [])
    ]
  })

  const tx = new TransactionBuilder(new Account(source, account.sequence), {
    fee: '10000',
    networkPassphrase: context.config.networkPassphrase
  })
    .addOperation(invoke)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build()

  // Simulation is MANDATORY for Soroban: `prepareTransaction` injects the footprint, the auth
  // entries and the resource fees. A simulation failure means the route would not execute, so the
  // quote is abandoned rather than shipping a transaction guaranteed to fail.
  let prepared
  try {
    const server = new rpc.Server(context.endpoints.sorobanRpcUrl ?? DEFAULT_SOROBAN_RPC)
    prepared = await server.prepareTransaction(tx)
  } catch (error) {
    throw providerError(PROVIDER, 'rateExpired', `route simulation failed: ${(error as Error).message}`)
  }

  // The prepared transaction carries the real resource-inclusive fee bid — replace the estimate.
  replaceInboundFee(fees, fromStroops(BigInt(prepared.fee)))

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
    execution: makeSignedTxExecution({ chain: 'XLM', xdr: prepared.toXDR() }),
    tracking: trackingStellar({
      provider: PROVIDER,
      fromAsset: sellAsset.identifier,
      toAsset: buyAsset.identifier,
      toAddress: source,
      fromAddress: source,
      fromAmount: sellAmount
    })
  })
}
