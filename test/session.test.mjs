import * as S from '@stellar/stellar-sdk'
import { StellarBrokerSession } from '../dist/execution/stellarBroker/StellarBrokerSession.js'
import { keypairSigner, parseBrokerAsset } from '../dist/index.js'

const P = S.Networks.PUBLIC
let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

const trader = S.Keypair.random()
const channel = S.Keypair.random()
const signer = keypairSigner(trader.secret())

function classicSwapXdr() {
  const acc = new S.Account(channel.publicKey(), '42')
  const tx = new S.TransactionBuilder(acc, { fee: '100', networkPassphrase: P })
    .addOperation(S.Operation.pathPaymentStrictSend({
      source: trader.publicKey(), sendAsset: S.Asset.native(), sendAmount: '100',
      destination: trader.publicKey(),
      destAsset: new S.Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
      destMin: '90', path: []
    }))
    .setTimeout(180).build()
  tx.sign(channel)
  return tx.toEnvelope().toXDR('base64')
}

// Minimal mock WebSocket that scripts the broker side.
class MockWebSocket {
  constructor(url) {
    this.url = url
    this.listeners = { message: [], open: [], close: [], error: [] }
    this.sent = []
    // async "open"
    setTimeout(() => {
      this.emit('open', {})
      this.deliver({ type: 'connected', uid: 'UID-1' })
      // heartbeat ping while idle
      this.pingTimer = setInterval(() => this.deliver({ type: 'ping', uid: 'UID-1' }), 30)
    }, 5)
  }
  addEventListener(type, cb) { this.listeners[type]?.push(cb) }
  emit(type, ev) { for (const cb of this.listeners[type] ?? []) cb(ev) }
  deliver(obj) { this.emit('message', { data: JSON.stringify(obj) }) }
  send(str) {
    this.sent.push(str)
    const msg = JSON.parse(str)
    if (msg.type === 'pong') return
    if (msg.type === 'quote') {
      setTimeout(() => this.deliver({ type: 'quote', quote: { status: 'success', estimatedBuyingAmount: '99.5' } }), 5)
    } else if (msg.type === 'trade') {
      this.gotTrade = true
      setTimeout(() => this.deliver({ type: 'progress', sold: '0', bought: '0' }), 5)
      setTimeout(() => this.deliver({ type: 'tx', hash: 'TXHASH-1', xdr: classicSwapXdr(), networkFee: '2000000' }), 10)
    } else if (msg.type === 'tx') {
      // client returned the signed fee-bump; confirm and stop
      this.signedReply = msg
      setTimeout(() => this.deliver({ type: 'stop', status: 'success', sold: '100', bought: '99.4' }), 5)
    }
  }
  close() { clearInterval(this.pingTimer) }
}

const config = {
  networkPassphrase: P,
  brokerWsUrl: 'wss://mock.broker/ws',
  WebSocket: MockWebSocket,
  horizonUrl: 'https://horizon.stellar.org',
  fetch: globalThis.fetch,
  apiBaseUrl: 'x',
  apiKey: 'x',
  requestTimeoutMs: 30000
}

const session = new StellarBrokerSession(config)
const execution = {
  method: 'stellar_broker',
  chain: 'XLM',
  sellingAsset: 'XLM',
  buyingAsset: 'USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  sellingAmount: '100',
  slippageTolerance: 0.01,
  partnerKey: 'PARTNER-XYZ'
}

const phases = []
console.log('\n# StellarBroker session (mock broker)')
const result = await session.run({
  execution,
  signer,
  sellingAsset: parseBrokerAsset(execution.sellingAsset),
  callbacks: {
    onPhase: (p) => phases.push(p),
    onQuote: (q) => { session._lastQuote = q },
    onProgress: () => {}
  }
})

ok('status success', result.status === 'success')
ok('sold reported', result.sold === '100')
ok('bought reported', result.bought === '99.4')
ok('tracking hash present', typeof result.trackingHash === 'string' && result.trackingHash.length === 64)
ok('one signed hash', result.signedHashes.length === 1)
ok('phases advanced through trading', phases.includes('trading') && phases.includes('quoting'))

// verify the signed reply the mock captured is a valid fee-bump signed by the trader
const mockWs = session // can't easily reach; re-run to inspect
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
