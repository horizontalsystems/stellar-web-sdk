/**
 * Route discovery, the fan-out, the solver, route construction and config resolution.
 * Dependency-free and offline: the fan-out is exercised with stub adapters so its timing and
 * error-normalization behaviour is asserted deterministically rather than against live venues.
 * The adapters themselves are covered in `adapters.test.mjs`, tracking in `tracking.test.mjs`.
 */

import {
  discoverProviders,
  isAxelarPair,
  runFanout,
  toProviderError,
  ProviderQuoteError,
  DEFAULT_TUNABLES,
  pickBestPath,
  floorAfterSlippage,
  parseUnits,
  formatUnits,
  encodeInterchainTransfer,
  INTERCHAIN_TRANSFER_SELECTOR,
  findAxelarEntry,
  makeRoute,
  selectRoute,
  selectUnifiedRoute,
  bestByExpected,
  PROVIDER_REGISTRY,
  StellarSwapSDK,
  makeSignedTxExecution,
  makeStellarBrokerExecution,
  makeTransferExecution
} from '../dist/index.js'

let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗ FAIL', name) }
}

const USDC = 'XLM.USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const TRADER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const OTHER = 'GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH'

console.log('\n# route discovery')
{
  const stellar = discoverProviders({ sellAsset: 'XLM.XLM', buyAsset: USDC })
  ok('stellar pair → 4 providers', stellar.providers.length === 4 && stellar.kind === 'stellar')
  ok('stellar pair not crossChain', stellar.crossChain === false)

  const thirdParty = discoverProviders({
    sellAsset: 'XLM.XLM', buyAsset: USDC, sourceAddress: TRADER, destinationAddress: OTHER
  })
  ok('third-party recipient narrows to 2', thirdParty.providers.length === 2)
  ok('third-party excludes STELLARBROKER', !thirdParty.providers.includes('STELLARBROKER'))
  ok('third-party excludes AQUARIUS', !thirdParty.providers.includes('AQUARIUS'))

  const sameAddr = discoverProviders({
    sellAsset: 'XLM.XLM', buyAsset: USDC, sourceAddress: TRADER, destinationAddress: TRADER
  })
  ok('destination == source keeps all 4', sameAddr.providers.length === 4)

  const axelar = discoverProviders({
    sellAsset: 'XLM.XLM', buyAsset: 'ETH.XLM-0X8CF74FC1EC7B2187DDA77EA289F78CC54E2B7C8B'
  })
  ok('axelar pair → AXELAR_ITS', axelar.kind === 'axelar' && axelar.providers[0] === 'AXELAR_ITS')
  ok('axelar pair is crossChain', axelar.crossChain === true)

  const near = discoverProviders({ sellAsset: 'XLM.XLM', buyAsset: 'BTC.BTC' })
  ok('other cross-chain → NEAR', near.kind === 'cross-chain' && near.providers[0] === 'NEAR')

  const explicit = discoverProviders({ sellAsset: 'XLM.XLM', buyAsset: USDC, providers: ['SOROSWAP'] })
  ok('explicit providers override discovery', explicit.providers.length === 1 && explicit.providers[0] === 'SOROSWAP')

  // An ITS asset paired with a DIFFERENT token is not an ITS bridge; it must not shadow NEAR.
  ok('different tokens are not an ITS pair', isAxelarPair('XLM.XLM', 'ETH.SHX-0X516D31321928700C6B4FB0DB0C8C6BC5D6799787') === false)
  ok('same chain both sides is not an ITS pair', isAxelarPair('XLM.XLM', 'XLM.XLM') === false)
  ok('registry carries all six adapters', PROVIDER_REGISTRY.length === 6)
}

