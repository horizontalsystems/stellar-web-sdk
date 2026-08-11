/**
 * Shared env loader for the example apps.
 *
 * All three examples read the SAME repository-root `.env`, so there is one place to put
 * credentials while trying them out. This file only READS them — every value is passed straight
 * into `new StellarSwapSDK({ … })`, so nothing here is example-only plumbing a real consumer
 * would have to reimplement.
 *
 * These values are injected into a BROWSER bundle, which makes them readable by anyone who opens
 * the page. That is fine for a local demo and wrong for production: ship a proxy that attaches the
 * keys server-side instead (see the note in each example's README).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Parse a dotenv file into a plain object. Missing file ⇒ empty, which is a valid setup. */
function parseEnvFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const out = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    // Strip surrounding quotes; leave everything else verbatim.
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key && value) out[key] = value
  }
  return out
}

/**
 * The example-facing config, resolved from the repo-root `.env`. Every field maps 1:1 onto a
 * `StellarSwapConfig` field — the SDK resolves the Validation Cloud key into its Horizon and
 * Soroban endpoints itself, so no URL is built here.
 */
export function loadExampleEnv() {
  const env = { ...parseEnvFile(join(repoRoot, '.env')), ...process.env }
  return {
    soroswapApiKey: env.SOROSWAP_API_KEY ?? '',
    stellarBrokerPartnerKey: env.STELLARBROKER_PARTNER_KEY ?? '',
    nearApiJwt: env.NEAR_1CLICK_JWT ?? '',
    validationCloudApiKey: env.VALIDATION_CLOUD_API_KEY ?? '',
    validationCloudHost: env.VALIDATION_CLOUD_HOST ?? ''
  }
}

/** esbuild `define` entries — compile-time constants the example bundles read. */
export function defineEntries() {
  const cfg = loadExampleEnv()
  return {
    __SOROSWAP_API_KEY__: JSON.stringify(cfg.soroswapApiKey),
    __STELLARBROKER_PARTNER_KEY__: JSON.stringify(cfg.stellarBrokerPartnerKey),
    __NEAR_API_JWT__: JSON.stringify(cfg.nearApiJwt),
    __VALIDATION_CLOUD_API_KEY__: JSON.stringify(cfg.validationCloudApiKey),
    __VALIDATION_CLOUD_HOST__: JSON.stringify(cfg.validationCloudHost)
  }
}

/** One line per credential, saying whether it resolved — without printing any of the values. */
export function describeEnv() {
  const cfg = loadExampleEnv()
  const mark = (v) => (v ? 'set' : 'not set (optional)')
  return [
    `  soroswap key            ${mark(cfg.soroswapApiKey)}`,
    `  stellarbroker partner   ${mark(cfg.stellarBrokerPartnerKey)}`,
    `  near 1click jwt         ${mark(cfg.nearApiJwt)}`,
    `  validation cloud key    ${cfg.validationCloudApiKey ? 'set (Horizon + Soroban RPC)' : 'not set — public endpoints'}`
  ].join('\n')
}
