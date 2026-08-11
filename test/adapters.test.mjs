/**
 * The six provider adapters, driven offline against stub upstreams.
 *
 * These are the funded components — quote fetching, normalization and route construction — so the
 * assertions deliberately cover both directions: what each adapter SENDS upstream (units, asset
 * encodings, venue lists) and what it MAKES of the response (net amounts, enforced floors, fee
 * lines, error mapping). The venue-specific corrections carried over from the server are asserted
 * individually, since each of them changes which route selection sees.
 */

import { TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import {
  quoteStellarBroker,
  quoteSoroswap,
  quoteAquarius,
  quoteStellarDex,
  quoteNear,
  quoteAxelar
} from '../dist/index.js'
import { httpJson } from '../dist/providers/http.js'
import {
  harness, stubFetch, stubHorizon, fundedAccount, context, req,
  USDC, XLM, USDC_ISSUER, TRADER, OTHER
} from './helpers.mjs'

const t = harness()

// ---------------------------------------------------------------------------
t.section('STELLARBROKER')
// ---------------------------------------------------------------------------
{
  const okQuote = { status: 'success', estimatedBuyingAmount: '16.3576019', sellingAmount: '100' }

  const fetch = stubFetch([['api.stellar.broker', { json: okQuote }]])
  const route = await quoteStellarBroker(req(), context({ fetch }))

  t.ok('returns the broker estimate', route.expectedBuyAmount === '16.3576019')
  // The one Stellar provider with no on-chain floor: the broker re-quotes live in-session, so
  // there is nothing client-verifiable to promise — it is what a caller filters on to require a
  // guaranteed floor rather than the highest estimate.
  t.ok('minBuyAmount is null, not an amount', route.minBuyAmount === null)
  t.ok('names itself as the provider', route.providers[0] === 'STELLARBROKER')
  t.ok('a dry quote carries no execution', route.execution === undefined)

  const sent = new URL(fetch.calls[0].url)
  // The request carries slippage as a percent; the broker wants a fraction.
  t.ok('slippage percent → fraction', sent.searchParams.get('slippageTolerance') === '0.01')
  t.ok('assets use SB wire form (no XLM. prefix)', sent.searchParams.get('sellingAsset') === 'XLM')
  t.ok('classic asset as CODE-ISSUER', sent.searchParams.get('buyingAsset') === `USDC-${USDC_ISSUER}`)

  // Slippage is capped at the broker's maximum.
  const capped = stubFetch([['api.stellar.broker', { json: okQuote }]])
  await quoteStellarBroker(req({ slippage: 90 }), context({ fetch: capped }))
  t.ok('slippage fraction caps at 0.5', new URL(capped.calls[0].url).searchParams.get('slippageTolerance') === '0.5')

  // A non-success status is a 200 with an `error` field, and the two statuses mean different things.
  await t.throws('unfeasible → routeNotFound',
    () => quoteStellarBroker(req(), context({ fetch: stubFetch([['stellar.broker', { json: { status: 'unfeasible', error: 'no path' } }]]) })),
    (e) => e.quoteCode === 'routeNotFound' && e.message.includes('no path'))
  await t.throws('rejected → unknownApiError',
    () => quoteStellarBroker(req(), context({ fetch: stubFetch([['stellar.broker', { json: { status: 'rejected', error: 'nope' } }]]) })),
    (e) => e.quoteCode === 'unknownApiError')

  await t.throws('identical assets decline locally',
    () => quoteStellarBroker(req({ buyAsset: XLM }), context({ fetch })),
    (e) => e.quoteCode === 'pairNotSupported' && e.origin === 'local')

  // Committing without a partner key must fail HERE, not mid-session after the user confirmed.
  const committed = { ...req(), dry: false, sourceAddress: TRADER }
  await t.throws('commit without a partner key is refused up front',
    () => quoteStellarBroker(committed, context({ fetch, horizon: stubHorizon({ account: fundedAccount() }) })),
    (e) => e.quoteCode === 'invalidParams' && /partner key/.test(e.message))

  await t.throws('commit rejects a third-party recipient',
    () => quoteStellarBroker(
      { ...committed, destinationAddress: OTHER },
      context({ fetch, credentials: { stellarBrokerPartnerKey: 'k' }, horizon: stubHorizon({ account: fundedAccount() }) })
    ),
    (e) => /trader account/.test(e.message))

  const live = await quoteStellarBroker(
    committed,
    context({
      fetch: stubFetch([['stellar.broker', { json: okQuote }]]),
      credentials: { stellarBrokerPartnerKey: 'partner-123' },
      horizon: stubHorizon({ account: fundedAccount() })
    })
  )
  t.ok('committed route is a session, not a transaction', live.execution.method === 'stellar_broker')
  t.ok('session carries the partner key', live.execution.partnerKey === 'partner-123')
  t.ok('session slippage is the fraction', live.execution.slippageTolerance === 0.01)
  t.ok('tracking handle names the trader on both sides',
    live.tracking.fromAddress === TRADER && live.tracking.toAddress === TRADER)
}

// ---------------------------------------------------------------------------
t.section('SOROSWAP')
// ---------------------------------------------------------------------------
{
  const quoteBody = (over = {}) => ({
    amountIn: '1000000000', amountOut: '163576019',
    otherAmountThreshold: '161940258', tradeType: 'EXACT_IN', priceImpactPct: '0.12', ...over
  })
  const routes = (over) => [['/quote/build', { json: { xdr: 'AAAA' } }], ['/quote', { json: quoteBody(over) }]]

  const fetch = stubFetch(routes())
  const route = await quoteSoroswap(req(), context({ fetch, credentials: { soroswapApiKey: 'sk_x' } }))

  t.ok('amountOut base units → decimal', route.expectedBuyAmount === '16.3576019')
  t.ok('enforced floor reported', route.minBuyAmount === '16.1940258')

  const sent = fetch.calls[0].body
  t.ok('sends integer base units', sent.amount === '1000000000')
  t.ok('slippage percent → bps', sent.slippageBps === 100)
  t.ok('trade type is exact-in', sent.tradeType === 'EXACT_IN')
  t.ok('assets are SAC contract ids', sent.assetIn.startsWith('C') && sent.assetOut.startsWith('C'))
  t.ok('bearer key attached', fetch.calls[0].headers.Authorization === 'Bearer sk_x')
  // The aqua venue is excluded by default: Soroswap's Aquarius integration ignores slippage and
  // prices off stale pools. The direct Aquarius adapter covers that liquidity honestly.
  t.ok('aqua venue excluded by default', !sent.protocols.includes('aqua'))
  t.ok('the honest venues are still requested',
    sent.protocols.includes('soroswap') && sent.protocols.includes('sdex') && sent.protocols.includes('phoenix'))

  // The threshold clamp. Soroswap returns threshold == amountOut on some routes — a floor with no
  // buffer at all. Taken verbatim that is a transaction which reverts on any drift.
  const noBuffer = await quoteSoroswap(
    req(), context({ fetch: stubFetch(routes({ otherAmountThreshold: '163576019' })), credentials: { soroswapApiKey: 'k' } })
  )
  t.ok('a zero-buffer threshold is clamped to our own floor', noBuffer.minBuyAmount === '16.1940258')

  // When the provider's own threshold is tighter than ours, the conservative one wins.
  const tighter = await quoteSoroswap(
    req(), context({ fetch: stubFetch(routes({ otherAmountThreshold: '100000000' })), credentials: { soroswapApiKey: 'k' } })
  )
  t.ok('a tighter provider threshold is kept', tighter.minBuyAmount === '10')

  // The price-impact gate — an unhealthy pool prices far off market while reporting near-zero
  // impact, and the fan-out would PREFER it on price.
  await t.throws('route beyond the impact threshold is dropped',
    () => quoteSoroswap(req(), context({ fetch: stubFetch(routes({ priceImpactPct: '60.54' })), credentials: { soroswapApiKey: 'k' } })),
    (e) => e.quoteCode === 'routeNotFound' && /price impact/.test(e.message))
  await t.throws('impact is gated in EITHER direction',
    () => quoteSoroswap(req(), context({ fetch: stubFetch(routes({ priceImpactPct: '-42' })), credentials: { soroswapApiKey: 'k' } })),
    (e) => e.quoteCode === 'routeNotFound')
  const noImpactField = await quoteSoroswap(
    req(), context({ fetch: stubFetch(routes({ priceImpactPct: undefined })), credentials: { soroswapApiKey: 'k' } })
  )
  t.ok('an absent impact field skips the gate', noImpactField.expectedBuyAmount === '16.3576019')

  // Fee split: the quoted bps is GROSS and Soroswap keeps 40%, so service must report the net.
  const withFee = await quoteSoroswap(req(), context({
    fetch: stubFetch(routes()), credentials: { soroswapApiKey: 'k' },
    serviceFees: { SOROSWAP: { bps: 100, wallet: TRADER } }
  }))
  const service = withFee.fees.find((f) => f.type === 'service')
  const liquidity = withFee.fees.find((f) => f.type === 'liquidity')
  t.ok('service fee is our NET 60% share', service.amount === '0.6')
  t.ok("liquidity fee is Soroswap's 40%", liquidity.amount === '0.4')
  t.ok('fee is denominated in the SELL asset', service.asset === XLM)

  const noWallet = await quoteSoroswap(req(), context({
    fetch: stubFetch(routes()), credentials: { soroswapApiKey: 'k' }, serviceFees: { SOROSWAP: { bps: 100 } }
  }))
  t.ok('no wallet ⇒ no fee quoted', !noWallet.fees.some((f) => f.type === 'service'))

  // A 400 doubles as Soroswap's no-route signal; auth failures must be distinguishable.
  await t.throws('400 → routeNotFound',
    () => quoteSoroswap(req(), context({ fetch: stubFetch([['/quote', { status: 400, json: { message: 'no route' } }]]), credentials: { soroswapApiKey: 'k' } })),
    (e) => e.quoteCode === 'routeNotFound')
  await t.throws('403 → key problem, not a missing route',
    () => quoteSoroswap(req(), context({ fetch: stubFetch([['/quote', { status: 403, json: { message: 'forbidden' } }]]), credentials: { soroswapApiKey: 'bad' } })),
    (e) => e.quoteCode === 'unknownApiError' && /API key/.test(e.message))
  await t.throws('commit without a key is refused before building',
    () => quoteSoroswap({ ...req(), dry: false, sourceAddress: TRADER }, context({ fetch: stubFetch(routes()), horizon: stubHorizon({ account: fundedAccount() }) })),
    (e) => e.quoteCode === 'invalidParams')
}

// ---------------------------------------------------------------------------
t.section('AQUARIUS')
// ---------------------------------------------------------------------------
{
  // `amount` is the GROSS route output; `amount_with_fee` sits about two fees below it and is NOT
  // the net, despite the name. Using it under-quotes every route by a whole fee.
  const path = { success: true, swap_chain_xdr: 'AAAA', pools: [], tokens: [], tokens_addresses: [], amount: '163576019', amount_with_fee: '160304498' }
  const fetch = stubFetch([['find-path', { json: path }]])
  const route = await quoteAquarius(req(), context({ fetch }))

  t.ok('no fee configured ⇒ gross is the net', route.expectedBuyAmount === '16.3576019')
  t.ok('floor derived from the net output', route.minBuyAmount === '16.1940258')
  t.ok('slippage sent as a ≤6dp fraction', fetch.calls[0].body.slippage === '0.010000')
  t.ok('no provider_fee sent without a collector', fetch.calls[0].body.provider_fee === undefined)
  t.ok('tokens sent as SAC contract ids', fetch.calls[0].body.token_in_address.startsWith('C'))

  const feeCtx = context({
    fetch: stubFetch([['find-path', { json: path }]]),
    serviceFees: { AQUARIUS: { bps: 100, feeCollectorContract: 'CCOLLECTOR' } }
  })
  const withFee = await quoteAquarius(req(), feeCtx)
  // net = gross x (1 - bps), NOT amount_with_fee.
  t.ok('net is gross × (1 − bps)', withFee.expectedBuyAmount === '16.1940258')
  t.ok('does NOT use amount_with_fee as the net', withFee.expectedBuyAmount !== '16.0304498')
  const service = withFee.fees.find((f) => f.type === 'service')
  t.ok('service fee is gross − net', service.amount === '0.1635761')
  t.ok('output-side fee is in the BUY asset', service.asset === USDC)
  t.ok('floor guards the NET amount', withFee.minBuyAmount === '16.0320855')

  const noCollector = await quoteAquarius(req(), context({
    fetch: stubFetch([['find-path', { json: path }]]), serviceFees: { AQUARIUS: { bps: 100 } }
  }))
  // Without our deployed collector contract a fee cannot be collected at all — the router has no
  // fee parameter — so none is quoted.
  t.ok('no collector ⇒ no fee, plain router', !noCollector.fees.some((f) => f.type === 'service'))

  await t.throws('success:false → routeNotFound (always HTTP 200)',
    () => quoteAquarius(req(), context({ fetch: stubFetch([['find-path', { json: { success: false } }]]) })),
    (e) => e.quoteCode === 'routeNotFound')

  await t.throws('commit rejects a third-party recipient',
    () => quoteAquarius(
      { ...req(), dry: false, sourceAddress: TRADER, destinationAddress: OTHER },
      context({ fetch: stubFetch([['find-path', { json: path }]]), horizon: stubHorizon({ account: fundedAccount() }) })
    ),
    (e) => /trader account/.test(e.message))
}

// ---------------------------------------------------------------------------
t.section('STELLAR_DEX')
// ---------------------------------------------------------------------------
{
  // The higher-output exotic path is listed FIRST on purpose: if the adapter simply kept the best
  // price it would win, so this ordering is what makes the robustness preference observable.
  const paths = [
    { source_amount: '100', destination_amount: '16.4000000', path: [{ asset_type: 'native' }, { asset_type: 'native' }] },
    { source_amount: '100', destination_amount: '16.3576019', path: [] }
  ]
  const horizon = stubHorizon({ account: fundedAccount(), paths })
  const route = await quoteStellarDex(req(), context({ horizon }))

  // The two-hop path quotes higher but is within tolerance, so the direct book wins on robustness.
  t.ok('prefers the robust direct path', route.expectedBuyAmount === '16.3576019')
  t.ok('destMin floor is enforced on-chain', route.minBuyAmount === '16.1940258')
  t.ok('inbound fee covers one operation', route.fees.find((f) => f.type === 'inbound').amount === '0.001')

  await t.throws('no paths → routeNotFound',
    () => quoteStellarDex(req(), context({ horizon: stubHorizon({ paths: [] }) })),
    (e) => e.quoteCode === 'routeNotFound')

  // A committed route builds the transaction locally — assert the real XDR, not a stub.
  const committed = await quoteStellarDex(
    { ...req(), dry: false, sourceAddress: TRADER },
    context({ horizon: stubHorizon({ account: fundedAccount(), paths }) })
  )
  const tx = TransactionBuilder.fromXDR(committed.execution.transactions[0].xdr, Networks.PUBLIC)
  t.ok('builds one path-payment operation', tx.operations.length === 1)
  t.ok('operation is pathPaymentStrictSend', tx.operations[0].type === 'pathPaymentStrictSend')
  t.ok('sends the full amount when no fee is charged', tx.operations[0].sendAmount === '100.0000000')
  t.ok('destMin matches the reported floor', tx.operations[0].destMin === '16.1940258')

  // With a fee, the swap leg trades the NET and a second payment op carries the rest — together
  // exactly the requested amount, in one atomic transaction.
  const feeRoute = await quoteStellarDex(
    { ...req(), dry: false, sourceAddress: TRADER },
    context({ horizon: stubHorizon({ account: fundedAccount(), paths }), serviceFees: { STELLAR_DEX: { bps: 100, wallet: OTHER } } })
  )
  const feeTx = TransactionBuilder.fromXDR(feeRoute.execution.transactions[0].xdr, Networks.PUBLIC)
  t.ok('fee adds a second operation', feeTx.operations.length === 2)
  t.ok('swap leg trades the NET amount', feeTx.operations[0].sendAmount === '99.0000000')
  t.ok('fee op pays the configured wallet', feeTx.operations[1].destination === OTHER)
  t.ok('fee op carries the remainder', feeTx.operations[1].amount === '1.0000000')
  t.ok('net + fee equals the request exactly',
    Number(feeTx.operations[0].sendAmount) + Number(feeTx.operations[1].amount) === 100)
  t.ok('inbound fee bid doubles for two operations', feeRoute.fees.find((f) => f.type === 'inbound').amount === '0.002')

  // Below 10000/bps stroops the fee truncates to zero; a zero-amount payment op would throw on an
  // otherwise legal request, so such sells simply charge nothing.
  const dust = await quoteStellarDex(
    { ...req({ sellAmount: '0.0000001' }), dry: false, sourceAddress: TRADER },
    context({ horizon: stubHorizon({ account: fundedAccount(), paths }), serviceFees: { STELLAR_DEX: { bps: 1, wallet: OTHER } } })
  )
  t.ok('a dust-sized fee is skipped rather than throwing',
    TransactionBuilder.fromXDR(dust.execution.transactions[0].xdr, Networks.PUBLIC).operations.length === 1)

  await t.throws('an unfunded source is caught before building',
    () => quoteStellarDex({ ...req(), dry: false, sourceAddress: TRADER }, context({ horizon: stubHorizon({ account: null, paths }) })),
    (e) => e.quoteCode === 'invalidParams' && /does not exist/.test(e.message))

  // Buying a classic asset the recipient does not trust reverts on-chain — catch it first.
  const noTrust = { id: 'G', sequence: '1', balances: [{ balance: '10', asset_type: 'native' }] }
  await t.throws('a missing destination trustline is caught before building',
    () => quoteStellarDex({ ...req(), dry: false, sourceAddress: TRADER }, context({ horizon: stubHorizon({ account: noTrust, paths }) })),
    (e) => /trustline/.test(e.message))
}

// ---------------------------------------------------------------------------
t.section('NEAR')
// ---------------------------------------------------------------------------
{
  const tokens = [
    { assetId: 'nep245:stellar-xlm', decimals: 7, blockchain: 'stellar', symbol: 'XLM' },
    { assetId: 'nep141:btc', decimals: 8, blockchain: 'btc', symbol: 'BTC' },
    { assetId: 'nep141:usdc.eth', decimals: 6, blockchain: 'eth', symbol: 'USDC', contractAddress: '0xa0b86991' }
  ]
  const quote = {
    quote: { amountIn: '1000000000', amountOut: '23164', amountOutFormatted: '0.00023164', minAmountOut: '22932', timeEstimate: 25 }
  }
  const routes = [['/v0/tokens', { json: tokens }], ['/v0/quote', { json: quote }]]

  const fetch = stubFetch(routes)
  const route = await quoteNear(req({ buyAsset: 'BTC.BTC' }), context({ fetch }))

  t.ok('reports the provider settled amount', route.expectedBuyAmount === '0.00023164')
  t.ok('minAmountOut scaled by the BUY asset decimals', route.minBuyAmount === '0.00022932')
  t.ok('estimated time comes from the provider', route.estimatedTime.total === 25)

  const sent = fetch.calls[1].body
  t.ok('resolves identifiers to provider asset ids', sent.originAsset === 'nep245:stellar-xlm')
  t.ok('slippage percent → bps', sent.slippageTolerance === 100)
  t.ok('sell amount in the SELL asset base units', sent.amount === '1000000000')
  // A Stellar-origin deposit shares one address across quotes and is keyed by memo.
  t.ok('Stellar origin uses MEMO deposit mode', sent.depositMode === 'MEMO')
  t.ok('a dry quote is marked dry upstream', sent.dry === true)

  // Identifier construction is the only thing that makes a cross-chain identifier meaningful.
  const catalog = await (await import('../dist/index.js')).fetchNearTokens(context({ fetch: stubFetch(routes) }))
  const usdcEth = catalog.find((x) => x.ticker === 'USDC')
  t.ok('builds CHAIN.TICKER-ADDRESS identifiers', usdcEth.identifier === 'ETH.USDC-0XA0B86991')
  t.ok('maps upstream chain codes to ours', catalog.find((x) => x.ticker === 'XLM').identifier === 'XLM.XLM')
  t.ok('preserves per-token decimals', usdcEth.decimals === 6)
  t.ok('round-trips the provider asset id', usdcEth.extensions.providerId === 'nep141:usdc.eth')

  await t.throws('an asset outside the catalog declines locally',
    () => quoteNear(req({ buyAsset: 'DOGE.DOGE' }), context({ fetch: stubFetch(routes) })),
    (e) => e.quoteCode === 'tokenNotSupported' && e.origin === 'local')

  await t.throws('400 from the provider → routeNotFound',
    () => quoteNear(req({ buyAsset: 'BTC.BTC' }), context({
      fetch: stubFetch([['/v0/tokens', { json: tokens }], ['/v0/quote', { status: 400, json: { message: 'chain down' } }]])
    })),
    (e) => e.quoteCode === 'routeNotFound' && /chain down/.test(e.message))

  await t.throws('commit needs a refund address',
    () => quoteNear(
      { ...req({ buyAsset: 'BTC.BTC' }), dry: false, sourceAddress: TRADER, destinationAddress: 'bc1q' },
      context({ fetch: stubFetch(routes) })
    ),
    (e) => /refundAddress/.test(e.message))

  // 1Click keeps half the app fee and forwards the rest, so service must report the net.
  const withFee = await quoteNear(req({ buyAsset: 'BTC.BTC' }), context({
    fetch: stubFetch(routes), serviceFees: { NEAR: { bps: 100, wallet: 'fees.near' } }
  }))
  t.ok('service fee is our net half', withFee.fees.find((f) => f.type === 'service').amount === '0.5')
  t.ok("liquidity fee is 1Click's half", withFee.fees.find((f) => f.type === 'liquidity').amount === '0.5')
}

// ---------------------------------------------------------------------------
t.section('AXELAR_ITS')
// ---------------------------------------------------------------------------
{
  const ETH_XLM = 'ETH.XLM-0X8CF74FC1EC7B2187DDA77EA289F78CC54E2B7C8B'
  const ETH_SHX = 'ETH.SHX-0X516D31321928700C6B4FB0DB0C8C6BC5D6799787'
  const gmp = [['gmp.axelarscan', { text: '1000000' }]]

  const fetch = stubFetch(gmp)
  const route = await quoteAxelar(req({ buyAsset: ETH_XLM }), context({ fetch }))

  // A bridge, not a swap: the same token at 7 decimals on both sides.
  t.ok('output equals input exactly', route.expectedBuyAmount === '100')
  t.ok('the floor equals it too — nothing floats', route.minBuyAmount === '100')

  const gas = route.fees.find((f) => f.type === 'liquidity')
  // 1_000_000 stroops over-provisioned by the default 1.2x multiplier.
  t.ok('gas prepayment over-provisioned by the multiplier', gas.amount === '0.12')
  t.ok('prepayment is in the SOURCE native asset', gas.asset === XLM)
  t.ok('costs are additive, never deducted from the bridged amount',
    route.expectedBuyAmount === route.sellAmount)
  t.ok('estimateITSFee asked for the right hop', fetch.calls[0].body.sourceChain === 'stellar' && fetch.calls[0].body.destinationChain === 'ethereum')
  t.ok('gasLimit sent as a number, not a string', typeof fetch.calls[0].body.gasLimit === 'number')

  const custom = await quoteAxelar(req({ buyAsset: ETH_XLM }), context({ fetch: stubFetch(gmp), tunables: { axelarGasMultiplier: 2 } }))
  t.ok('gas multiplier is configurable', custom.fees.find((f) => f.type === 'liquidity').amount === '0.2')

  // ITS bridges the SAME token; a different token on the far side is not a route.
  await t.throws('different tokens are not an ITS pair',
    () => quoteAxelar(req({ buyAsset: ETH_SHX }), context({ fetch: stubFetch(gmp) })),
    (e) => e.quoteCode === 'pairNotSupported' && e.origin === 'local')
  await t.throws('an unknown asset declines locally',
    () => quoteAxelar(req({ buyAsset: USDC }), context({ fetch: stubFetch(gmp) })),
    (e) => e.quoteCode === 'tokenNotSupported')
  await t.throws('a zero gas estimate is not accepted',
    () => quoteAxelar(req({ buyAsset: ETH_XLM }), context({ fetch: stubFetch([['gmp.axelarscan', { text: '0' }]]) })),
    (e) => e.quoteCode === 'unknownApiError')

  await t.throws('commit needs both addresses',
    () => quoteAxelar({ ...req({ buyAsset: ETH_XLM }), dry: false, sourceAddress: TRADER }, context({ fetch: stubFetch(gmp) })),
    (e) => /destinationAddress/.test(e.message))
  await t.throws('a Stellar destination is rejected for an EVM-bound transfer',
    () => quoteAxelar(
      { ...req({ buyAsset: ETH_XLM }), dry: false, sourceAddress: TRADER, destinationAddress: TRADER },
      context({ fetch: stubFetch(gmp), horizon: stubHorizon({ account: fundedAccount() }) })
    ),
    (e) => /EVM address/.test(e.message))
}

// ---------------------------------------------------------------------------
t.section('shared HTTP transport')
// ---------------------------------------------------------------------------
{
  const call = (over = {}) => ({ url: 'https://x.test/q', fetch: stubFetch([['x.test', { json: { a: 1 } }]]), provider: 'P', ...over })

  const okRes = await httpJson(call())
  t.ok('parses a JSON body', okRes.ok && okRes.data.a === 1)

  // A non-2xx is NOT thrown: several of these venues use a 4xx (or a 200 with a failure field) as
  // their ordinary no-route signal, and only the adapter knows which is which.
  const declined = await httpJson(call({ fetch: stubFetch([['x.test', { status: 400, json: { message: 'no route' } }]]) }))
  t.ok('a 4xx is returned, not thrown', declined.ok === false && declined.status === 400)
  t.ok('the error body is preserved for the adapter', declined.data.message === 'no route')

  // Transport failures ARE thrown — no adapter can interpret those better than the transport can.
  await t.throws('a network failure becomes networkError',
    () => httpJson(call({ fetch: async () => { throw new Error('ECONNREFUSED') } })),
    (e) => e.quoteCode === 'networkError' && /ECONNREFUSED/.test(e.message))

  const aborted = new AbortController()
  aborted.abort()
  await t.throws('an aborted request becomes requestTimeOut',
    () => httpJson(call({ signal: aborted.signal, fetch: async () => { throw new Error('aborted') } })),
    (e) => e.quoteCode === 'requestTimeOut')

  await t.throws('a non-JSON 2xx body is a contract violation',
    () => httpJson(call({ fetch: stubFetch([['x.test', { text: '<html>oops</html>' }]]) })),
    (e) => e.quoteCode === 'invalidResponseFormat')

  // A non-JSON body on an ERROR status is just the upstream's error page — surfaced verbatim.
  const errorPage = await httpJson(call({ fetch: stubFetch([['x.test', { status: 502, text: 'Bad Gateway' }]]) }))
  t.ok('a non-JSON error page passes through', errorPage.ok === false && errorPage.data === 'Bad Gateway')

  const queried = stubFetch([['x.test', { json: {} }]])
  await httpJson(call({ fetch: queried, query: { a: '1', b: 2, skip: undefined } }))
  const url = new URL(queried.calls[0].url)
  t.ok('query params are serialized', url.searchParams.get('a') === '1' && url.searchParams.get('b') === '2')
  t.ok('undefined query params are omitted', !url.searchParams.has('skip'))

  const posted = stubFetch([['x.test', { json: {} }]])
  await httpJson(call({ fetch: posted, method: 'POST', body: { hello: 'world' } }))
  t.ok('a body is JSON-encoded', posted.calls[0].body.hello === 'world')
  t.ok('a body sets the content type', posted.calls[0].headers['Content-Type'] === 'application/json')

  const bodiless = stubFetch([['x.test', { json: {} }]])
  await httpJson(call({ fetch: bodiless }))
  t.ok('a GET sends no content type', bodiless.calls[0].headers['Content-Type'] === undefined)
}

t.done()
