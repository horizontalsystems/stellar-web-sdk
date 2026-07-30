import { ResolvedConfig } from '../../core/config.js'
import { StellarSwapError } from '../../core/errors.js'
import { StellarAsset } from '../../core/assets.js'
import { HorizonClient } from '../../stellar/horizon.js'
import { StellarSigner } from '../../core/signer.js'
import { StellarBrokerExecution } from '../../core/types.js'
import { SigningPipeline } from './SigningPipeline.js'
import {
  BrokerQuote,
  InboundMessage,
  OutboundMessage,
  TxMessage
} from './messages.js'

/** Timeouts (ms) — the guide's live-tuned values. */
const CONNECTED_TIMEOUT = 5_000
const QUOTE_TIMEOUT = 15_000
const SESSION_CEILING = 180_000
/** Drop the session if the broker goes silent this long (guide: 20s watchdog). */
const SILENCE_WATCHDOG = 20_000

export interface BrokerSessionCallbacks {
  /** Live in-session quote updates (show these, not the committed snapshot). */
  onQuote?: (quote: BrokerQuote) => void
  /** Progress ticks during the trade. */
  onProgress?: (progress: { sold?: string; bought?: string }) => void
  /** Coarse lifecycle phase, for UI. */
  onPhase?: (phase: BrokerSessionPhase) => void
}

export type BrokerSessionPhase = 'connecting' | 'quoting' | 'trading' | 'settling'

export interface BrokerSessionResult {
  status: 'success' | 'failed'
  sold?: string
  bought?: string
  /**
   * The tracking handle — the LAST signed fee-bump hash. Present whenever ANY tx was signed,
   * even on failure (a partial fill may have moved value; you MUST still track it — guide §5).
   */
  trackingHash?: string
  /** Every outer fee-bump hash we signed, in order. */
  signedHashes: string[]
  /** Set when status is `failed`. */
  error?: StellarSwapError
}

export interface RunSessionOptions {
  execution: StellarBrokerExecution
  signer: StellarSigner
  /** Parsed selling asset (for the signing pipeline's debit checks). */
  sellingAsset: StellarAsset
  callbacks?: BrokerSessionCallbacks
  /** External cancellation. */
  signal?: AbortSignal
}

/**
 * Runs one StellarBroker execution session (guide §5). Connect → live quote → confirm trade →
 * sign each broker-built tx through the security pipeline → settle. The broker submits every
 * transaction; the client only signs. On ANY failure after a signature, the last fee-bump hash
 * is still returned so the swap can be tracked (partial fills included).
 */
export class StellarBrokerSession {
  private readonly horizon: HorizonClient

  constructor(private readonly config: ResolvedConfig) {
    this.horizon = new HorizonClient(config)
  }

  async run(opts: RunSessionOptions): Promise<BrokerSessionResult> {
    const { execution, signer, sellingAsset, callbacks } = opts
    if (!execution.partnerKey) {
      throw new StellarSwapError(
        'broker_session_error',
        'stellar_broker execution is missing partnerKey — the server must supply it'
      )
    }
    const WS = this.config.WebSocket
    if (typeof WS !== 'function') {
      throw new StellarSwapError(
        'broker_session_error',
        'No WebSocket implementation available — pass `WebSocket` in the SDK config'
      )
    }

    const pipeline = new SigningPipeline({
      signer,
      sellingAsset,
      sellingAmount: execution.sellingAmount,
      networkPassphrase: this.config.networkPassphrase,
      horizon: this.horizon
    })

    // Must be `wss://` explicitly (browsers auto-upgrade https WS URLs; nothing else does).
    const base = this.config.brokerWsUrl
    if (!base.startsWith('wss://')) {
      throw new StellarSwapError('broker_session_error', `Broker WS URL must be wss://, got ${base}`)
    }
    const url = `${base}?partner=${encodeURIComponent(execution.partnerKey)}`

    return new SessionRun(WS, url, execution, signer, pipeline, callbacks, opts.signal).execute()
  }
}

/** One-shot session state machine. Instantiated per run so state never leaks between sessions. */
class SessionRun {
  private ws?: WebSocket
  private uid?: string
  private phase: BrokerSessionPhase = 'connecting'
  private settled = false

  private connectedTimer?: ReturnType<typeof setTimeout>
  private quoteTimer?: ReturnType<typeof setTimeout>
  private ceilingTimer?: ReturnType<typeof setTimeout>
  private silenceTimer?: ReturnType<typeof setTimeout>

  private resolveConnected?: () => void
  private rejectGate?: (err: StellarSwapError) => void
  private resolveQuote?: (quote: BrokerQuote) => void
  private resolveDone!: (result: BrokerSessionResult) => void