console.log('\n# fan-out')
{
  const context = { tunables: { ...DEFAULT_TUNABLES, providerTimeoutMs: 120, overallTimeoutMs: 400 } }
  const request = { sellAsset: 'XLM.XLM', buyAsset: USDC, sellAmount: '100', slippage: 1, dry: true }

  const route = (provider, expected) =>
    makeRoute({
      provider, sellAsset: 'XLM.XLM', sellAmount: '100', buyAsset: USDC,
      expectedBuyAmount: expected, fees: [], estimatedTime: { inbound: 0, swap: 6, outbound: 0, total: 6 }
    })

  const fast = { name: 'FAST', getQuote: async () => route('FAST', '10') }
  const slower = {
    name: 'SLOWER',
    getQuote: async () => { await new Promise((r) => setTimeout(r, 40)); return route('SLOWER', '11') }
  }
  const declines = {
    name: 'DECLINES',
    getQuote: async () => { throw new ProviderQuoteError('routeNotFound', 'no liquidity', { provider: 'DECLINES' }) }
  }
  // Ignores the abort signal entirely — the safety net is what has to settle this one.
  const hangs = { name: 'HANGS', getQuote: () => new Promise(() => {}) }

  const started = Date.now()
  const result = await runFanout([fast, slower, declines, hangs], request, context)
  const elapsed = Date.now() - started

  ok('collects routes from every provider that answered', result.routes.length === 2)
  ok('records an error per declining provider', result.errors.length === 2)
  ok('decline carries its errorCode', result.errors.some((e) => e.provider === 'DECLINES' && e.errorCode === 'routeNotFound'))
  ok('a hung provider times out rather than blocking', result.errors.some((e) => e.provider === 'HANGS' && e.errorCode === 'requestTimeOut'))
  ok('bounded by the per-provider budget', elapsed < 400)
  ok('timings recorded for every called provider', Object.keys(result.timings).length === 4)
  ok('a fast provider is not slowed by a hung one', result.timings.FAST < 100)

  const same = await runFanout([fast], { ...request, buyAsset: 'XLM.XLM' }, context)
  ok('same-asset declines locally with no call', same.routes.length === 0 && same.errors.length === 1)

  // The overall budget has to bound the fan-out even when every provider is individually inside
  // its own allowance.
  const tight = { tunables: { ...DEFAULT_TUNABLES, providerTimeoutMs: 5000, overallTimeoutMs: 100 } }
  const overallStart = Date.now()
  const bounded = await runFanout([hangs], request, tight)
  ok('overall budget bounds a provider with headroom left', Date.now() - overallStart < 400 && bounded.routes.length === 0)

  ok('non-ProviderQuoteError normalizes', toProviderError('X', new Error('boom')).error === 'boom')
}

console.log('\n# route selection')
{
  const r = (provider, expected, minBuyAmount) =>
    makeRoute({
      provider, sellAsset: 'XLM.XLM', sellAmount: '100', buyAsset: USDC,
      expectedBuyAmount: expected, ...(minBuyAmount ? { minBuyAmount } : {}),
      fees: [], estimatedTime: { inbound: 0, swap: 6, outbound: 0, total: 6 }
    })

  // The policy: most output wins, with no provider preferred. This is the assertion that pins the
  // removal of the old StellarBroker-first rule — under it, SB would win this set.
  const picked = selectRoute([r('SOROSWAP', '105'), r('STELLARBROKER', '100'), r('STELLAR_DEX', '103')])
  ok('the best-priced route wins, not StellarBroker', picked.providers[0] === 'SOROSWAP')

  // ...and SB is not penalised either — it wins when it genuinely quotes the most.
  const sbBest = selectRoute([r('SOROSWAP', '100'), r('STELLARBROKER', '106'), r('STELLAR_DEX', '103')])
  ok('StellarBroker wins when it actually quotes the most', sbBest.providers[0] === 'STELLARBROKER')

  ok('order does not matter', selectRoute([r('STELLARBROKER', '100'), r('SOROSWAP', '105')]).providers[0] === 'SOROSWAP')
  ok('a single route is picked', selectRoute([r('AQUARIUS', '1')]).providers[0] === 'AQUARIUS')
  ok('no routes → undefined', selectRoute([]) === undefined)

  // Amounts are compared as decimal strings, so precision beyond a float survives.
  const precise = selectRoute([r('SOROSWAP', '16.3576019'), r('STELLAR_DEX', '16.3576020')])
  ok('compares at full decimal precision', precise.providers[0] === 'STELLAR_DEX')
  ok('ties keep the first route (stable)', selectRoute([r('AQUARIUS', '10'), r('SOROSWAP', '10')]).providers[0] === 'AQUARIUS')

  // The documented escape hatch for a caller who wants a guaranteed floor rather than the highest
  // estimate: SB's minBuyAmount is null, so filtering on it drops the unenforced route.
  const mixed = [r('STELLARBROKER', '106'), r('SOROSWAP', '105', '104'), r('STELLAR_DEX', '103', '102')]
  ok('filtering on an enforced floor excludes StellarBroker',
    bestByExpected(mixed.filter((x) => x.minBuyAmount !== null)).providers[0] === 'SOROSWAP')

  // The remaining preference is about settlement, not price: in-chain beats cross-chain.
  const unified = selectUnifiedRoute([r('NEAR', '200'), r('STELLAR_DEX', '100')])
  ok('Stellar in-chain beats a better cross-chain route', unified.providers[0] === 'STELLAR_DEX')
  ok('best in-chain route still wins within the group',
    selectUnifiedRoute([r('NEAR', '200'), r('STELLAR_DEX', '100'), r('SOROSWAP', '101')]).providers[0] === 'SOROSWAP')
  ok('cross-chain wins when Stellar cannot serve', selectUnifiedRoute([r('NEAR', '200')]).providers[0] === 'NEAR')
  ok('no routes → undefined', selectUnifiedRoute([]) === undefined)
}

