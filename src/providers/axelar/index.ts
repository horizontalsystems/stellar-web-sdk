/**
 * AXELAR_ITS adapter — Interchain Token Service bridging between Stellar and Ethereum for the
 * classic-Stellar ITS assets (see `config.ts`).
 *
 * Ported from `uswap-server/src/providers/axelar/`. This is a BRIDGE, not a swap: both sides are
 * the same token at 7 decimals, so `expectedBuyAmount` equals `sellAmount` exactly and
 * `minBuyAmount` equals it too — the mint/unlock is deterministic and slippage is inapplicable.
 * Routes therefore only ever appear for a same-asset, cross-chain pair.
 *
 * Costs are ADDITIVE and never deducted from the bridged amount: INBOUND is the source-chain
 * transaction fee, LIQUIDITY is Axelar's cross-chain gas prepayment in the source native asset,
 * quoted by the GMP API and paid inside the same transaction. Unspent prepayment is refunded
 * on-chain by the GasService, which is why the prepayment is deliberately over-provisioned: an
 * underpaid transfer STALLS mid-route until someone tops it up, while excess comes back.
 *
 * There is no service fee. `interchain_transfer` has no fee parameter, an Ethereum EOA transfer is
 * a single call, and a Stellar transaction containing a Soroban operation may contain ONLY that
 * operation — so collecting on either side would require a forwarder contract this SDK does not
 * ship.
 */

