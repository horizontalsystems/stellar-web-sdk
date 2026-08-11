/**
 * Shared test scaffolding: a tiny assertion helper plus stub upstreams.
 *
 * Every adapter reaches the network through exactly two seams — `context.fetch` and
 * `context.horizon` — so stubbing those two is enough to drive any adapter offline and assert on
 * both what it SENDS (the request bodies below are captured) and what it MAKES of the response.
 */

import { Networks } from '@stellar/stellar-sdk'
import { DEFAULT_TUNABLES } from '../dist/index.js'

export function harness() {
  let pass = 0
  let fail = 0
  return {
    ok(name, cond) {
      if (cond) { pass++; console.log('  ✓', name) }
      else { fail++; console.log('  ✗ FAIL', name) }
    },
    /** Assert that `fn` throws, and hand the error to an optional predicate. */
    async throws(name, fn, predicate) {
      try {
        await fn()
        this.ok(name, false)
      } catch (err) {
        this.ok(name, predicate ? predicate(err) : true)
      }
    },
    section(title) { console.log(`\n# ${title}`) },
    done() {
      console.log(`\n${pass} passed, ${fail} failed`)
      process.exit(fail ? 1 : 0)
    }
  }
}

/**
 * A `fetch` stub driven by a list of `[matcher, response]` routes. Every call is recorded on
 * `.calls` so a test can assert on the request the adapter built, which is where most of the
 * normalization logic actually shows up.
 */
export function stubFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    const call = { url: String(url), method: init.method ?? 'GET', body, headers: init.headers ?? {} }
    calls.push(call)

    for (const [matcher, response] of routes) {
      if (!String(url).includes(matcher)) continue
      const resolved = typeof response === 'function' ? response(call) : response
      const { status = 200, json, text } = resolved
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (text !== undefined ? text : JSON.stringify(json))
      }
    }
    throw new Error(`stubFetch: no route for ${url}`)
  }
  impl.calls = calls
  return impl
}

/** A Horizon stub. `account` is returned for every lookup unless `accounts` maps one explicitly. */
export function stubHorizon({ account, accounts, transaction, effects, paths } = {}) {
  const reads = []
  return {
    reads,
    async getAccount(id) {
      reads.push({ op: 'getAccount', id })
      if (accounts && id in accounts) return accounts[id]
      return account ?? null
    },
    async strictSendPaths(args) {
      reads.push({ op: 'strictSendPaths', args })
      return paths ?? []
    },
    async getTransaction(hash) {
      reads.push({ op: 'getTransaction', hash })
      return transaction ?? null
    },
    async transactionEffects(hash) {
      reads.push({ op: 'transactionEffects', hash })
      return effects ?? []
    }
  }
}

/** A funded account holding a trustline for every asset the tests buy. */
export function fundedAccount(sequence = '1234') {
  return {
    id: 'GTEST',
    sequence,
    balances: [
      { balance: '1000', asset_type: 'native' },
      { balance: '500', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER },
      { balance: '10', asset_type: 'credit_alphanum4', asset_code: 'SHX', asset_issuer: SHX_ISSUER }
    ]
  }
}

/** Assemble a ProviderContext around the stubs. */
export function context({ fetch, horizon, credentials, endpoints, serviceFees, tunables } = {}) {
  return {
    config: { networkPassphrase: Networks.PUBLIC, requestTimeoutMs: 5000 },
    horizon: horizon ?? stubHorizon(),
    credentials: credentials ?? {},
    endpoints: endpoints ?? {},
    tunables: { ...DEFAULT_TUNABLES, ...tunables },
    serviceFees: serviceFees ?? {},
    fetch: fetch ?? (() => { throw new Error('no fetch stub configured') })
  }
}

export const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
export const SHX_ISSUER = 'GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH'
export const USDC = `XLM.USDC-${USDC_ISSUER}`
export const XLM = 'XLM.XLM'
export const TRADER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
export const OTHER = SHX_ISSUER

/** A dry request for the given pair. */
export function req(overrides = {}) {
  return { sellAsset: XLM, buyAsset: USDC, sellAmount: '100', slippage: 1, dry: true, ...overrides }
}
