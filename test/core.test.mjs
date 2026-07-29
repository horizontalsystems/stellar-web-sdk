import * as S from '@stellar/stellar-sdk'
import {
  parseStellarAssetIdentifier,
  stellarAssetId,
  normalizeStellarAmount,
  toStroops,
  fromStroops,
  selectRoute,
  providersForRecipient,
  compareDecimals,
  keypairSigner,
  txCarriesSignatureFrom,
  sacContractId
} from '../dist/index.js'
import { SigningPipeline } from '../dist/execution/stellarBroker/SigningPipeline.js'

const P = S.Networks.PUBLIC
let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗ FAIL', name) }
}

console.log('\n# asset parsing (case-sensitive)')
const usdc = parseStellarAssetIdentifier('XLM.USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
ok('classic identifier', usdc.identifier === 'XLM.USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
ok('classic code preserved', usdc.code === 'USDC')
ok('native XLM', parseStellarAssetIdentifier('XLM.XLM').identifier === 'XLM.XLM')
ok('bare native', parseStellarAssetIdentifier('XLM').code === 'XLM')
ok('colon form', parseStellarAssetIdentifier('USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN').code === 'USDC')
ok('case-sensitive yXLM≠YXLM', parseStellarAssetIdentifier('yXLM-GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55').code === 'yXLM')
ok('SB wire form native', stellarAssetId(parseStellarAssetIdentifier('XLM.XLM')) === 'XLM')
ok('SB wire form classic', stellarAssetId(usdc) === 'USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
try { parseStellarAssetIdentifier('XLM.FOO-CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'); ok('reject Soroban C-asset', false) }
catch { ok('reject Soroban C-asset', true) }

console.log('\n# amounts (7dp truncation, not rounding)')
ok('truncate', normalizeStellarAmount('1.123456789') === '1.1234567')
ok('toStroops', toStroops('1.0000001') === 10000001n)
ok('fromStroops', fromStroops(10000001n) === '1.0000001')
ok('strip trailing', normalizeStellarAmount('2.5000000') === '2.5')

console.log('\n# waterfall (SB-first even when fallback is nominally higher)')
const routes = [
  { providers: ['SOROSWAP'], expectedBuyAmount: '105', minBuyAmount: '104' },
  { providers: ['STELLARBROKER'], expectedBuyAmount: '100', minBuyAmount: null },
  { providers: ['STELLAR_DEX'], expectedBuyAmount: '103', minBuyAmount: '102' }
]
ok('SB wins despite lower number', selectRoute(routes).providers[0] === 'STELLARBROKER')
ok('best fallback when no SB', selectRoute(routes.filter(r => r.providers[0] !== 'STELLARBROKER')).providers[0] === 'SOROSWAP')
ok('recipient filter (all)', providersForRecipient(false).length === 4)
ok('recipient filter (3rd party)', JSON.stringify(providersForRecipient(true)) === JSON.stringify(['SOROSWAP', 'STELLAR_DEX']))
ok('compareDecimals', compareDecimals('10.5', '10.49') > 0 && compareDecimals('9', '10') < 0 && compareDecimals('1.0', '1') === 0)

console.log('\n# SAC derivation (deterministic, local)')
ok('USDC SAC', sacContractId(usdc, P) === 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75')
ok('native SAC', sacContractId(parseStellarAssetIdentifier('XLM.XLM'), P) === 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA')

console.log('\n# signing pipeline — classic swap leg (self-payment path payment)')
const trader = S.Keypair.random()
const traderPub = trader.publicKey()
const channel = S.Keypair.random()
const signer = keypairSigner(trader.secret())

// Build a broker-style classic tx: source = channel account, one path payment source=trader dest=trader (XLM->USDC)
function buildClassicSwapTx(sendAmount) {
  const acc = new S.Account(channel.publicKey(), '42')
  const tx = new S.TransactionBuilder(acc, { fee: '100', networkPassphrase: P })
    .addOperation(S.Operation.pathPaymentStrictSend({
      source: traderPub,
      sendAsset: S.Asset.native(),
      sendAmount: String(sendAmount),
      destination: traderPub,
      destAsset: new S.Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
      destMin: '90',
      path: []
    }))
    .setTimeout(180)
    .build()
  tx.sign(channel) // channel pre-signs its sequence, like SB
  return tx
}

const selling = parseStellarAssetIdentifier('XLM.XLM')
function makePipeline(amount = '100') {
  return new SigningPipeline({
    signer,
    sellingAsset: selling,
    sellingAmount: amount,
    networkPassphrase: P,
    horizon: { latestLedger: async () => 1000 }
  })
}

// happy path: sendAmount within budget
{
  const tx = buildClassicSwapTx('100')
  const pipe = makePipeline('100')
  const res = await pipe.sign({ hash: 'corr-1', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '2000000' })
  const fb = S.TransactionBuilder.fromXDR(res.xdr, P)
  ok('returns fee-bump', fb instanceof S.FeeBumpTransaction)
  ok('feeSource = trader', fb.feeSource === traderPub)
  ok('inner signed by trader', txCarriesSignatureFrom(fb.innerTransaction, traderPub))
  ok('feebump signed by trader', txCarriesSignatureFrom(fb, traderPub))
  ok('tracking hash recorded', pipe.lastSignedHash === fb.hash().toString('hex'))
  ok('echoes correlation hash', res.hash === 'corr-1')
  ok('feebump fee ≤ networkFee bid', BigInt(fb.fee) <= 2000000n)
}

// debit over budget → reject
{
  const tx = buildClassicSwapTx('103') // > 100 * 1.02
  const pipe = makePipeline('100')
  try { await pipe.sign({ hash: 'c', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '2000000' }); ok('reject over-budget debit', false) }
  catch (e) { ok('reject over-budget debit', /exceeds sellingAmount/.test(e.message)) }
}

// wrong selling asset debited → reject
{
  const acc = new S.Account(channel.publicKey(), '42')
  const tx = new S.TransactionBuilder(acc, { fee: '100', networkPassphrase: P })
    .addOperation(S.Operation.pathPaymentStrictSend({
      source: traderPub,
      sendAsset: new S.Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
      sendAmount: '10', destination: traderPub, destAsset: S.Asset.native(), destMin: '1', path: []
    }))
    .setTimeout(180).build()
  tx.sign(channel)
  const pipe = makePipeline('100') // selling = XLM, but tx debits USDC
  try { await pipe.sign({ hash: 'c', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '2000000' }); ok('reject wrong-asset debit', false) }
  catch (e) { ok('reject wrong-asset debit', /does not spend the selling asset/.test(e.message)) }
}

// disallowed op (manageData) → reject shape
{
  const acc = new S.Account(channel.publicKey(), '42')
  const tx = new S.TransactionBuilder(acc, { fee: '100', networkPassphrase: P })
    .addOperation(S.Operation.manageData({ name: 'x', value: 'y' }))
    .setTimeout(180).build()
  tx.sign(channel)
  const pipe = makePipeline('100')
  try { await pipe.sign({ hash: 'c', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '2000000' }); ok('reject non-swap op', false) }
  catch (e) { ok('reject non-swap op', /unexpected operation type/.test(e.message)) }
}

// path payment to a third party (not trader, not fee leg) → reject
{
  const acc = new S.Account(channel.publicKey(), '42')
  const evil = S.Keypair.random().publicKey()
  const tx = new S.TransactionBuilder(acc, { fee: '100', networkPassphrase: P })
    .addOperation(S.Operation.pathPaymentStrictReceive({
      source: traderPub, // trader-sourced but pays a third party
      sendAsset: S.Asset.native(), sendMax: '100',
      destination: evil, destAsset: S.Asset.native(), destAmount: '100', path: []
    }))
    .setTimeout(180).build()
  tx.sign(channel)
  const pipe = makePipeline('100')
  try { await pipe.sign({ hash: 'c', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '2000000' }); ok('reject third-party payout', false) }
  catch (e) { ok('reject third-party payout', /neither pays the trader/.test(e.message)) }
}

// 5-tx debit cap
{
  const pipe = makePipeline('100')
  let capped = false
  for (let i = 0; i < 6; i++) {
    const tx = buildClassicSwapTx('50')
    try { await pipe.sign({ hash: 'c' + i, xdr: tx.toEnvelope().toXDR('base64'), networkFee: '2000000' }) }
    catch (e) { if (/distinct debiting transactions/.test(e.message)) { capped = true; break } }
  }
  ok('caps at 5 debiting txs', capped)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
