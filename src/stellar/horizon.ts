import { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk'
import { ResolvedConfig } from '../core/config.js'
import { StellarSwapError } from '../core/errors.js'
import { StellarAsset, horizonAssetType, isNativeAsset } from '../core/assets.js'

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
    return {
      hash: String(body.hash ?? ''),
      successful: body.successful === true,
      ledger: typeof body.ledger === 'number' ? body.ledger : undefined,
      raw: body
    }
  }

  /** Fetch account state, or `null` if the account does not exist (404). */
  async getAccount(accountId: string): Promise<HorizonAccount | null> {
    const res = await this.fetch(`/accounts/${accountId}`, { method: 'GET' })
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
   * Latest ledger sequence (for computing auth-entry expiration when a tx doesn't carry an
   * explicit `maxLedger`). Reads `GET /ledgers?order=desc&limit=1`.
   */
  async latestLedger(): Promise<number> {
    const res = await this.fetch(`/ledgers?order=desc&limit=1`, { method: 'GET' })
    const body = (await res.json().catch(() => ({}))) as {
      _embedded?: { records?: { sequence?: number }[] }
    }
    const seq = body._embedded?.records?.[0]?.sequence
    if (!res.ok || typeof seq !== 'number') {
      throw new StellarSwapError('server_error', `Horizon /ledgers failed (${res.status})`, { status: res.status })
    }
    return seq
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.config.horizonUrl}${path}`
    try {
      return await this.config.fetch(url, init)
    } catch (err) {
      throw new StellarSwapError('server_error', `Horizon network error on ${path}: ${(err as Error).message}`, {
        cause: err
      })
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
