// Tiny DOM helpers for rendering status notes and formatting SDK errors.
import { StellarSwapError } from 'stellar-web-sdk'

/** Append a coloured note to `container`; returns the node so callers can update it live. */
export function note(container, kind, html) {
  const el = document.createElement('div')
  el.className = `note ${kind}`
  el.innerHTML = html
  container.appendChild(el)
  return el
}

/** Human-readable one-liner for any thrown value (StellarSwapError carries a stable `code`). */
export function describeError(err) {
  return err instanceof StellarSwapError ? `${err.code} — ${err.message}` : String(err?.message || err)
}
