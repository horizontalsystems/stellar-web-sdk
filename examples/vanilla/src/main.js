// Entry: reads the form, drives the swap lifecycle (quote → trustline → commit → execute → track).
import { createSdk, createSigner } from './sdk.js'
import { note, describeError } from './ui.js'

const $ = (id) => document.getElementById(id)
const results = $('results')

let lastQuote // QuoteResult from the most recent quote (carries the picked provider)

const sdk = () => createSdk({ apiBaseUrl: $('apiBaseUrl').value.trim(), apiKey: $('apiKey').value.trim() })
const signer = () => createSigner($('secretKey').value)

function baseParams() {
  return {
    sellAsset: $('sellAsset').value.trim(),
    buyAsset: $('buyAsset').value.trim(),
    sellAmount: $('sellAmount').value.trim(),
    slippage: Number($('slippage').value),
    sourceAddress: signer()?.publicKey
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
      `Best provider: <b>${q.provider}</b>` +
        (q.route ? ` · buy amount ≈ ${q.route.expectedBuyAmount}` : '') +
        (q.providerErrors.length ? ` · ${q.providerErrors.length} provider(s) couldn’t serve the pair` : '')
    )

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

$('swapBtn').addEventListener('click', async () => {
  const s = signer()
  if (!s || !lastQuote?.provider) return
  const btn = $('swapBtn')
  btn.disabled = true
  btn.textContent = 'Swapping…'
  const live = note(results, 'info', 'Committing…')
  try {
    const client = sdk()
    const params = baseParams()

    const route = await client.commit({ ...params, sourceAddress: s.publicKey, provider: lastQuote.provider })
    live.innerHTML = 'Executing…'

    const exec = await client.execute(route, s, {
      callbacks: {
        onPhase: (phase) => (live.innerHTML = `Broker phase: <b>${phase}</b>`),
        onQuote: (q) => q.estimatedBuyingAmount && (live.innerHTML = `Live buy ≈ ${q.estimatedBuyingAmount}`),
        onProgress: (p) => p.bought && (live.innerHTML = `Bought ${p.bought}`)
      }
    })
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
})
