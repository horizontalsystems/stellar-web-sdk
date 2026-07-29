// SDK construction helpers — the only module that imports stellar-web-sdk directly.
import { StellarSwapSDK, keypairSigner } from 'stellar-web-sdk'

/** Build a fresh SDK from the API credentials. */
export function createSdk({ apiBaseUrl, apiKey }) {
  return new StellarSwapSDK({ apiBaseUrl, apiKey })
}

/** Derive an in-memory signer from a secret seed, or undefined if it's blank/invalid. */
export function createSigner(secret) {
  const seed = (secret || '').trim()
  if (!seed.startsWith('S')) return undefined
  try {
    return keypairSigner(seed)
  } catch {
    return undefined
  }
}