console.log('\n# STELLAR_DEX path selection')
{
  const p = (dest, hops) => ({ source_amount: '100', destination_amount: dest, path: new Array(hops).fill({ asset_type: 'native' }) })

  // A two-hop exotic path barely ahead of the direct book must lose: thin-hop quotes evaporate
  // before ledger inclusion, and the direct book does not.
  ok('prefers fewer hops within tolerance', pickBestPath([p('100.0', 2), p('99.9', 0)], 0.5).path.length === 0)
  // Beyond the tolerance, the better price genuinely wins.
  ok('takes a meaningfully better exotic path', pickBestPath([p('100.0', 2), p('98.0', 0)], 0.5).path.length === 2)
  ok('ties break on higher output', pickBestPath([p('99.9', 1), p('100.0', 1)], 0.5).destination_amount === '100.0')
  ok('no records → undefined', pickBestPath([], 0.5) === undefined)
}

console.log('\n# amount math')
{
  ok('floorAfterSlippage 1%', floorAfterSlippage(10_000_000n, 1) === 9_900_000n)
  ok('floorAfterSlippage 0.5%', floorAfterSlippage(10_000_000n, 0.5) === 9_950_000n)
  ok('floorAfterSlippage floors, never rounds up', floorAfterSlippage(3n, 1) === 2n)
  ok('parseUnits 18dp', parseUnits('1.5', 18) === 1_500_000_000_000_000_000n)
  ok('parseUnits truncates past precision', parseUnits('1.9999999', 2) === 199n)
  ok('formatUnits 18dp', formatUnits(1_500_000_000_000_000_000n, 18) === '1.5')
  ok('formatUnits drops trailing zeros', formatUnits(1_000_000n, 6) === '1')
  ok('parseUnits/formatUnits round-trip at 24dp', formatUnits(parseUnits('9.826412465068354254677126', 24), 24) === '9.826412465068354254677126')
}

console.log('\n# Axelar ITS')
{
  const entry = findAxelarEntry('xlm.xlm')
  ok('catalog lookup is case-insensitive', entry?.asset.symbol === 'XLM')
  ok('unknown asset → undefined', findAxelarEntry('XLM.FOO-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN') === undefined)

  // Reference vector generated with viem's encodeFunctionData for
  // interchainTransfer(string,bytes,uint256,bytes). The hand-rolled encoder must match it byte
  // for byte — this is the check that lets the SDK skip an EVM dependency.
  const expected =
    '0xbc0ba3c5' +
    '0000000000000000000000000000000000000000000000000000000000000080' + // offset: destinationChain
    '00000000000000000000000000000000000000000000000000000000000000c0' + // offset: recipient
    '000000000000000000000000000000000000000000000000000000000012d687' + // amount = 1234567
    '0000000000000000000000000000000000000000000000000000000000000120' + // offset: metadata
    '0000000000000000000000000000000000000000000000000000000000000007' + // len("stellar")
    '7374656c6c61720000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' .slice(0, 64) +
    '0000000000000000000000000000000000000000000000000000000000000038' + // len(G-address) = 56
    '474453545253485848474a375a495652425845594535513734585556435553454b45425237554348455555454b37324e3749374b4a364a48' +
    '0000000000000000' + // right-pad of the 56-byte address to 64 bytes
    '0000000000000000000000000000000000000000000000000000000000000000' // len(metadata) = 0

  const got = encodeInterchainTransfer({
    destinationChain: 'stellar',
    recipient: new TextEncoder().encode('GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH'),
    amount: 1234567n
  })
  ok('selector matches keccak preimage', got.startsWith(INTERCHAIN_TRANSFER_SELECTOR))
  ok('encoding matches the viem reference vector', got === expected)
}