import { Account, Address, Asset, Networks, Operation, TransactionBuilder, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk'
import { isStellarAccountId, parseStellarAssetIdentifier } from '../../core/assets.js'
import { formatUnits, fromStroops, normalizeStellarAmount, toStroops } from '../../core/amounts.js'
import { EvmSignedTx, Fee, Route } from '../../core/types.js'
import { makeRoute, replaceInboundFee, trackingAxelar } from '../../routing/route.js'
import { stellarPreflight } from '../../stellar/preflight.js'
import { httpJson, providerError } from '../http.js'
import { ProviderContext, ProviderQuoteRequest } from '../types.js'
import { encodeInterchainTransfer, hexToBytes, toHexQuantity } from './abi.js'
import {
  AXELAR_GMP_CHAIN_NAMES,
  AXELAR_ITS_CHAIN_NAMES,
  DEFAULT_STELLAR_ITS_CONTRACT,
  findAxelarEntry
} from './config.js'

export const PROVIDER = 'AXELAR_ITS'

const DEFAULT_GMP_URL = 'https://api.gmp.axelarscan.io'
const DEFAULT_SOROBAN_RPC = 'https://mainnet.sorobanrpc.com'
const DEFAULT_ETHEREUM_RPC = 'https://ethereum-rpc.publicnode.com'

const TX_TIMEOUT_SECONDS = 300

/** Soroban invoke fee estimate for the dry line; a committed quote replaces it with the real bid. */
const STELLAR_APPROX_FEE_XLM = '0.001'

/**
 * Gas envelope for a token-direct `interchainTransfer` (a burn plus a gateway event, with no
 * approval pull). Observed around 120k on live transfers; 150k covers the variance.
 */
const EVM_TRANSFER_GAS = 150_000n

/**
 * Observed hub-hop timings: a Stellar-source transfer lands in roughly 0.5–3 minutes, while an
 * Ethereum-source transfer waits about 17 minutes for source FINALITY before the hub confirms it.
 */
const TIME_FROM_STELLAR = { inbound: 5, swap: 120, outbound: 15, total: 140 }
const TIME_FROM_ETHEREUM = { inbound: 15, swap: 1080, outbound: 5, total: 1100 }

export async function getQuote(
  request: ProviderQuoteRequest,
  context: ProviderContext,
  signal?: AbortSignal
): Promise<Route> {
  const sell = findAxelarEntry(request.sellAsset)
  const buy = findAxelarEntry(request.buyAsset)
  if (!sell || !buy) {
    throw providerError(
      PROVIDER,
      'tokenNotSupported',
      `${!sell ? request.sellAsset : request.buyAsset} is not an Axelar ITS asset`,
      { origin: 'local' }
    )
  }
  if (sell.asset.symbol !== buy.asset.symbol) {
    throw providerError(
      PROVIDER,
      'pairNotSupported',
      `ITS bridges the same token across chains — ${sell.asset.symbol} cannot become ${buy.asset.symbol}`,
      { origin: 'local' }
    )
  }
  if (sell.entry.chain === buy.entry.chain) {
    throw providerError(PROVIDER, 'pairNotSupported', 'source and destination chains must differ', {
      origin: 'local'
    })
  }

  const sellAmount = normalizeStellarAmount(request.sellAmount)
  const amountRaw = toStroops(sellAmount)
  if (amountRaw <= 0n) {
    throw providerError(PROVIDER, 'amountTooSmall', 'amount is below one stroop', { origin: 'local' })
  }

  const stellarSell = sell.entry.chain === 'XLM'
  const srcGmpChain = AXELAR_GMP_CHAIN_NAMES[sell.entry.chain]!
  const dstGmpChain = AXELAR_GMP_CHAIN_NAMES[buy.entry.chain]!

  const gasFeeRaw = await estimateItsFee(context, srcGmpChain, dstGmpChain, signal)
  const multiplierBps = BigInt(Math.round(Math.max(1, context.tunables.axelarGasMultiplier) * 10000))
  const gasPrepayRaw = (gasFeeRaw * multiplierBps) / 10000n

  const fees: Fee[] = [
    {
      type: 'liquidity',
      chain: stellarSell ? 'XLM' : 'ETH',
      asset: stellarSell ? 'XLM.XLM' : 'ETH.ETH',
      // The prepayment is denominated in the SOURCE chain's native base units: stroops from
      // Stellar (7 dp), wei from Ethereum (18 dp).
      amount: stellarSell ? fromStroops(gasPrepayRaw) : formatUnits(gasPrepayRaw, 18),
      protocol: PROVIDER
    }
  ]

  let evmGasPrice: bigint | undefined
  if (stellarSell) {
    fees.push({ type: 'inbound', chain: 'XLM', asset: 'XLM.XLM', amount: STELLAR_APPROX_FEE_XLM, protocol: PROVIDER })
  } else {
    evmGasPrice = await ethGasPrice(context, signal)
    fees.push({
      type: 'inbound',
      chain: 'ETH',
      asset: 'ETH.ETH',
      amount: formatUnits(evmGasPrice * EVM_TRANSFER_GAS, 18),
      protocol: PROVIDER
    })
  }

  const estimatedTime = stellarSell ? TIME_FROM_STELLAR : TIME_FROM_ETHEREUM

  if (request.dry) {
    return makeRoute({
      provider: PROVIDER,
      sellAsset: sell.entry.identifier,
      sellAmount,
      buyAsset: buy.entry.identifier,
      expectedBuyAmount: sellAmount,
      minBuyAmount: sellAmount,
      fees,
      estimatedTime
    })
  }

  if (!request.sourceAddress || !request.destinationAddress) {
    throw providerError(
      PROVIDER,
      'invalidParams',
      'sourceAddress and destinationAddress are required for a committed quote',
      { origin: 'local' }
    )
  }

  // The on-chain `destination_chain` argument uses the ITS gateway naming, which differs in CASE
  // from the GMP API naming — see AXELAR_ITS_CHAIN_NAMES.
  const dstItsChain = AXELAR_ITS_CHAIN_NAMES[buy.entry.chain]!

  const execution = stellarSell
    ? {
        method: 'signed_transaction' as const,
        chain: 'XLM',
        transactions: [
          {
            kind: 'stellar' as const,
            xdr: await buildStellarTransfer(
              context,
              sell.asset.tokenId,
              request.sourceAddress,
              request.destinationAddress,
              amountRaw,
              gasPrepayRaw,
              dstItsChain,
              fees
            )
          }
        ]
      }
    : {
        method: 'signed_transaction' as const,
        chain: 'ETH',
        transactions: [
          await buildEvmTransfer(
            context,
            sell.entry.erc20!,
            buy,
            request.sourceAddress,
            request.destinationAddress,
            amountRaw,
            gasPrepayRaw,
            evmGasPrice!,
            dstItsChain
          )
        ]
      }

  return makeRoute({
    provider: PROVIDER,
    sellAsset: sell.entry.identifier,
    sellAmount,
    buyAsset: buy.entry.identifier,
    expectedBuyAmount: sellAmount,
    minBuyAmount: sellAmount,
    fees,
    estimatedTime,
    // The Stellar envelope carries its own timebounds; an EVM transaction has no expiry of its own.
    ...(stellarSell ? { expiresAt: Date.now() + TX_TIMEOUT_SECONDS * 1000 } : {}),
    execution,
    tracking: trackingAxelar({
      fromAsset: sell.entry.identifier,
      toAsset: buy.entry.identifier,
      toAddress: request.destinationAddress,
      fromChain: sell.entry.chain,
      toChain: buy.entry.chain,
      fromAddress: request.sourceAddress,
      fromAmount: sellAmount
    })
  })
}

/**
 * The cross-chain gas prepayment for one ITS transfer, in the SOURCE chain's native base units.
 * `estimateITSFee` prices the full hub route (source → Axelar hub → destination).
 */
async function estimateItsFee(
  context: ProviderContext,
  sourceChain: string,
  destinationChain: string,
  signal?: AbortSignal
): Promise<bigint> {
  const res = await httpJson<unknown>({
    url: `${context.endpoints.axelarGmpUrl ?? DEFAULT_GMP_URL}/`,
    method: 'POST',
    // `gasLimit` MUST be a number here — the string form intermittently returns 0.
    body: { method: 'estimateITSFee', sourceChain, destinationChain, gasLimit: 300000 },
    signal,
    fetch: context.fetch,
    provider: PROVIDER
  })
  if (!res.ok) {
    throw providerError(PROVIDER, 'networkError', `estimateITSFee failed (HTTP ${res.status})`, {
      status: res.status,
      details: res.data
    })
  }
  let value: bigint
  try {
    value = BigInt(String(res.data))
  } catch {
    throw providerError(PROVIDER, 'invalidResponseFormat', `estimateITSFee returned ${String(res.data)}`)
  }
  if (value <= 0n) {
    throw providerError(
      PROVIDER,
      'unknownApiError',
      `estimateITSFee returned ${value} for ${sourceChain} -> ${destinationChain}`
    )
  }
  return value
}

/** Current Ethereum gas price via JSON-RPC `eth_gasPrice`. */
async function ethGasPrice(context: ProviderContext, signal?: AbortSignal): Promise<bigint> {
  const res = await httpJson<{ result?: string; error?: { message?: string } }>({
    url: context.endpoints.ethereumRpcUrl ?? DEFAULT_ETHEREUM_RPC,
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] },
    signal,
    fetch: context.fetch,
    provider: PROVIDER
  })
  const result = res.data?.result
  if (!res.ok || typeof result !== 'string') {
    throw providerError(PROVIDER, 'networkError', `eth_gasPrice failed: ${res.data?.error?.message ?? res.status}`, {
      status: res.status
    })
  }
  return BigInt(result)
}

