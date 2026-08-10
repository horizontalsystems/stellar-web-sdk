/**
 * A minimal ABI encoder for the ONE EVM call this SDK ever builds:
 * `interchainTransfer(string destinationChain, bytes recipient, uint256 amount, bytes metadata)`
 * on an ITS-deployed InterchainToken.
 *
 * The server reaches for `viem` here. Pulling a full EVM library into a Stellar SDK to encode a
 * single static signature is not a trade worth making, so this encodes that one call by hand. The
 * selector is precomputed (keccak256 of the signature, first 4 bytes) rather than derived at
 * runtime, which is why no hashing dependency is needed — the preimage is recorded below so the
 * constant is checkable, and `test/axelar.test.mjs` asserts the full encoding against a
 * viem-generated reference vector.
 */

/** keccak256("interchainTransfer(string,bytes,uint256,bytes)")[0..4] */
export const INTERCHAIN_TRANSFER_SELECTOR = '0xbc0ba3c5'

const WORD = 32

/** Left-pad a hex quantity to one 32-byte word. */
function word(value: bigint): string {
  return value.toString(16).padStart(WORD * 2, '0')
}

/**
 * Encode a dynamic `bytes`/`string` argument: a length word followed by the payload, right-padded
 * to a whole number of words.
 */
function dynamicBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  const padded = hex.padEnd(Math.ceil(hex.length / (WORD * 2)) * WORD * 2, '0')
  return word(BigInt(bytes.length)) + padded
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** Parse a `0x…` hex string into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  if (body.length % 2 !== 0) throw new Error(`Odd-length hex string: ${hex}`)
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** A bigint as a minimal `0x…` hex quantity, the form JSON-RPC expects for `value`/`gasPrice`. */
export function toHexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`
}

/**
 * Encode the `interchainTransfer` calldata.
 *
 * Argument layout: four head words (offset, offset, amount, offset) followed by the three dynamic
 * payloads. `amount` is static and sits inline in the head; the other three are dynamic and the
 * head carries their offsets, measured from the start of the argument block.
 */
export function encodeInterchainTransfer(args: {
  destinationChain: string
  /** The recipient encoding is chain-specific — raw 20 bytes for EVM, UTF-8 for a Stellar G-address. */
  recipient: Uint8Array
  amount: bigint
  metadata?: Uint8Array
}): string {
  const metadata = args.metadata ?? new Uint8Array(0)

  const chainPayload = dynamicBytes(utf8(args.destinationChain))
  const recipientPayload = dynamicBytes(args.recipient)
  const metadataPayload = dynamicBytes(metadata)

  // Four arguments ⇒ a 4-word head. Offsets are byte counts, so each hex payload contributes
  // half its length.
  const headBytes = 4 * WORD
  const chainOffset = BigInt(headBytes)
  const recipientOffset = chainOffset + BigInt(chainPayload.length / 2)
  const metadataOffset = recipientOffset + BigInt(recipientPayload.length / 2)

  const head = word(chainOffset) + word(recipientOffset) + word(args.amount) + word(metadataOffset)

  return INTERCHAIN_TRANSFER_SELECTOR + head + chainPayload + recipientPayload + metadataPayload
}
