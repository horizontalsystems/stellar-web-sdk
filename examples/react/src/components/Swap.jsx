import { useMemo, useState } from 'react'
import { keypairSigner } from 'stellar-web-sdk'
import { useStellarSwap, useQuote, useExecuteSwap, useTrackStatus } from 'stellar-web-sdk/react'
import { Note } from './Note.jsx'
import { USDC, XLM } from '../lib/constants.js'

/**
 * Unified swap panel: one quote() auto-routes Stellar in-chain vs cross-chain (NEAR), and Swap
 * dispatches accordingly. Cross-chain routes may return a deposit instruction instead of submitting.
 */
export function Swap() {
  const sdk = useStellarSwap()
  const [sellAsset, setSellAsset] = useState(XLM)
  const [buyAsset, setBuyAsset] = useState(USDC)
  const [sellAmount, setSellAmount] = useState('10')
  const [slippage, setSlippage] = useState('1')
  const [secretKey, setSecretKey] = useState('')
  const [destination, setDestination] = useState('')
  const [sourceField, setSourceField] = useState('')

  const signer = useMemo(() => {
    if (!secretKey.startsWith('S')) return undefined
    try {
      return keypairSigner(secretKey.trim())
    } catch {
      return undefined
    }
  }, [secretKey])

  const sourceAddress = signer?.publicKey || sourceField.trim()

  const q = useQuote()
  const swap = useExecuteSwap()

  const [trustRequired, setTrustRequired] = useState(undefined)
  const [trustBusy, setTrustBusy] = useState(false)
  const [trustError, setTrustError] = useState(undefined)
  const [confirming, setConfirming] = useState(false)

  const track = useTrackStatus(swap.route?.uuid, swap.execution?.inboundTxHash, {
    enabled: !!swap.execution?.inboundTxHash,
    intervalMs: 5_000
  })

  const baseParams = {
    sellAsset,
    buyAsset,
    sellAmount,
    slippage: Number(slippage),
    sourceAddress: sourceAddress || undefined,
    destinationAddress: destination.trim() || undefined
  }

  async function onQuote() {
    setTrustRequired(undefined)
    setTrustError(undefined)
    const res = await q.quote(baseParams)
    // Trustline gate applies only to Stellar in-chain routes.
    if (res && !res.crossChain && res.route && signer) {
      try {
        setTrustRequired((await sdk.checkTrustline(signer.publicKey, buyAsset)).required)
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

  const crossChain = q.data?.crossChain
  const canSwap =
    !!q.data?.provider &&
    !swap.isLoading &&
    (crossChain ? !!sourceAddress && !!destination.trim() : !!signer && trustRequired !== true)

  // Signing occurs for in-chain routes and Stellar-origin cross-chain deposits.
  const willSign = !!signer && (!crossChain || /^(native|XLM)$/.test(sellAsset) || sellAsset.startsWith('XLM.'))

  function doSwap() {
    setConfirming(false)
    swap.swap({ ...baseParams, sourceAddress, provider: q.data.provider, signer })
  }

  const deposit = swap.execution?.method === 'transfer' && !swap.execution.submitted ? swap.execution.deposit : undefined

  return (
    <>
      <fieldset>
        <label>Sell asset<input value={sellAsset} onChange={(e) => setSellAsset(e.target.value)} /></label>
        <label>Buy asset (try <code>ETH.USDC-0X…</code> for cross-chain)
          <input value={buyAsset} onChange={(e) => setBuyAsset(e.target.value)} /></label>
        <label>Sell amount<input value={sellAmount} onChange={(e) => setSellAmount(e.target.value)} /></label>
        <label>Slippage (%)<input value={slippage} onChange={(e) => setSlippage(e.target.value)} /></label>
        <label>Secret key (S…) — signs a Stellar-origin swap/deposit
          <input type="password" placeholder="S… (kept client-side)" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} /></label>
        <label>Destination address (optional) — cross-chain or third-party
          <input placeholder="0x… / bc1… / G…" value={destination} onChange={(e) => setDestination(e.target.value)} /></label>
        <label>Source address (optional) — non-Stellar origin with no secret key
          <input placeholder="origin-chain address" value={sourceField} onChange={(e) => setSourceField(e.target.value)} /></label>
        {signer && <small style={{ color: '#0a7' }}>Source: {signer.publicKey}</small>}
      </fieldset>

      <div className="row">
        <button disabled={q.isLoading} onClick={onQuote}>{q.isLoading ? 'Quoting…' : 'Get quote'}</button>
        {trustRequired && (
          <button disabled={trustBusy} onClick={onActivateTrustline}>{trustBusy ? 'Activating…' : 'Activate trustline'}</button>
        )}
        <button disabled={!canSwap || confirming} onClick={() => setConfirming(true)}>
          {swap.isLoading ? `${swap.status}…` : 'Swap'}
        </button>
        {swap.isLoading && <button onClick={() => swap.cancel()}>Cancel</button>}
      </div>

      {confirming && q.data?.route && (
        <div className="note info">
          <b>Confirm swap</b> — <b>mainnet, real funds</b>
          <br />
          Sell {sellAmount} {sellAsset} → ≈ {q.data.route.expectedBuyAmount} {buyAsset}
          <br />
          via <b>{q.data.provider}</b> {crossChain ? '(cross-chain)' : '(Stellar in-chain)'}
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={doSwap}>{willSign ? 'Confirm & sign' : 'Confirm'}</button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}

      {q.error && <Note kind="error">Quote failed: {q.error.code} — {q.error.message}</Note>}
      {q.data?.provider && (
        <Note kind="info">
          Best provider: <b>{q.data.provider}</b> {crossChain ? '(cross-chain)' : '(Stellar in-chain)'}
          {q.data.route && <> · buy amount ≈ {q.data.route.expectedBuyAmount}</>}
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
        </Note>
      )}
      {deposit && (
        <Note kind="ok">
          Committed <code>{swap.route?.uuid}</code>. Send <b>{deposit.amount} {deposit.asset}</b> on <b>{deposit.chain}</b> to{' '}
          <b>{deposit.depositAddress}</b>
          {deposit.attachment && <> · memo ({deposit.attachment.type}) <b>{deposit.attachment.value}</b></>}, then track by uuid.
        </Note>
      )}
      {swap.execution?.submitted !== false && swap.status === 'success' && (
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
