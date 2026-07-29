import { Asset } from '@stellar/stellar-sdk'
import { StellarSwapError } from './errors.js'

/**
 * Stellar asset identity + format conversions. The one hard rule everywhere: asset codes are
 * CASE-SENSITIVE (`yXLM` ≠ `YXLM`) — this module never upper/lower-cases a code. Issuers are
 * StrKey (uppercase by definition), so their case is fixed anyway.
 *
 * Soroban-only (`C…` contract) tokens are NOT supported — only native XLM and classic assets.
 */

export interface StellarAsset {
  /** Case-sensitive asset code, or `XLM` for the native asset. */
  code: string
  /** Issuer account (`G…`). Absent for native XLM. */
  issuer?: string
  /** Canonical uswap identifier, e.g. `XLM.XLM` or `XLM.USDC-GA5ZSE…`. */
  identifier: string
}

/** Ed25519 public key (account / classic-asset issuer): `G` + 55 base32 chars. */
export function isStellarAccountId(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value)
}

/** Soroban contract id: `C` + 55 base32 chars. */
export function isStellarContractId(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value)
}

/** Classic asset code: 1–12 alphanumeric (alphanum4/alphanum12). */
export function isStellarAssetCode(value: string): boolean {
  return /^[A-Za-z0-9]{1,12}$/.test(value)
}

function isNativeCode(code: string): boolean {
  // Native is spelled `XLM` with no issuer. Note: a classic asset ALSO coded `XLM` but with
  // an issuer is a different (non-native) asset — only the issuer-less form is native.
  return code === 'XLM'
}

/**
 * Parse a Stellar asset identifier into `{ code, issuer, identifier }`. Accepts:
 *   `XLM.XLM`                          → native
 *   `XLM.CODE-GISSUER…`                → classic (uswap canonical)
 *   `CODE-GISSUER…`                    → classic (chain-less)
 *   `CODE:ISSUER`                      → classic (Horizon form)
 *   `XLM`                              → native (bare)
 * Codes are preserved verbatim (case-sensitive). Soroban `C…` ids are rejected.
 */
export function parseStellarAssetIdentifier(raw: string): StellarAsset {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new StellarSwapError('invalid_asset', `Empty Stellar asset identifier`)
  }
  let body = raw.trim()

  // Strip a leading `XLM.` chain prefix if present (but keep `XLM.XLM` → body `XLM`).
  if (body.startsWith('XLM.')) body = body.slice('XLM.'.length)

  // Bare native.
  if (body === 'XLM' || body === 'native') {
    return { code: 'XLM', identifier: 'XLM.XLM' }
  }

  // Split code / issuer on `-` or `:` (issuer is a G-address, which never contains either).
  const sep = body.includes('-') ? '-' : body.includes(':') ? ':' : ''
  if (!sep) {
    throw new StellarSwapError(
      'invalid_asset',
      `Classic Stellar asset must be CODE-ISSUER or CODE:ISSUER: ${JSON.stringify(raw)}`
    )
  }
  const idx = body.indexOf(sep)
  const code = body.slice(0, idx)
  const issuer = body.slice(idx + 1)

  if (isStellarContractId(code) || isStellarContractId(issuer)) {
    throw new StellarSwapError(
      'invalid_asset',
      `Soroban contract (C…) assets are not supported — use native XLM or a classic CODE-ISSUER: ${JSON.stringify(raw)}`
    )
  }
  if (!isStellarAssetCode(code)) {
    throw new StellarSwapError('invalid_asset', `Invalid asset code ${JSON.stringify(code)} in ${JSON.stringify(raw)}`)
  }
  if (!isStellarAccountId(issuer)) {
    throw new StellarSwapError('invalid_asset', `Invalid issuer ${JSON.stringify(issuer)} in ${JSON.stringify(raw)}`)
  }

  return { code, issuer, identifier: `XLM.${code}-${issuer}` }
}

/** `true` for native XLM. */
export function isNativeAsset(asset: StellarAsset): boolean {
  return isNativeCode(asset.code) && !asset.issuer
}

/** `@stellar/stellar-sdk` `Asset` for XDR building / SAC derivation. */
export function toStellarSdkAsset(asset: StellarAsset): Asset {
  if (isNativeAsset(asset)) return Asset.native()
  if (!asset.issuer) throw new StellarSwapError('invalid_asset', `Classic asset ${asset.code} is missing an issuer`)
  return new Asset(asset.code, asset.issuer)
}

/**
 * StellarBroker / SB-wire asset id: `XLM` native or `CODE-GISSUER…` classic. This is also the
 * base form the Horizon and Soroswap encodings derive from.
 */
export function stellarAssetId(asset: StellarAsset): string {
  return isNativeAsset(asset) ? 'XLM' : `${asset.code}-${asset.issuer}`
}

/** Horizon asset string: `native` or `CODE:ISSUER`. */
export function horizonAssetString(asset: StellarAsset): string {
  return isNativeAsset(asset) ? 'native' : `${asset.code}:${asset.issuer}`
}

/** Horizon `asset_type` discriminator. */
export function horizonAssetType(asset: StellarAsset): 'native' | 'credit_alphanum4' | 'credit_alphanum12' {
  if (isNativeAsset(asset)) return 'native'
  return asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
}

/**
 * The Stellar Asset Contract (SAC) contract id for this asset on the given network. Deterministic
 * — derived locally, no RPC. Used by the StellarBroker signing pipeline to verify a Soroban
 * `transfer(from=trader,…)` debits the SELLING asset's SAC and nothing else.
 */
export function sacContractId(asset: StellarAsset, networkPassphrase: string): string {
  return toStellarSdkAsset(asset).contractId(networkPassphrase)
}

/**
 * Parse an SB-wire asset (`XLM` or `CODE-GISSUER…`, no chain prefix) as it appears in the
 * `stellar_broker` execution block. Kept separate from `parseStellarAssetIdentifier` only for
 * intent clarity; it accepts the same forms.
 */
export function parseBrokerAsset(wire: string): StellarAsset {
  return parseStellarAssetIdentifier(wire)
}
