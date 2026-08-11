import { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk'
import { ResolvedConfig } from '../core/config.js'
import { StellarSwapError } from '../core/errors.js'
import { StellarAsset, horizonAssetString, horizonAssetType, isNativeAsset } from '../core/assets.js'

/** One effect from `GET /transactions/{hash}/effects`. Amounts are 7-dp decimal strings. */
export interface HorizonEffect {
  type: string
  account?: string
  asset_type?: string
  asset_code?: string
  asset_issuer?: string
  amount?: string
  paging_token?: string
}

/** One alternative returned by Horizon path-finding. Amounts are 7-dp decimal strings. */
export interface HorizonPathRecord {
  source_amount: string
  destination_amount: string
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[]
}

/** A single balance line from Horizon's `/accounts/{id}` response. */
export interface HorizonBalance {
  balance: string
  asset_type: string
  asset_code?: string
  asset_issuer?: string
  limit?: string
}

export interface HorizonAccount {
  id: string
  sequence: string
  balances: HorizonBalance[]
}

export interface HorizonSubmitResult {
  /** The transaction hash Horizon recorded (the outer/fee-bump hash when fee-bumped). */
  hash: string
  successful: boolean
  ledger?: number
  raw: unknown
}

/**
 * Minimal Horizon client over `fetch` — submit a signed envelope and read account state.
 * Deliberately avoids `@stellar/stellar-sdk`'s `Horizon.Server` (which drags in axios +
 * eventsource) so the SDK stays small and browser-friendly.
 */
export class HorizonClient {
  constructor(private readonly config: ResolvedConfig) {}

  /**
   * Submit a signed transaction envelope to Horizon (`POST /transactions`). Horizon holds the
   * request open until the tx is included in a ledger, so success/failure is known on return.
   */
  async submit(tx: Transaction | FeeBumpTransaction): Promise<HorizonSubmitResult> {
    const xdr = tx.toEnvelope().toXDR('base64')
    return this.submitXdr(xdr)
  }

  /**
   * Submit a base64 TransactionEnvelope to `POST /transactions`. Intentionally has NO client
   * timeout — Horizon holds the request open until the tx is included in a ledger, so the outcome
   * is known on return. CAVEAT: a Horizon 504 (or a dropped connection) surfaces as `submit_failed`,
   * but the transaction MAY still have landed — reconcile by hash before assuming it didn't.
   */
  async submitXdr(xdrBase64: string): Promise<HorizonSubmitResult> {
    const res = await this.fetch(`/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tx: xdrBase64 }).toString()
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      // Horizon surfaces failures as a problem+json body with result codes under extras.
      const extras = (body.extras ?? {}) as { result_codes?: unknown }
      throw new StellarSwapError('submit_failed', `Horizon rejected the transaction (${res.status})`, {
        status: res.status,
        details: { title: body.title, detail: body.detail, result_codes: extras.result_codes, body }
      })
    }
    const hash = String(body.hash ?? '')
    if (!hash) {
      // A 2xx with no hash can't be tracked — treat it as a failure rather than emit an empty hash.
      throw new StellarSwapError('submit_failed', 'Horizon returned success with no transaction hash', {
        status: res.status,
        details: body
      })
    }
    return {
      hash,
      successful: body.successful === true,
      ledger: typeof body.ledger === 'number' ? body.ledger : undefined,
      raw: body
    }
  }

  /** Fetch account state, or `null` if the account does not exist (404). */
  async getAccount(accountId: string): Promise<HorizonAccount | null> {
    const res = await this.fetch(`/accounts/${encodeURIComponent(accountId)}`, { method: 'GET' }, this.config.requestTimeoutMs)
    if (res.status === 404) return null
    const body = (await res.json().catch(() => ({}))) as HorizonAccount & Record<string, unknown>
    if (!res.ok) {
      throw new StellarSwapError('server_error', `Horizon /accounts failed (${res.status})`, {
        status: res.status,
        details: body
      })
    }
    return body
  }

  /**
   * `GET /paths/strict-send` — every path alternative for an exact-input swap into one
   * destination asset. Traverses BOTH the SDEX order book and classic liquidity pools together
   * (protocol 18 path-finding does not let you constrain the venue split, and attribution is only
   * knowable post-trade). The caller picks among the alternatives; see the STELLAR_DEX adapter for
   * why the highest `destination_amount` is not simply taken.
   */
  async strictSendPaths(
    args: {
      sourceAsset: StellarAsset
      sourceAmount: string
      destinationAsset: StellarAsset
    },
    signal?: AbortSignal
  ): Promise<HorizonPathRecord[]> {
    const params = new URLSearchParams({
      source_asset_type: horizonAssetType(args.sourceAsset),
      source_amount: args.sourceAmount,
      destination_assets: horizonAssetString(args.destinationAsset)
    })
    if (!isNativeAsset(args.sourceAsset)) {
      params.set('source_asset_code', args.sourceAsset.code)
      params.set('source_asset_issuer', args.sourceAsset.issuer!)
    }

    const res = await this.fetch(`/paths/strict-send?${params.toString()}`, { method: 'GET', signal }, this.config.requestTimeoutMs)
    const body = (await res.json().catch(() => ({}))) as {
      _embedded?: { records?: HorizonPathRecord[] }
    }
    if (!res.ok) {
      throw new StellarSwapError('server_error', `Horizon /paths/strict-send failed (${res.status})`, {
        status: res.status,
        details: body
      })
    }
    return body._embedded?.records ?? []
  }

  /**
   * `GET /transactions/{hash}` — the settled transaction, or `null` when Horizon has not indexed
   * it (404). A fee-bumped transaction resolves by either its outer or its inner hash.
   */
  async getTransaction(
    hash: string,
    signal?: AbortSignal
  ): Promise<{ successful: boolean; source_account?: string; ledger?: number } | null> {
    const res = await this.fetch(
      `/transactions/${encodeURIComponent(hash)}`,
      { method: 'GET', signal },
      this.config.requestTimeoutMs
    )
    if (res.status === 404) return null
    const body = (await res.json().catch(() => ({}))) as {
      successful?: boolean
      source_account?: string
      ledger?: number
    }
    if (!res.ok) {
      throw new StellarSwapError('server_error', `Horizon /transactions failed (${res.status})`, {
        status: res.status,
        details: body
      })
    }
    return { successful: body.successful === true, source_account: body.source_account, ledger: body.ledger }
  }

  /**
   * All effects of a transaction, following Horizon's cursor. A busy transaction — a broker
   * multi-hop trade emits counterparty effects per hop — can exceed one page, and a silently
   * truncated list would understate the settled amount, so pages are followed until a short one.
   */
  async transactionEffects(hash: string, signal?: AbortSignal): Promise<HorizonEffect[]> {
    const PAGE_LIMIT = 200
    const MAX_PAGES = 10 // safety valve: 2000 effects is far beyond any real swap
    const all: HorizonEffect[] = []
    let cursor: string | undefined

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) })
      if (cursor) params.set('cursor', cursor)
      const res = await this.fetch(
        `/transactions/${encodeURIComponent(hash)}/effects?${params.toString()}`,
        { method: 'GET', signal },
        this.config.requestTimeoutMs
      )
      if (!res.ok) {
        if (res.status === 404) break
        throw new StellarSwapError('server_error', `Horizon /effects failed (${res.status})`, { status: res.status })
      }
      const body = (await res.json().catch(() => ({}))) as { _embedded?: { records?: HorizonEffect[] } }
      const records = body._embedded?.records ?? []
      all.push(...records)
      if (records.length < PAGE_LIMIT) break
      cursor = records[records.length - 1]?.paging_token
      if (!cursor) break
    }
    return all
  }

  /**
   * Latest ledger sequence (for computing auth-entry expiration when a tx doesn't carry an
   * explicit `maxLedger`). Reads `GET /ledgers?order=desc&limit=1`.
   */
  async latestLedger(): Promise<number> {
    const res = await this.fetch(`/ledgers?order=desc&limit=1`, { method: 'GET' }, this.config.requestTimeoutMs)
    const body = (await res.json().catch(() => ({}))) as {
      _embedded?: { records?: { sequence?: number }[] }
    }
    const seq = body._embedded?.records?.[0]?.sequence
    if (!res.ok || typeof seq !== 'number') {
      throw new StellarSwapError('server_error', `Horizon /ledgers failed (${res.status})`, { status: res.status })
    }
    return seq
  }

  /**
   * `fetch` wrapper. `timeoutMs` guards the reads (an unbounded Horizon read could hang forever);
   * `submit` passes none on purpose, since it must stay open until ledger inclusion.
   */
  private async fetch(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const url = `${this.config.horizonUrl}${path}`
    const controller = timeoutMs ? new AbortController() : undefined
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    // Cascade a caller-supplied signal (the fan-out's per-provider budget) into our timeout
    // controller — otherwise replacing `init.signal` below would silently drop it, and a
    // provider that blew its budget would keep this read alive in the background.
    const callerSignal = init.signal
    const onCallerAbort = () => controller?.abort()
    if (controller && callerSignal) {
      if (callerSignal.aborted) controller.abort()
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
    try {
      return await this.config.fetch(url, controller ? { ...init, signal: controller.signal } : init)
    } catch (err) {
      if (callerSignal?.aborted) {
        throw new StellarSwapError('aborted', `Horizon request to ${path} was aborted`, { cause: err })
      }
      if (controller?.signal.aborted) {
        throw new StellarSwapError('timeout', `Horizon request to ${path} timed out after ${timeoutMs}ms`, { cause: err })
      }
      throw new StellarSwapError('server_error', `Horizon network error on ${path}: ${(err as Error).message}`, {
        cause: err
      })
    } finally {
      if (timer) clearTimeout(timer)
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort)
    }
  }
}

/**
 * Whether `account` already holds a usable trustline for `asset`. Native XLM never needs a
 * trustline. A missing account (`null`) has no trustlines. Codes are matched case-sensitively.
 */
export function accountHoldsTrustline(account: HorizonAccount | null, asset: StellarAsset): boolean {
  if (isNativeAsset(asset)) return true
  if (!account) return false
  const wantType = horizonAssetType(asset)
  return account.balances.some(
    (b) => b.asset_type === wantType && b.asset_code === asset.code && b.asset_issuer === asset.issuer
  )
}