  private lastProgress: { sold?: string; bought?: string } = {}

  constructor(
    private readonly WS: typeof WebSocket,
    private readonly url: string,
    private readonly execution: StellarBrokerExecution,
    private readonly signer: StellarSigner,
    private readonly pipeline: SigningPipeline,
    private readonly callbacks: BrokerSessionCallbacks | undefined,
    private readonly signal: AbortSignal | undefined
  ) {}

  async execute(): Promise<BrokerSessionResult> {
    if (this.signal?.aborted) {
      return this.buildResult('failed', new StellarSwapError('aborted', 'Session aborted before start'))
    }

    const done = new Promise<BrokerSessionResult>((resolve) => {
      this.resolveDone = resolve
    })

    this.signal?.addEventListener('abort', () => {
      this.fail(new StellarSwapError('aborted', 'Session aborted'))
    })

    this.ceilingTimer = setTimeout(
      () => this.fail(new StellarSwapError('timeout', `Session exceeded ${SESSION_CEILING}ms ceiling`)),
      SESSION_CEILING
    )

    try {
      this.ws = new this.WS(this.url)
      this.ws.addEventListener('message', (ev) => {
        void this.onMessage(ev as MessageEvent)
      })
      this.ws.addEventListener('error', () => {
        this.fail(new StellarSwapError('broker_session_error', 'WebSocket error'))
      })
      this.ws.addEventListener('close', () => {
        if (!this.settled) this.fail(new StellarSwapError('broker_session_error', 'WebSocket closed before completion'))
      })
    } catch (err) {
      return this.buildResult('failed', new StellarSwapError('broker_session_error', 'Failed to open WebSocket', { cause: err }))
    }

    // Gate 1: wait for `connected`.
    try {
      await this.waitFor(
        (resolve, reject) => {
          this.resolveConnected = resolve
          this.rejectGate = reject
        },
        CONNECTED_TIMEOUT,
        'connected',
        (t) => (this.connectedTimer = t)
      )
    } catch (err) {
      return this.finishFrom(err, done)
    }

    // Send the quote and wait for a successful one.
    this.setPhase('quoting')
    this.send({
      type: 'quote',
      sellingAsset: this.execution.sellingAsset,
      buyingAsset: this.execution.buyingAsset,
      sellingAmount: this.execution.sellingAmount,
      slippageTolerance: this.execution.slippageTolerance
    })

    let quote: BrokerQuote
    try {
      quote = await this.waitFor<BrokerQuote>(
        (resolve, reject) => {
          this.resolveQuote = resolve
          this.rejectGate = reject
        },
        QUOTE_TIMEOUT,
        'quote',
        (t) => (this.quoteTimer = t)
      )
    } catch (err) {
      return this.finishFrom(err, done)
    }
    this.callbacks?.onQuote?.(quote)

    // Confirm the trade immediately — the user already confirmed on the committed quote and the
    // session quote is fresh by construction; the broker re-prices live, bounded by slippage.
    this.setPhase('trading')
    this.send({ type: 'trade', account: this.signer.publicKey })

    return done
  }

  // --- message handling ----------------------------------------------------

  private async onMessage(ev: MessageEvent): Promise<void> {
    this.resetSilenceWatchdog()
    let msg: InboundMessage
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as InboundMessage
    } catch {
      return // ignore non-JSON frames
    }

