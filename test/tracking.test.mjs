/**
 * Outcome tracking, per provider, offline.
 *
 * The through-line of every assertion here: a settled amount is READ from the source of truth,
 * never taken from the quote. A tracker that reports a quoted figure as if it were delivered is
 * worse than one that reports nothing, so the "no evidence yet" cases are asserted as carefully as
 * the happy paths.
 */

import { trackRoute, trackStellar, trackNear, trackAxelar, sumEffects } from '../dist/index.js'
import { harness, stubFetch, stubHorizon, context, USDC, USDC_ISSUER, XLM, TRADER } from './helpers.mjs'

const t = harness()
const TO = 'GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH'

// ---------------------------------------------------------------------------
t.section('effect summing')
// ---------------------------------------------------------------------------
{
  const effects = [
    { type: 'account_credited', account: TO, asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, amount: '10.0000000' },
    { type: 'account_credited', account: TO, asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, amount: '6.3576019' },
    // A counterparty's credit in the same asset — a multi-hop trade emits these per hop.
    { type: 'account_credited', account: 'GOTHER', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, amount: '999' },
    // Right account, wrong issuer — a different asset that happens to share a code.
    { type: 'account_credited', account: TO, asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: TRADER, amount: '500' },
    { type: 'account_credited', account: TO, asset_type: 'native', amount: '5' },
    { type: 'account_debited', account: TO, asset_type: 'native', amount: '100' }
  ]
  t.ok('sums the recipient across multiple credits', sumEffects(effects, 'account_credited', TO, USDC) === '16.3576019')
  t.ok('ignores counterparty credits', !sumEffects(effects, 'account_credited', TO, USDC).includes('999'))
  t.ok('matches on issuer, not just code', sumEffects(effects, 'account_credited', TO, USDC) === '16.3576019')
  t.ok('native matched by asset_type', sumEffects(effects, 'account_credited', TO, XLM) === '5')
  t.ok('debits roll up separately', sumEffects(effects, 'account_debited', TO, XLM) === '100')
  t.ok('nothing matching sums to zero', sumEffects([], 'account_credited', TO, USDC) === '0')
  // Summed in stroops, so no float error creeps into a settled amount.
  const thirds = Array.from({ length: 3 }, () => ({ type: 'account_credited', account: TO, asset_type: 'native', amount: '0.1000000' }))
  t.ok('sums without float drift', sumEffects(thirds, 'account_credited', TO, XLM) === '0.3')
}

// ---------------------------------------------------------------------------
t.section('STELLAR tracking (Horizon)')
// ---------------------------------------------------------------------------
{
  const effects = [
    { type: 'account_credited', account: TO, asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, amount: '16.3576019' },
    { type: 'account_debited', account: TO, asset_type: 'native', amount: '100' }
  ]
  const tracking = { provider: 'STELLAR_DEX', fromAsset: XLM, toAsset: USDC, toAddress: TO, fromAddress: TO, fromAmount: '100' }
  const horizon = (transaction, fx) => stubHorizon({ transaction, effects: fx })

  const none = await trackStellar(horizon(null, []), tracking, undefined)
  t.ok('nothing broadcast → not_started', none.status === 'not_started')

  const pending = await trackStellar(horizon(null, []), tracking, 'HASH')
  t.ok('hash not indexed yet → pending, not failed', pending.status === 'pending')

  const failed = await trackStellar(horizon({ successful: false }, []), tracking, 'HASH')
  t.ok('unsuccessful transaction → failed', failed.status === 'failed')
  t.ok('a failed swap reports no delivered amount', failed.toAmount === '')

  const done = await trackStellar(horizon({ successful: true }, effects), tracking, 'HASH')
  t.ok('successful transaction → completed', done.status === 'completed')
  t.ok('delivered amount read from effects', done.toAmount === '16.3576019')
  t.ok('sent amount read from debits', done.fromAmount === '100')
  t.ok('reports the swap as one leg', done.legs.length === 1 && done.legs[0].hash === 'HASH')
  t.ok('carries the provider through', done.providers[0] === 'STELLAR_DEX')

  // A success with no decodable credit must not assert a delivered zero — the credit may have
  // landed in a form this handle does not describe, and "0 received" overstates the evidence.
  const zero = await trackStellar(horizon({ successful: true }, []), tracking, 'HASH')
  t.ok('completed with no decodable credit reports no amount', zero.status === 'completed' && zero.toAmount === '')

  // Without a debit to read, the quoted sell amount stands in — it is what was asked for.
  const noDebit = await trackStellar(horizon({ successful: true }, [effects[0]]), tracking, 'HASH')
  t.ok('falls back to the quoted sell amount when no debit decodes', noDebit.fromAmount === '100')
}