/**
 * Stellar → Ethereum: the ITS `interchain_transfer` Soroban invocation. The destination is the raw
 * 20-byte EVM address, and the XLM gas prepayment rides the optional `gas_token` argument.
 */
async function buildStellarTransfer(
  context: ProviderContext,
  tokenId: string,
  source: string,
  destination: string,
  amountRaw: bigint,
  gasPrepayRaw: bigint,
  dstItsChain: string,
  fees: Fee[]
): Promise<string> {
  if (!isStellarAccountId(source)) {
    throw providerError(PROVIDER, 'invalidParams', 'source address must be a Stellar account (G…)', { origin: 'local' })
  }
  if (!isEvmAddress(destination)) {
    throw providerError(PROVIDER, 'invalidParams', 'destination address must be a valid EVM address', {
      origin: 'local'
    })
  }

  const account = await context.horizon.getAccount(source)
  if (!account) {
    throw providerError(PROVIDER, 'invalidParams', `source account ${source} does not exist`)
  }

  const xlmSac = Asset.native().contractId(Networks.PUBLIC)
  const invoke = Operation.invokeContractFunction({
    contract: context.endpoints.axelarStellarItsContract ?? DEFAULT_STELLAR_ITS_CONTRACT,
    function: 'interchain_transfer',
    args: [
      new Address(source).toScVal(),
      // token_id: BytesN<32>
      xdr.ScVal.scvBytes(Buffer.from(hexToBytes(tokenId))),
      nativeToScVal(dstItsChain, { type: 'string' }),
      // destination_address: the raw 20-byte EVM address, verified against live transfers.
      xdr.ScVal.scvBytes(Buffer.from(hexToBytes(destination))),
      nativeToScVal(amountRaw, { type: 'i128' }),
      // metadata: Option<Bytes> — None
      xdr.ScVal.scvVoid(),
      // gas_token: Option<Token { address, amount }> — Some. Map keys in symbol sort order.
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('address'), val: new Address(xlmSac).toScVal() }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: nativeToScVal(gasPrepayRaw, { type: 'i128' }) })
      ])
    ]
  })

  const tx = new TransactionBuilder(new Account(source, account.sequence), {
    fee: '10000',
    networkPassphrase: context.config.networkPassphrase
  })
    .addOperation(invoke)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build()

  // Simulation is mandatory for Soroban (footprint, auth entries, resource fees); a failure means
  // the transfer would not execute — an insufficient balance, a paused flow — so the quote is
  // abandoned rather than shipping a transaction guaranteed to fail.
  let prepared
  try {
    const server = new rpc.Server(context.endpoints.sorobanRpcUrl ?? DEFAULT_SOROBAN_RPC)
    prepared = await server.prepareTransaction(tx)
  } catch (error) {
    throw providerError(PROVIDER, 'rateExpired', `ITS transfer simulation failed: ${(error as Error).message}`)
  }

  replaceInboundFee(fees, fromStroops(BigInt(prepared.fee)))
  return prepared.toXDR()
}