    switch (msg.type) {
      case 'connected': {
        this.uid = (msg as { uid?: string }).uid
        clearTimeout(this.connectedTimer)
        this.resolveConnected?.()
        return
      }
      case 'ping': {
        // Answer EVERY ping — including while waiting for connected/quote — or the broker drops us.
        const uid = (msg as { uid?: string }).uid ?? this.uid
        if (uid) this.send({ type: 'pong', uid })
        return
      }
      case 'quote': {
        const quote: BrokerQuote = (msg as { quote?: BrokerQuote }).quote ?? { status: 'unknown' }
        if (this.phase === 'quoting') {
          if (quote.status === 'success' && quote.estimatedBuyingAmount) {
            clearTimeout(this.quoteTimer)
            this.resolveQuote?.(quote)
          } else if (quote.status === 'unfeasible' || quote.status === 'rejected') {
            clearTimeout(this.quoteTimer)
            this.rejectGate?.(
              new StellarSwapError('broker_quote_failed', `StellarBroker quote ${quote.status}`, { details: quote })
            )
          }
          // Any other transient status: keep waiting until QUOTE_TIMEOUT.
        } else {
          // During the trade, quotes are informational — surface for display only.
          this.callbacks?.onQuote?.(quote)
        }
        return
      }
      case 'tx': {
        await this.handleTx(msg as TxMessage)
        return
      }
      case 'progress': {
        const p = msg as { sold?: string; bought?: string }
        this.lastProgress = { sold: p.sold, bought: p.bought }
        this.callbacks?.onProgress?.(this.lastProgress)
        return
      }
      case 'paused':
        return // informational
      case 'stop': {
        this.handleStop(msg as { status?: string; sold?: string; bought?: string })
        return
      }
      case 'error': {
        this.fail(
          new StellarSwapError('broker_session_error', (msg as { error?: string }).error || 'StellarBroker error', {
            details: msg
          })
        )
        return
      }
      default:
        return // unknown/forward-compatible message
    }
  }

  private async handleTx(msg: TxMessage): Promise<void> {
    if (this.settled) return
    this.setPhase('settling')
    try {
      const signed = await this.pipeline.sign(msg)
      this.send({ type: 'tx', hash: signed.hash, xdr: signed.xdr })
    } catch (err) {
      // A signing rejection or failure AFTER we may have signed earlier txs must still be tracked.
      const e =
        err instanceof StellarSwapError
          ? err
          : new StellarSwapError('signing_rejected', 'Signing pipeline failed', { cause: err })
      this.fail(e)
    }
  }

  private handleStop(msg: { status?: string; sold?: string; bought?: string }): void {
    const success = msg.status === 'success'
    if (msg.sold !== undefined || msg.bought !== undefined) {
      this.lastProgress = { sold: msg.sold ?? this.lastProgress.sold, bought: msg.bought ?? this.lastProgress.bought }
    }
    if (success) {
      this.finish(this.buildResult('success'))
    } else {
      this.fail(new StellarSwapError('broker_session_error', `StellarBroker stopped: ${msg.status}`, { details: msg }))
    }
  }

  // --- lifecycle helpers ---------------------------------------------------

  private waitFor<T = void>(
    register: (resolve: (v: T) => void, reject: (e: StellarSwapError) => void) => void,
    timeoutMs: number,
    label: string,
    keepTimer: (t: ReturnType<typeof setTimeout>) => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      register(resolve, reject)
      keepTimer(
        setTimeout(() => reject(new StellarSwapError('timeout', `Timed out waiting for "${label}" (${timeoutMs}ms)`)), timeoutMs)
      )
    })
  }

  private resetSilenceWatchdog(): void {
    clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(
      () => this.fail(new StellarSwapError('timeout', `Broker silent for ${SILENCE_WATCHDOG}ms`)),
      SILENCE_WATCHDOG
    )
  }

  private setPhase(phase: BrokerSessionPhase): void {
    this.phase = phase
    this.callbacks?.onPhase?.(phase)
  }

  private send(msg: OutboundMessage): void {
    try {
      this.ws?.send(JSON.stringify(msg))
    } catch {
      // If the socket is gone the close/error handler will settle the session.
    }
  }

  private fail(error: StellarSwapError): void {
    // Unwind any pending connect/quote gate. finish() clears that gate's own reject timer, so a
    // failure arriving from an abort, a WebSocket error/close, the ceiling, or the silence
    // watchdog during a gate wait would otherwise leave execute() awaiting forever. Rejecting the
    // gate lets execute()'s catch run (finishFrom → fail again is idempotent once settled). No-op
    // if no gate is pending (rejecting an already-settled promise does nothing).
    this.rejectGate?.(error)
    this.finish(this.buildResult('failed', error))
  }

  private finish(result: BrokerSessionResult): void {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.connectedTimer)
    clearTimeout(this.quoteTimer)
    clearTimeout(this.ceilingTimer)
    clearTimeout(this.silenceTimer)
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.resolveDone(result)
  }

  private buildResult(status: 'success' | 'failed', error?: StellarSwapError): BrokerSessionResult {
    return {
      status,
      sold: this.lastProgress.sold,
      bought: this.lastProgress.bought,
      trackingHash: this.pipeline.lastSignedHash,
      signedHashes: [...this.pipeline.signedHashes],
      ...(error ? { error } : {})
    }
  }

  /** Convert a gate rejection into a settled failure result (idempotent with `done`). */
  private finishFrom(err: unknown, done: Promise<BrokerSessionResult>): Promise<BrokerSessionResult> {
    const e =
      err instanceof StellarSwapError ? err : new StellarSwapError('broker_session_error', 'Session failed', { cause: err })
    this.fail(e)
    return done
  }
}