console.log('\n# no backend')
{
  // The SDK must construct and be fully usable with no configuration at all — no base URL, no
  // API key, nothing to point at. This is the whole claim of the package, so it is asserted.
  const sdk = new StellarSwapSDK()
  ok('constructs with no config', !!sdk.router && !!sdk.horizon)
  ok('no server fields on the resolved config',
    !('apiBaseUrl' in sdk.config) && !('apiKey' in sdk.config) && !('routing' in sdk.config))
  ok('horizon defaults to public SDF', sdk.config.horizonUrl === 'https://horizon.stellar.org')
  ok('every registered provider is reachable', PROVIDER_REGISTRY.every((p) => typeof p.getQuote === 'function'))

  // Tracking by uuid is a convenience over an in-memory registry; an unknown one must say so
  // clearly rather than silently returning an empty status.
  let threw
  try { await sdk.track('nope-not-a-uuid') } catch (e) { threw = e }
  ok('track() on an unknown uuid explains itself', !!threw && /in-memory/.test(threw.message))
}

console.log('\n# route construction')
{
  const base = {
    provider: 'SOROSWAP', sellAsset: 'XLM.XLM', sellAmount: '100', buyAsset: USDC,
    expectedBuyAmount: '16.35', fees: [], estimatedTime: { inbound: 0, swap: 6, outbound: 0, total: 6 }
  }

  // An absent floor is an explicit null, so "no guaranteed minimum" stays distinguishable from
  // "this client version doesn't know the field".
  ok('omitted minBuyAmount becomes explicit null', makeRoute(base).minBuyAmount === null)
  ok('a real floor is carried through', makeRoute({ ...base, minBuyAmount: '16' }).minBuyAmount === '16')
  // Optional fields are omitted rather than set undefined, so a serialized route stays clean.
  ok('optional fields are omitted, not undefined-valued',
    !('expiresAt' in makeRoute(base)) && !('execution' in makeRoute(base)) && !('tracking' in makeRoute(base)))
  ok('providers is a list carrying the one provider', makeRoute(base).providers.length === 1)

  const signed = makeSignedTxExecution({ chain: 'XLM', xdr: 'AAAA' })
  ok('signed_transaction tags its transaction kind', signed.transactions[0].kind === 'stellar')

  const session = makeStellarBrokerExecution({
    chain: 'XLM', sellingAsset: 'XLM', buyingAsset: 'USDC-G', sellingAmount: '100', slippageTolerance: 0.01
  })
  ok('a broker session carries no transaction', session.transactions === undefined)
  ok('broker slippage stays a fraction', session.slippageTolerance === 0.01)
  ok('an absent partner key is omitted', !('partnerKey' in session))

  const transfer = makeTransferExecution({
    chain: 'BTC', depositAddress: 'bc1q', amount: '1', asset: 'BTC.BTC', sourceAddress: 'bc1qme', canBuildTx: false
  })
  // Naming a source address signals intent to send from it; if the SDK cannot build that chain's
  // deposit, saying so explicitly is what tells the caller to build it themselves.
  ok('an unbuildable origin says why', transfer.unsignedTxUnavailable === 'chain_not_supported')
  const buildable = makeTransferExecution({
    chain: 'XLM', depositAddress: 'G', amount: '1', asset: 'XLM.XLM', sourceAddress: 'GME', canBuildTx: true
  })
  ok('a buildable origin carries no unavailable hint', !('unsignedTxUnavailable' in buildable))
  const noSource = makeTransferExecution({ chain: 'BTC', depositAddress: 'bc1q', amount: '1', asset: 'BTC.BTC' })
  ok('no source address ⇒ no hint (nothing was intended)', !('unsignedTxUnavailable' in noSource))
}

