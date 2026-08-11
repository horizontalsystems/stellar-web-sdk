/**
 * Typed error surface. Every failure the SDK raises is a `StellarSwapError` so callers can
 * `catch` one class and branch on `code`. Server/provider errors are wrapped with the HTTP
 * status and the raw provider body preserved on `.details`.
 */

export type StellarSwapErrorCode =
  // Request / config problems (thrown before any network call)
  | 'invalid_config'
  | 'invalid_asset'
  | 'invalid_amount'
  | 'invalid_params'
  // Routing
  | 'no_route'
  | 'recipient_not_supported'
  | 'trustline_required'
  // Server / provider
  | 'server_error'
  | 'provider_error'
  | 'rate_expired'
  // Execution
  | 'signing_rejected'
  | 'submit_failed'
  | 'broker_session_error'
  | 'broker_quote_failed'
  | 'timeout'
  | 'aborted'
  | 'unknown'

export class StellarSwapError extends Error {
  readonly code: StellarSwapErrorCode
  /** HTTP status when the error came from the server. */
  readonly status?: number
  /** Raw provider/body/context for diagnostics. */
  readonly details?: unknown

  constructor(
    code: StellarSwapErrorCode,
    message: string,
    opts: { status?: number; details?: unknown; cause?: unknown } = {}
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'StellarSwapError'
    this.code = code
    this.status = opts.status
    this.details = opts.details
    // Restore prototype chain when compiled down to ES5-ish targets.
    Object.setPrototypeOf(this, StellarSwapError.prototype)
  }
}

