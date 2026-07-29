import { useMemo, useState } from 'react'
import { keypairSigner } from 'stellar-web-sdk'
import { useStellarSwap, useQuote, useExecuteSwap, useTrackStatus } from 'stellar-web-sdk/react'
import { Note } from './Note.jsx'
import { USDC, XLM } from '../lib/constants.js'

/** The swap panel — assumes it is rendered inside a <StellarSwapProvider>. */
export function Swap() {
  const sdk = useStellarSwap()
  const [sellAsset, setSellAsset] = useState(XLM)
  const [buyAsset, setBuyAsset] = useState(USDC)
  const [sellAmount, setSellAmount] = useState('10')
  const [slippage, setSlippage] = useState('1')
  const [secretKey, setSecretKey] = useState('')

  const signer = useMemo(() => {
    if (!secretKey.startsWith('S')) return undefined
    try {
      return keypairSigner(secretKey.trim())
    } catch {
      return undefined
    }
  }, [secretKey])

  const q = useQuote()
  const swap = useExecuteSwap()

  const [trustRequired, setTrustRequired] = useState(undefined)
  const [trustBusy, setTrustBusy] = useState(false)
  const [trustError, setTrustError] = useState(undefined)

  const track = useTrackStatus(swap.route?.uuid, swap.execution?.inboundTxHash, {
    enabled: !!swap.route?.uuid,
    intervalMs: 5_000
  })

  const baseParams = {
    sellAsset,
    buyAsset,
    sellAmount,
    slippage: Number(slippage),
    sourceAddress: signer?.publicKey
  }

  async function onQuote() {
    setTrustRequired(undefined)
    setTrustError(undefined)
    const res = await q.quote(baseParams)
    if (res?.route && signer) {
      try {
        const status = await sdk.checkTrustline(signer.publicKey, buyAsset)
        setTrustRequired(status.required)
      } catch (err) {
        setTrustError(err)
      }
    }
  }

  async function onActivateTrustline() {
    if (!signer) return
    setTrustBusy(true)
    setTrustError(undefined)
    try {
      await sdk.activateTrustline(signer, buyAsset)
      setTrustRequired(false)
    } catch (err) {
      setTrustError(err)
    } finally {
      setTrustBusy(false)
    }
  }

  const canSwap = !!signer && !!q.data?.provider && !swap.isLoading && trustRequired !== true

  return (
    <>
      <fieldset style={{ marginTop: 16 }}>
        <label>Sell asset<input value={sellAsset} onChange={(e) => setSellAsset(e.target.value)} /></label>
        <label>Buy asset<input value={buyAsset} onChange={(e) => setBuyAsset(e.target.value)} /></label>
        <label>Sell amount<input value={sellAmount} onChange={(e) => setSellAmount(e.target.value)} /></label>
        <label>Slippage (%)<input value={slippage} onChange={(e) => setSlippage(e.target.value)} /></label>
        <label>
          Secret key (S…) — dedicated account only
          <input type="password" placeholder="S… (kept client-side)" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
        </label>
        {signer && <small style={{ color: '#0a7' }}>Source: {signer.publicKey}</small>}
      </fieldset>

      <div className="row">
        <button disabled={q.isLoading} onClick={onQuote}>{q.isLoading ? 'Quoting…' : 'Get quote'}</button>
        {trustRequired && (
          <button disabled={trustBusy} onClick={onActivateTrustline}>{trustBusy ? 'Activating…' : 'Activate trustline'}</button>
        )}
        <button
          disabled={!canSwap}
          onClick={() => swap.swap({ ...baseParams, sourceAddress: signer.publicKey, provider: q.data.provider, signer })}
        >
          {swap.isLoading ? `${swap.status}…` : 'Swap'}
        </button>
        {swap.isLoading && <button onClick={() => swap.cancel()}>Cancel</button>}
      </div>

      {q.error && <Note kind="error">Quote failed: {q.error.code} — {q.error.message}</Note>}
      {q.data && (
        <Note kind="info">
          Best provider: <b>{q.data.provider ?? 'none'}</b>
          {q.data.route && <> · buy amount ≈ {q.data.route.expectedBuyAmount}</>}
          {q.data.providerErrors.length > 0 && <> · {q.data.providerErrors.length} provider(s) couldn’t serve the pair</>}
        </Note>
      )}
      {trustRequired === true && (
        <Note kind="info">Your account needs a trustline for the buy asset. Click <b>Activate trustline</b>, then swap.</Note>
      )}
      {trustError && <Note kind="error">Trustline error: {trustError.code} — {trustError.message}</Note>}

      {swap.brokerPhase && (
        <Note kind="info">
          Broker phase: <b>{swap.brokerPhase}</b>
          {swap.brokerQuote?.estimatedBuyingAmount && <> · live buy ≈ {swap.brokerQuote.estimatedBuyingAmount}</>}
          {swap.brokerProgress?.bought && <> · bought {swap.brokerProgress.bought}</>}
        </Note>
      )}
      {swap.status === 'success' && (
        <Note kind="ok">
          Submitted via {swap.execution?.method}. Tracking hash: {swap.execution?.inboundTxHash ?? '—'}
          {track.status && <> · status <b>{track.status.status}</b></>}
          {track.isPolling && <> (polling…)</>}
        </Note>
      )}
      {swap.error && <Note kind="error">Swap failed: {swap.error.code} — {swap.error.message}</Note>}
      {track.error && <Note kind="error">Tracking error: {track.error.code} — {track.error.message}</Note>}
    </>
  )
}