// ---------------------------------------------------------------------------
t.section('NEAR tracking (1Click status)')
// ---------------------------------------------------------------------------
{
  const tracking = {
    provider: 'NEAR', fromAsset: XLM, toAsset: 'BTC.BTC', toAddress: 'bc1qdest',
    depositAddress: 'GDEPOSIT', depositMemo: 'memo-1', fromAddress: TRADER, fromAmount: '100'
  }
  const status = (body, code = 200) => context({ fetch: stubFetch([['/v0/status', { status: code, json: body }]]) })

  const notFound = await trackNear(status({}, 404), tracking, undefined)
  t.ok('no deposit seen yet → not_started', notFound.status === 'not_started')

  const cases = [
    ['PENDING_DEPOSIT', 'not_started'],
    ['KNOWN_DEPOSIT_TX', 'pending'],
    ['INCOMPLETE_DEPOSIT', 'pending'],
    ['PROCESSING', 'swapping'],
    ['SUCCESS', 'completed'],
    ['REFUNDED', 'refunded'],
    ['FAILED', 'failed'],
    ['SOMETHING_NEW', 'unknown']
  ]
  for (const [upstream, expected] of cases) {
    const res = await trackNear(status({ status: upstream, swapDetails: {} }), tracking, undefined)
    t.ok(`${upstream} → ${expected}`, res.status === expected)
  }

  const settled = await trackNear(status({
    status: 'SUCCESS',
    quoteResponse: { quoteRequest: { recipient: 'bc1qdest' }, quote: { amountInUsd: '16.34' } },
    swapDetails: {
      amountInFormatted: '100', amountOutFormatted: '0.00023164',
      nearTxHashes: ['NEARTX'], originChainTxHashes: [{ hash: 'ORIGINTX' }], destinationChainTxHashes: [{ hash: 'DESTTX' }]
    }
  }), tracking, undefined)
  t.ok('reports the settled output', settled.toAmount === '0.00023164')
  t.ok('reports three legs', settled.legs.length === 3)
  t.ok('deposit leg carries the origin hash', settled.legs[0].hash === 'ORIGINTX')
  t.ok('deposit leg pays the deposit address', settled.legs[0].toAddress === 'GDEPOSIT')
  t.ok('swap leg carries the NEAR hash', settled.legs[1].hash === 'NEARTX')
  t.ok('payout leg carries the destination hash', settled.legs[2].hash === 'DESTTX')
  t.ok('surfaces the USD size when priced', settled.meta.sellAmountUsd === '16.34')

  // Only the provider's settled figure may be reported. Falling back to the quote here would
  // fabricate a delivered amount for a swap that never delivered.
  const refunded = await trackNear(status({ status: 'REFUNDED', swapDetails: { amountInFormatted: '100' } }), tracking, undefined)
  t.ok('a refunded swap reports no delivered amount', refunded.toAmount === '')
  t.ok('a refunded swap still reports what went in', refunded.fromAmount === '100')

  const notStarted = await trackNear(status({ status: 'PENDING_DEPOSIT', swapDetails: {} }), tracking, undefined)
  t.ok('legs are not_started before the deposit lands', notStarted.legs.every((l) => l.status === 'not_started'))

  // The memo is not optional on a MEMO-mode chain: without it the lookup does not resolve.
  const ctx = status({ status: 'SUCCESS', swapDetails: {} })
  await trackNear(ctx, tracking, undefined)
  t.ok('sends the deposit memo with the lookup', ctx.fetch.calls[0].url.includes('depositMemo=memo-1'))

  const noHandle = await trackNear(status({}), { ...tracking, depositAddress: undefined }, undefined)
  t.ok('no deposit address → unknown, not a crash', noHandle.status === 'unknown')
}