console.log('\n# config')
{
  const sdk = new StellarSwapSDK()
  ok('defaults to mainnet passphrase', sdk.config.networkPassphrase.includes('Public'))
  ok('defaults the broker WebSocket', sdk.config.brokerWsUrl === 'wss://api.stellar.broker/ws')
  ok('defaults the request timeout', sdk.config.requestTimeoutMs === 30_000)
  ok('tunables default to the documented values',
    sdk.config.tunables.providerTimeoutMs === 12_000 && sdk.config.tunables.overallTimeoutMs === 15_000)
  ok('aqua is excluded from the Soroswap venue list by default',
    !sdk.config.tunables.soroswapProtocols.includes('aqua'))
  ok('credentials/fees default to empty, not undefined',
    Object.keys(sdk.config.credentials).length === 0 && Object.keys(sdk.config.serviceFees).length === 0)

  const trailing = new StellarSwapSDK({ horizonUrl: 'https://h.example.com/' })
  ok('trailing slashes are stripped from URLs', trailing.config.horizonUrl === 'https://h.example.com')

  // Every upstream key is passable at construction — that is the whole configuration surface.
  const keys = new StellarSwapSDK({
    credentials: { soroswapApiKey: 'sk_1', stellarBrokerPartnerKey: 'pk_1', nearApiJwt: 'jwt_1' }
  })
  ok('soroswap key is carried', keys.config.credentials.soroswapApiKey === 'sk_1')
  ok('broker partner key is carried', keys.config.credentials.stellarBrokerPartnerKey === 'pk_1')
  ok('1Click jwt is carried', keys.config.credentials.nearApiJwt === 'jwt_1')

  // A vendor RPC key resolves to BOTH endpoints, so a caller never hand-builds the URL.
  const vc = new StellarSwapSDK({ validationCloud: { apiKey: 'vc_key' } })
  ok('vendor key fills Horizon', vc.config.horizonUrl === 'https://mainnet.stellar.validationcloud.io/v1/vc_key')
  ok('vendor key fills Soroban RPC', vc.config.endpoints.sorobanRpcUrl === 'https://mainnet.stellar.validationcloud.io/v1/vc_key')

  const vcHost = new StellarSwapSDK({ validationCloud: { apiKey: 'k', host: 'https://custom.example.com/v1/' } })
  ok('vendor host is overridable', vcHost.config.horizonUrl === 'https://custom.example.com/v1/k')

  // Per-endpoint overrides compose with the vendor key rather than being replaced by it.
  const mixed = new StellarSwapSDK({
    validationCloud: { apiKey: 'k' },
    horizonUrl: 'https://my-horizon.example.com'
  })
  ok('an explicit horizonUrl beats the vendor key', mixed.config.horizonUrl === 'https://my-horizon.example.com')
  ok('...while Soroban still uses the vendor key',
    mixed.config.endpoints.sorobanRpcUrl === 'https://mainnet.stellar.validationcloud.io/v1/k')

  const mixed2 = new StellarSwapSDK({
    validationCloud: { apiKey: 'k' },
    endpoints: { sorobanRpcUrl: 'https://my-rpc.example.com' }
  })
  ok('an explicit sorobanRpcUrl beats the vendor key', mixed2.config.endpoints.sorobanRpcUrl === 'https://my-rpc.example.com')
  ok('...while Horizon still uses the vendor key',
    mixed2.config.horizonUrl === 'https://mainnet.stellar.validationcloud.io/v1/k')

  // No vendor key ⇒ the public endpoints, and no phantom sorobanRpcUrl on the resolved config.
  ok('no vendor key leaves Soroban unset (adapter default applies)',
    new StellarSwapSDK().config.endpoints.sorobanRpcUrl === undefined)
  ok('an empty vendor key is ignored rather than building a broken URL',
    new StellarSwapSDK({ validationCloud: { apiKey: '' } }).config.horizonUrl === 'https://horizon.stellar.org')
  // Other endpoint overrides must survive the merge that fills sorobanRpcUrl.
  ok('unrelated endpoint overrides are preserved',
    new StellarSwapSDK({ validationCloud: { apiKey: 'k' }, endpoints: { soroswapUrl: 'https://s.example.com' } })
      .config.endpoints.soroswapUrl === 'https://s.example.com')

  const overridden = new StellarSwapSDK({ tunables: { providerTimeoutMs: 500 } })
  ok('a partial tunables override keeps the other defaults',
    overridden.config.tunables.providerTimeoutMs === 500 && overridden.config.tunables.overallTimeoutMs === 15_000)

  // The SDK calls `config.fetch(...)` as a method, so an unbound global would run with the wrong
  // receiver and throw "Illegal invocation" in a browser.
  ok('the default fetch is callable detached', typeof sdk.config.fetch === 'function' && (() => {
    const f = sdk.config.fetch
    try { f('data:,'); return true } catch { return false }
  })())
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
