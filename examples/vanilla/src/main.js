// Unified swap flow: one quote() auto-routes Stellar in-chain vs cross-chain (NEAR); Swap dispatches.
import { createSdk, createSigner } from './sdk.js'
import { note, describeError } from './ui.js'

const $ = (id) => document.getElementById(id)
const results = $('results')

let lastQuote // QuoteResult from the most recent quote (carries provider + crossChain flag)

const sdk = () => createSdk({ apiBaseUrl: $('apiBaseUrl').value.trim(), apiKey: $('apiKey').value.trim() })
const signer = () => createSigner($('secretKey').value)
const sourceAddress = () => signer()?.publicKey || $('source').value.trim()
const destination = () => $('destination').value.trim()

function baseParams() {
  return {
    sellAsset: $('sellAsset').value.trim(),
    buyAsset: $('buyAsset').value.trim(),
    sellAmount: $('sellAmount').value.trim(),
    slippage: Number($('slippage').value),
    sourceAddress: sourceAddress() || undefined,
    destinationAddress: destination() || undefined
  }
}

$('quoteBtn').addEventListener('click', async () => {
  results.innerHTML = ''
  $('trustBtn').hidden = true
  $('swapBtn').disabled = true
  const btn = $('quoteBtn')
  btn.disabled = true
  btn.textContent = 'Quoting…'
  try {
    const client = sdk()
    const params = baseParams()
    const q = await client.quote(params)
    lastQuote = q
    if (!q.provider) {
      note(results, 'error', 'No route for this pair.')
      return
    }
    note(
      results,
      'info',
      `Best provider: <b>${q.provider}</b>${q.crossChain ? ' (cross-chain)' : ' (Stellar in-chain)'}` +
        ` · buy amount ≈ ${q.route.expectedBuyAmount}`
    )

    if (q.crossChain) {
      // Cross-chain: needs a source + destination; the SDK signs a Stellar-origin deposit, else shows it.
      $('swapBtn').disabled = false
      note(results, 'info', 'Cross-chain route — set a destination address (and source, if the origin isn’t Stellar), then Swap.')
      return
    }

    // Stellar in-chain: gate on the buy-asset trustline before swapping.
    const s = signer()
    if (s) {
      const trust = await client.checkTrustline(s.publicKey, params.buyAsset)
      if (trust.required) {
        $('trustBtn').hidden = false
        note(results, 'info', 'Your account needs a trustline for the buy asset. Click <b>Activate trustline</b>, then swap.')
      } else {
        $('swapBtn').disabled = false
      }
    } else {
      note(results, 'info', 'Add a secret key to enable the trustline check and swap.')
    }
  } catch (err) {
    note(results, 'error', `Quote failed: ${describeError(err)}`)
  } finally {
    btn.disabled = false
    btn.textContent = 'Get quote'
  }
})

$('trustBtn').addEventListener('click', async () => {
  const s = signer()
  if (!s) return
  const btn = $('trustBtn')
  btn.disabled = true
  btn.textContent = 'Activating…'
  try {
    await sdk().activateTrustline(s, $('buyAsset').value.trim())
    note(results, 'ok', 'Trustline activated.')
    btn.hidden = true
    $('swapBtn').disabled = false
  } catch (err) {
    note(results, 'error', `Trustline error: ${describeError(err)}`)
  } finally {
    btn.disabled = false
    btn.textContent = 'Activate trustline'
  }
})

// Confirmation gate: clicking Swap shows a summary and waits for an explicit confirm before the
// SDK commits and signs (a mainnet swap moves real funds).
$('swapBtn').addEventListener('click', () => {
  if (!lastQuote?.provider) return
  const src = sourceAddress()
  if (lastQuote.crossChain && (!src || !destination())) {
    note(results, 'error', 'Cross-chain swap needs a source and destination address.')
    return
  }
  if (!lastQuote.crossChain && !signer()) {
    note(results, 'error', 'A secret key is required to swap in-chain.')
    return
  }

  const willSign = !!signer() && (!lastQuote.crossChain || isStellarAsset($('sellAsset').value.trim()))
  const q = lastQuote
  $('swapBtn').disabled = true
  const panel = note(
    results,
    'info',
    `<b>Confirm swap</b> — <b>mainnet, real funds</b><br>` +
      `Sell ${$('sellAmount').value.trim()} ${$('sellAsset').value.trim()} → ≈ ${q.route.expectedBuyAmount} ${$('buyAsset').value.trim()}<br>` +
      `via <b>${q.provider}</b> ${q.crossChain ? '(cross-chain)' : '(Stellar in-chain)'}` +
      `<div class="row" style="margin-top:8px">` +
      `<button id="confirmBtn">${willSign ? 'Confirm &amp; sign' : 'Confirm'}</button>` +
      `<button id="cancelBtn">Cancel</button></div>`
  )
  $('confirmBtn').addEventListener('click', () => {
    panel.remove()
    runSwap()
  })
  $('cancelBtn').addEventListener('click', () => {
    panel.remove()
    $('swapBtn').disabled = false
    note(results, 'info', 'Swap cancelled.')
  })
})

async function runSwap() {
  const s = signer()
  const src = sourceAddress()
  const btn = $('swapBtn')
  btn.disabled = true
  btn.textContent = 'Swapping…'
  const live = note(results, 'info', 'Committing…')
  try {
    const client = sdk()
    const route = await client.commit({
      ...baseParams(),
      sourceAddress: src,
      destinationAddress: destination() || src,
      provider: lastQuote.provider
    })
    live.innerHTML = 'Executing…'

    const exec = await client.execute(route, s, {
      callbacks: {
        onPhase: (phase) => (live.innerHTML = `Broker phase: <b>${phase}</b>`),
        onQuote: (q) => q.estimatedBuyingAmount && (live.innerHTML = `Live buy ≈ ${q.estimatedBuyingAmount}`),
        onProgress: (p) => p.bought && (live.innerHTML = `Bought ${p.bought}`)
      }
    })

    // Cross-chain deposit the SDK didn't submit (non-Stellar origin / no signer) → show it.
    if (exec.method === 'transfer' && !exec.submitted) {
      const d = exec.deposit
      const memo = d.attachment ? ` · memo (${d.attachment.type}) <b>${d.attachment.value}</b>` : ''
      live.className = 'note ok'
      live.innerHTML = `Committed <code>${route.uuid}</code>. Send <b>${d.amount} ${d.asset}</b> on <b>${d.chain}</b> to <b>${d.depositAddress}</b>${memo}, then track by uuid.`
      return
    }

    note(results, 'ok', `Submitted via ${exec.method}. Tracking hash: ${exec.inboundTxHash ?? '—'}`)
    if (exec.inboundTxHash) {
      const status = note(results, 'info', 'Tracking…')
      const final = await client.pollTrack(route.uuid, exec.inboundTxHash, {
        intervalMs: 5_000,
        onUpdate: (st) => (status.innerHTML = `Status: <b>${st.status}</b> (polling…)`)
      })
      status.className = 'note ok'
      status.innerHTML = `Final status: <b>${final.status}</b>`
    }
  } catch (err) {
    note(results, 'error', `Swap failed: ${describeError(err)}`)
  } finally {
    btn.disabled = false
    btn.textContent = 'Swap'
  }
}

/** A Stellar asset id (`XLM.…`/`native`) — signing occurs when the origin is Stellar. */
function isStellarAsset(id) {
  return id === 'native' || id === 'XLM' || /^XLM\./.test(id)
}