// ---------------------------------------------------------------------------
t.section('AXELAR_ITS tracking (Axelarscan GMP)')
// ---------------------------------------------------------------------------
{
  const tracking = {
    provider: 'AXELAR_ITS', fromAsset: XLM, toAsset: 'ETH.XLM-0X8CF7', toAddress: '0xdead',
    fromChain: 'XLM', toChain: 'ETH', fromAddress: TRADER, fromAmount: '100'
  }
  const SRC = 'SOURCEHASH'
  const HUB = '0xHUBTX'

  // searchGMP is called twice — once for the source hash, once for the hub tx it points at.
  const gmp = (bySource, byHub) => context({
    fetch: stubFetch([['gmp.axelarscan', (call) => ({
      json: { data: call.body.txHash === SRC ? bySource : byHub }
    })]])
  })

  const hop1 = (over = {}) => ({ status: 'executed', call: { transactionHash: SRC }, callback: { transactionHash: HUB }, value: 16.3, ...over })
  const hop2 = (over = {}) => ({
    status: 'executed',
    call: { transactionHash: HUB, returnValues: { destinationChain: 'ethereum' } },
    executed: { transactionHash: '0xDELIVERED' },
    interchain_transfer: { amount: '1000000000', decimals: 7 },
    ...over
  })

  const noHash = await trackAxelar(gmp([], []), tracking, undefined)
  t.ok('nothing broadcast → not_started', noHash.status === 'not_started')

  const notIndexed = await trackAxelar(gmp([], []), tracking, SRC)
  t.ok('not indexed by Axelar yet → pending', notIndexed.status === 'pending')

  // Hop 1 executing means the transfer reached the hub — NOT that anything was delivered.
  const atHub = await trackAxelar(gmp([hop1()], []), tracking, SRC)
  t.ok('hop 1 executed but hop 2 unseen → still swapping', atHub.status === 'swapping')

  const noCallback = await trackAxelar(gmp([hop1({ callback: undefined })], []), tracking, SRC)
  t.ok('no hub linkage yet → swapping', noCallback.status === 'swapping')

  const inFlight = await trackAxelar(gmp([hop1()], [hop2({ status: 'confirming' })]), tracking, SRC)
  t.ok('hop 2 not yet executed → swapping', inFlight.status === 'swapping')

  const delivered = await trackAxelar(gmp([hop1()], [hop2()]), tracking, SRC)
  t.ok('both hops executed → completed', delivered.status === 'completed')
  t.ok('delivered amount decoded from the ITS payload', delivered.toAmount === '100')
  t.ok('reports two legs', delivered.legs.length === 2)
  t.ok('payout leg carries the delivery hash', delivered.legs[1].hash === '0xDELIVERED')
  t.ok('surfaces the USD size when priced', delivered.meta.sellAmountUsd === '16.3')

  // Decimals are read from the payload rather than hardcoded, so a non-7dp ITS asset would not be
  // silently misreported by a factor of ten.
  const eighteen = await trackAxelar(gmp([hop1()], [hop2({ interchain_transfer: { amount: '1000000000000000000', decimals: 18 } })]), tracking, SRC)
  t.ok('scales by the payload decimals', eighteen.toAmount === '1')

  // Stuck gas is a pause, not a loss: anyone can top it up through Axelarscan's recovery flow.
  for (const stuck of [{ status: 'insufficient_fee' }, { is_insufficient_fee: true }, { not_enough_gas_to_execute: true }]) {
    const res = await trackAxelar(gmp([hop1(stuck)], []), tracking, SRC)
    t.ok(`stuck gas (${Object.keys(stuck)[0]}) → action_required, never failed`, res.status === 'action_required')
  }
  const gasStuck = await trackAxelar(gmp([hop1({ status: 'insufficient_fee' })], []), tracking, SRC)
  t.ok('stuck gas explains itself', gasStuck.meta.pauseReason === 'insufficient_gas')

  // Funds have left the source chain and ITS has no refund path, so an error is recoverable by
  // re-execution — never auto-reported as a terminal failure.
  const errored = await trackAxelar(gmp([hop1({ status: 'error' })], []), tracking, SRC)
  t.ok('a hub error → action_required, not failed', errored.status === 'action_required')
  t.ok('hub error explains itself', errored.meta.pauseReason === 'provider_error')

  // Axelarscan returns value: 0 on many records — that means "not priced", not a zero-value swap.
  const unpriced = await trackAxelar(gmp([hop1({ value: 0 })], [hop2()]), tracking, SRC)
  t.ok('an unpriced record reports no USD size', unpriced.meta?.sellAmountUsd === undefined)

  // Hash forms differ per chain (0x-prefixed lowercase EVM, bare uppercase Stellar).
  const mixedCase = await trackAxelar(gmp([hop1({ call: { transactionHash: SRC.toLowerCase() } })], [hop2()]), tracking, SRC)
  t.ok('hashes compare normalized across chains', mixedCase.status === 'completed')
}

// ---------------------------------------------------------------------------
t.section('dispatch')
// ---------------------------------------------------------------------------
{
  const horizon = stubHorizon({ transaction: { successful: true }, effects: [] })
  for (const provider of ['STELLARBROKER', 'SOROSWAP', 'AQUARIUS', 'STELLAR_DEX']) {
    const res = await trackRoute({ provider, fromAsset: XLM, toAsset: USDC, toAddress: TO }, 'H', context(), horizon)
    t.ok(`${provider} routes to the Horizon tracker`, res.status === 'completed')
  }

  const near = await trackRoute(
    { provider: 'NEAR', fromAsset: XLM, toAsset: 'BTC.BTC', toAddress: 'bc1q', depositAddress: 'G' },
    undefined,
    context({ fetch: stubFetch([['/v0/status', { status: 404, json: {} }]]) }),
    horizon
  )
  t.ok('NEAR routes to the 1Click tracker', near.status === 'not_started')

  const axelar = await trackRoute(
    { provider: 'AXELAR_ITS', fromAsset: XLM, toAsset: 'ETH.XLM-0X8CF7', toAddress: '0xd', fromChain: 'XLM', toChain: 'ETH' },
    undefined,
    context({ fetch: stubFetch([['gmp', { json: { data: [] } }]]) }),
    horizon
  )
  t.ok('AXELAR_ITS routes to the GMP tracker', axelar.status === 'not_started')

  await t.throws('an unknown provider is refused, not silently empty',
    () => trackRoute({ provider: 'MADE_UP', fromAsset: XLM, toAsset: USDC, toAddress: TO }, 'H', context(), horizon),
    (e) => /No tracker/.test(e.message))
}

t.done()
