/**
 * Stellar amount math. Classic assets and native XLM are all 7-decimal fixed-point
 * ("stroops"). Ported from `uswap-server/src/toolboxes/stellar.ts` so the amount the SDK
 * puts on the wire matches exactly what the server truncates to.
 */

import { StellarSwapError } from './errors.js'

/** Every classic asset and native XLM has exactly 7 decimals on-chain. */
export const STELLAR_DECIMALS = 7

const STROOPS_PER_UNIT = 10_000_000n

/**
 * Clamp a decimal amount to Stellar's 7-dp grid by TRUNCATION (not rounding — rounding up
 * could spend a stroop more than the user asked for; Horizon rejects extra precision).
 */
export function normalizeStellarAmount(amount: string): string {
  return fromStroops(toStroops(amount))
}

/** Decimal string → stroops, truncating past 7 dp. */
export function toStroops(amount: string): bigint {
  const trimmed = amount.trim()
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new StellarSwapError('invalid_amount', `Invalid Stellar amount: ${JSON.stringify(amount)}`)
  }
  const dot = trimmed.indexOf('.')
  const int = dot >= 0 ? trimmed.slice(0, dot) : trimmed
  const frac = dot >= 0 ? trimmed.slice(dot + 1, dot + 1 + STELLAR_DECIMALS) : ''
  return BigInt(int || '0') * STROOPS_PER_UNIT + BigInt((frac + '0000000').slice(0, STELLAR_DECIMALS))
}

/** Stroops → canonical decimal string (no trailing zeros, no float). */
export function fromStroops(stroops: bigint): string {
  const neg = stroops < 0n
  const abs = neg ? -stroops : stroops
  const whole = abs / STROOPS_PER_UNIT
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(STELLAR_DECIMALS, '0').replace(/0+$/, '')
  const body = frac ? `${whole}.${frac}` : `${whole}`
  return neg ? `-${body}` : body
}

/**
 * Coerce an amount that is ALREADY in integer stroops (`number | string | bigint`, e.g. a Soroban
 * i128 or an API field) to `bigint` SAFELY. This does NOT scale display units — use `toStroops` for
 * decimal input. A JSON number above 2^53 has already lost precision; a string in scientific
 * notation would make `BigInt()` throw. Both are rejected up front.
 */
export function apiAmountToStroops(value: number | string | bigint): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new StellarSwapError('invalid_amount', `Unsafe numeric amount: ${value}`)
    return BigInt(value)
  }
  if (!/^-?\d+$/.test(value)) throw new StellarSwapError('invalid_amount', `Non-integer amount: ${value}`)
  return BigInt(value)
}
