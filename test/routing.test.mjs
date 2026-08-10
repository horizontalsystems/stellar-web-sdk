/**
 * Route discovery, the provider fan-out, and the pieces of the adapters that are pure logic.
 * Dependency-free and offline: the fan-out is exercised with stub adapters so the timing and
 * error-normalization behaviour is asserted deterministically rather than against live venues.
 * Live coverage lives in `bench/` and `test/live.mjs`.
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
  PROVIDER_REGISTRY
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

console.log('\n# waterfall solver')
{
  const r = (provider, expected) =>
    makeRoute({
      provider, sellAsset: 'XLM.XLM', sellAmount: '100', buyAsset: USDC,
      expectedBuyAmount: expected, fees: [], estimatedTime: { inbound: 0, swap: 6, outbound: 0, total: 6 }
    })

  // The documented policy: StellarBroker wins even when a fallback shows a higher number.
  const picked = selectRoute([r('SOROSWAP', '105'), r('STELLARBROKER', '100'), r('STELLAR_DEX', '103')])
  ok('SB wins over a nominally better fallback', picked.providers[0] === 'STELLARBROKER')

  const noBroker = selectRoute([r('SOROSWAP', '105'), r('STELLAR_DEX', '103')])
  ok('without SB, best expected wins', noBroker.providers[0] === 'SOROSWAP')

  // The second, broader preference: any Stellar in-chain route beats any cross-chain one.
  const unified = selectUnifiedRoute([r('NEAR', '200'), r('STELLAR_DEX', '100')])
  ok('Stellar in-chain beats a better cross-chain route', unified.providers[0] === 'STELLAR_DEX')
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