/**
 * Ethereum → Stellar: a token-direct `interchainTransfer` on the ITS-deployed ERC-20, which burns
 * from the caller and so needs no approval step. The destination is the UTF-8 bytes of the
 * G-address, and `value` is the gas prepayment.
 */
async function buildEvmTransfer(
  context: ProviderContext,
  erc20: string,
  buy: { entry: { identifier: string } },
  source: string,
  destination: string,
  amountRaw: bigint,
  gasPrepayRaw: bigint,
  gasPrice: bigint,
  dstItsChain: string
): Promise<EvmSignedTx> {
  if (!isEvmAddress(source)) {
    throw providerError(PROVIDER, 'invalidParams', 'source address must be a valid EVM address', { origin: 'local' })
  }
  if (!isStellarAccountId(destination)) {
    throw providerError(PROVIDER, 'invalidParams', 'destination address must be a Stellar account (G…)', {
      origin: 'local'
    })
  }

  // Destination-side pre-flight: the account must exist (a mint cannot create it) and must hold
  // the trustline for a classic buy asset such as SHX.
  await stellarPreflight(
    context.horizon,
    PROVIDER,
    destination,
    destination,
    parseStellarAssetIdentifier(buy.entry.identifier)
  )

  return {
    kind: 'evm',
    from: source,
    to: erc20,
    data: encodeInterchainTransfer({
      destinationChain: dstItsChain,
      recipient: new TextEncoder().encode(destination),
      amount: amountRaw
    }),
    value: toHexQuantity(gasPrepayRaw),
    gas: toHexQuantity(EVM_TRANSFER_GAS),
    gasPrice: toHexQuantity(gasPrice)
  }
}

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}
