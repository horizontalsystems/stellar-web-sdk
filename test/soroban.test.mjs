import * as S from '@stellar/stellar-sdk'
import { keypairSigner, parseStellarAssetIdentifier, sacContractId, txCarriesSignatureFrom } from '../dist/index.js'
import { SigningPipeline } from '../dist/execution/stellarBroker/SigningPipeline.js'

const P = S.Networks.PUBLIC
const { xdr, Address, nativeToScVal } = S
let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

const trader = S.Keypair.random()
const channel = S.Keypair.random()
const signer = keypairSigner(trader.secret())
const selling = parseStellarAssetIdentifier('XLM.XLM')
const sellingSac = sacContractId(selling, P)

// Build a SorobanAuthorizationEntry: address credentials (trader) authorizing
// transfer(from=trader, to=router, amount=100_0000000) on the XLM SAC.
function buildAuthEntry(sacId, from, amountStroops) {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(sacId).toScAddress(),
        functionName: 'transfer',
        args: [
          nativeToScVal(new Address(from), { type: 'address' }),
          nativeToScVal(new Address(S.Keypair.random().publicKey()), { type: 'address' }),
          nativeToScVal(amountStroops, { type: 'i128' })
        ]
      })
    ),
    subInvocations: []
  })
  const creds = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: new Address(from).toScAddress(),
      nonce: new xdr.Int64(123456),
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVec([])
    })
  )
  return new xdr.SorobanAuthorizationEntry({ credentials: creds, rootInvocation: invocation })
}

function buildSorobanTx(amountStroops) {
  const acc = new S.Account(channel.publicKey(), '99')
  const authEntry = buildAuthEntry(sellingSac, trader.publicKey(), amountStroops)
  const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(sellingSac).toScAddress(),
      functionName: 'swap',
      args: []
    })
  )
  const op = S.Operation.invokeHostFunction({ func: hostFn, auth: [authEntry] })
  const tx = new S.TransactionBuilder(acc, { fee: '1000', networkPassphrase: P })
    .addOperation(op)
    .setLedgerbounds(0, 5000) // maxLedger = 5000
    .setTimeout(180)
    .build()
  tx.sign(channel)
  return tx
}

const horizon = { latestLedger: async () => 4000 }
function pipe(amount = '100') {
  return new SigningPipeline({ signer, sellingAsset: selling, sellingAmount: amount, networkPassphrase: P, horizon })
}

console.log('\n# Soroban two-phase signing')

// First pass: no trader signature yet → sign auth entries + inner tx, NO fee bump.
{
  const tx = buildSorobanTx(1000000000n) // 100 XLM in stroops, within 100*1.02
  const p = pipe('100')
  const res = await p.sign({ hash: 'S1', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '3000000' })
  const parsed = S.TransactionBuilder.fromXDR(res.xdr, P)
  ok('first pass returns inner tx (not fee-bump)', parsed instanceof S.Transaction)
  ok('first pass: no tracking hash yet', p.lastSignedHash === undefined)
  ok('first pass: trader signed inner tx', txCarriesSignatureFrom(parsed, trader.publicKey()))
  // auth entry now carries a signature (scvVec non-empty)
  const authSig = parsed.operations[0].auth[0].credentials().address().signature()
  ok('first pass: auth entry signed', authSig.switch().name === 'scvVec' && authSig.vec().length === 1)
  // expiration ledger set to maxLedger+1 = 5001
  const exp = parsed.operations[0].auth[0].credentials().address().signatureExpirationLedger()
  ok('first pass: expiration = maxLedger+1', exp === 5001)

  // Second pass: broker returns the SAME tx (now trader-signed) → only fee-bump, skip debit budget.
  const res2 = await p.sign({ hash: 'S2', xdr: res.xdr, networkFee: '3000000' })
  const fb = S.TransactionBuilder.fromXDR(res2.xdr, P)
  ok('second pass returns fee-bump', fb instanceof S.FeeBumpTransaction)
  ok('second pass: feeSource = trader', fb.feeSource === trader.publicKey())
  ok('second pass: tracking hash recorded', p.lastSignedHash === fb.hash().toString('hex'))
  ok('second pass: still only 1 debiting tx counted', p.signedHashes.length === 1)
}

// Over-budget Soroban debit → reject
{
  const tx = buildSorobanTx(1030000000n) // 103 XLM > 100*1.02
  const p = pipe('100')
  try { await p.sign({ hash: 'S', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '3000000' }); ok('reject over-budget soroban', false) }
  catch (e) { ok('reject over-budget soroban', /exceeds sellingAmount/.test(e.message)) }
}

// transfer on a DIFFERENT contract (not selling SAC) → reject
{
  const otherSac = sacContractId(parseStellarAssetIdentifier('XLM.USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'), P)
  const acc = new S.Account(channel.publicKey(), '99')
  const authEntry = buildAuthEntry(otherSac, trader.publicKey(), 100000000n)
  const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: new Address(otherSac).toScAddress(), functionName: 'swap', args: [] })
  )
  const tx = new S.TransactionBuilder(acc, { fee: '1000', networkPassphrase: P })
    .addOperation(S.Operation.invokeHostFunction({ func: hostFn, auth: [authEntry] }))
    .setLedgerbounds(0, 5000).setTimeout(180).build()
  tx.sign(channel)
  const p = pipe('100')
  try { await p.sign({ hash: 'S', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '3000000' }); ok('reject transfer on wrong SAC', false) }
  catch (e) { ok('reject transfer on wrong SAC', /not the selling asset's SAC/.test(e.message)) }
}

// forbidden SEP-41 (approve) touching trader → reject
{
  const acc = new S.Account(channel.publicKey(), '99')
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(sellingSac).toScAddress(),
        functionName: 'approve',
        args: [
          nativeToScVal(new Address(trader.publicKey()), { type: 'address' }),
          nativeToScVal(new Address(S.Keypair.random().publicKey()), { type: 'address' }),
          nativeToScVal(100n, { type: 'i128' }),
          nativeToScVal(9999, { type: 'u32' })
        ]
      })
    ),
    subInvocations: []
  })
  const creds = xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
    address: new Address(trader.publicKey()).toScAddress(),
    nonce: new xdr.Int64(1), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVec([])
  }))
  const authEntry = new xdr.SorobanAuthorizationEntry({ credentials: creds, rootInvocation: invocation })
  const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: new Address(sellingSac).toScAddress(), functionName: 'x', args: [] })
  )
  const tx = new S.TransactionBuilder(acc, { fee: '1000', networkPassphrase: P })
    .addOperation(S.Operation.invokeHostFunction({ func: hostFn, auth: [authEntry] }))
    .setLedgerbounds(0, 5000).setTimeout(180).build()
  tx.sign(channel)
  const p = pipe('100')
  try { await p.sign({ hash: 'S', xdr: tx.toEnvelope().toXDR('base64'), networkFee: '3000000' }); ok('reject approve(trader)', false) }
  catch (e) { ok('reject approve(trader)', /SEP-41 "approve" touching the trader/.test(e.message)) }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
