import {
  FeeBumpTransaction,
  Keypair,
  Transaction,
  authorizeEntry,
  hash,
  xdr
} from '@stellar/stellar-sdk'
import { StellarSwapError } from './errors.js'
import { isStellarAccountId } from './assets.js'

/**
 * Key custody stays with the caller. The SDK never sees a secret key — it asks the signer to
 * produce a raw ed25519 signature over specific bytes (a transaction hash or a Soroban auth
 * preimage hash). This minimal surface is enough to implement everything the StellarBroker
 * pipeline needs (classic fee-bumps + Soroban two-phase auth-entry signing) and works equally
 * for an in-memory keypair, a hardware wallet, or a remote signer.
 */
export interface StellarSigner {
  /** The trader's account (`G…`). */
  readonly publicKey: string
  /** Raw ed25519 signature (64 bytes) over `data`. */
  sign(data: Uint8Array): Promise<Uint8Array> | Uint8Array
}

/** Wrap a Stellar secret seed (`S…`) as a signer. Convenience for server-side / testing use. */
export function keypairSigner(secretKey: string): StellarSigner {
  const kp = Keypair.fromSecret(secretKey)
  return {
    publicKey: kp.publicKey(),
    sign: (data) => kp.sign(Buffer.from(data))
  }
}

/** The 4-byte signature hint for a public key (last 4 bytes of the raw key). */
export function signatureHint(publicKey: string): Buffer {
  return Keypair.fromPublicKey(publicKey).signatureHint()
}

/**
 * Sign a transaction with a `StellarSigner` and append the decorated signature IN PLACE.
 * Equivalent to `tx.sign(keypair)` but going through the raw-signer interface.
 */
export async function signTransaction(
  tx: Transaction | FeeBumpTransaction,
  signer: StellarSigner
): Promise<void> {
  const sig = await signer.sign(tx.hash())
  const decorated = new xdr.DecoratedSignature({
    hint: signatureHint(signer.publicKey),
    signature: Buffer.from(sig)
  })
  tx.signatures.push(decorated)
}

/**
 * Cryptographically verify that `tx` already carries a valid signature FROM `publicKey`.
 *
 * This is the trader-signature detection the broker session requires: it must be a real
 * verification, NOT a 4-byte-hint comparison (spoofable) nor "has any signature" (StellarBroker's
 * channel accounts pre-sign classic txs, so a signature is always present). We check every
 * decorated signature against the trader key over the tx's signature-base hash.
 */
export function txCarriesSignatureFrom(tx: Transaction | FeeBumpTransaction, publicKey: string): boolean {
  const kp = Keypair.fromPublicKey(publicKey)
  const payload = tx.hash()
  for (const decorated of tx.signatures) {
    try {
      if (kp.verify(payload, decorated.signature())) return true
    } catch {
      // A malformed signature just isn't the trader's — keep scanning.
    }
  }
  return false
}

/**
 * `authorizeEntry`-compatible signing callback for `StellarSigner`. The SDK passes this to
 * `@stellar/stellar-sdk`'s `authorizeEntry`, which hands us the `HashIdPreimage`; we hash its
 * XDR and sign it, returning `{ signature, publicKey }`.
 */
export function authEntrySigner(signer: StellarSigner) {
  return async (preimage: xdr.HashIdPreimage): Promise<{ signature: Buffer; publicKey: string }> => {
    const payload = hash(preimage.toXDR())
    const signature = await signer.sign(payload)
    return { signature: Buffer.from(signature), publicKey: signer.publicKey }
  }
}

/**
 * Sign a single Soroban authorization entry for the trader with the given expiration ledger.
 * Entries whose credentials aren't `sorobanCredentialsAddress` are returned unchanged (that's
 * `authorizeEntry`'s own contract — e.g. source-account credentials need no signature).
 */
export async function signAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: StellarSigner,
  validUntilLedgerSeq: number,
  networkPassphrase: string
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(entry, authEntrySigner(signer), validUntilLedgerSeq, networkPassphrase)
}

/** Assert `publicKey` is a well-formed Stellar account, throwing a typed error otherwise. */
export function assertAccount(publicKey: string, label = 'address'): void {
  if (!isStellarAccountId(publicKey)) {
    throw new StellarSwapError('invalid_params', `Invalid Stellar ${label}: ${JSON.stringify(publicKey)}`)
  }
}
