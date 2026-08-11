import { ResolvedConfig, StellarSwapConfig, resolveConfig } from './core/config.js'
import { StellarSwapError } from './core/errors.js'
import { LocalRouter } from './routing/LocalRouter.js'
import { trackRoute } from './tracking/index.js'
import { TrustlineManager, TrustlineStatus } from './stellar/trustline.js'
import { HorizonClient, HorizonSubmitResult } from './stellar/horizon.js'
import { SignedTransactionExecutor, SignedTxPreview } from './execution/signedTransaction.js'
import { TransferExecutor, DepositInstruction } from './execution/transfer.js'
import {
  StellarBrokerSession,
  BrokerSessionCallbacks,
  BrokerSessionResult
} from './execution/stellarBroker/StellarBrokerSession.js'
import { parseBrokerAsset, parseStellarAssetIdentifier, tryParseStellarAssetIdentifier } from './core/assets.js'
import { StellarSigner, assertAccount } from './core/signer.js'
import {
  CommittedRoute,
  CROSS_CHAIN_PROVIDERS,
  ProviderError,
  Route,
  RouteTracking,
  STELLAR_PROVIDERS,
  TERMINAL_STATUSES,
  TokenInfo,
  TrackResponse
} from './core/types.js'
import { normalizeStellarAmount } from './core/amounts.js'

/** True when `provider` is a Stellar in-chain provider (vs a cross-chain `transfer` provider). */
function isStellarProvider(provider: string): boolean {
  return (STELLAR_PROVIDERS as readonly string[]).includes(provider)
}

export interface QuoteParams {
  sellAsset: string
  buyAsset: string
  /** Decimal string, whole units. Truncated to Stellar's 7-dp grid before sending. */
  sellAmount: string
  /** PERCENT (1 = 1%). */
  slippage: number
  /** Trader account. Optional for a dry price check, required to commit. */
  sourceAddress?: string
  /** Recipient. Defaults to `sourceAddress`. A third party restricts the provider set. */
  destinationAddress?: string
  /** Override the fan-out. Defaults to the recipient-appropriate Stellar providers. */
  providers?: string[]
}

export interface QuoteResult {
  /** The picked route: the best `expectedBuyAmount` available (Stellar in-chain preferred). */
  route?: Route
  /** The provider the policy picked. */
  provider?: string
  /** True when the pick is a cross-chain (`transfer`) provider rather than Stellar in-chain. */
  crossChain: boolean
  /** Every route that came back, for display/debug. */
  allRoutes: Route[]
  /** Providers that couldn't serve the pair. */
  providerErrors: ProviderError[]
  /**
   * Per-provider wall-clock in ms. Populated in `'local'` routing, where the SDK made the calls
   * itself and can measure them; empty in `'server'` routing, where the fan-out happened remotely.
   */
  timings: Record<string, number>
}

export interface CommitParams extends QuoteParams {
  sourceAddress: string
  /** The provider to commit to — normally `QuoteResult.provider`. */
  provider: string
  /** Defaults to `sourceAddress`. For cross-chain, the destination-chain address. */
  destinationAddress?: string
  /** Cross-chain only: where refunds go if the swap can't complete. Defaults to `sourceAddress`. */
  refundAddress?: string
}

export interface ExecuteOptions {
  /** StellarBroker session callbacks (live quote / progress / phase). */
  callbacks?: BrokerSessionCallbacks
  signal?: AbortSignal
}

export interface ExecutionResult {
  method: 'signed_transaction' | 'stellar_broker' | 'transfer'
  /** The broadcast hash to track by. Undefined if a broker session signed nothing, or a cross-chain deposit wasn't submitted by the SDK. */
  inboundTxHash?: string
  /** Present for `signed_transaction` routes and submitted Stellar-origin `transfer` deposits. */
  submit?: HorizonSubmitResult
  /** Present for `stellar_broker` routes (includes partial-failure tracking data). */
  brokerSession?: BrokerSessionResult
  /** Present for `transfer` routes — what to deposit (always), so a non-submitting caller can send it. */
  deposit?: DepositInstruction
  /** `transfer` routes: whether the SDK built + submitted the deposit (Stellar origin + signer). */
  submitted?: boolean
}

export interface PollOptions {
  /** Delay between polls (ms). Default 60_000 — matches the server's tracking cadence. */
  intervalMs?: number
  /** Give up after this long (ms) and return the last status. Default 1 hour. */
  timeoutMs?: number
  /** Cancels the loop; a pending `delay` rejects with an `aborted` error. */
  signal?: AbortSignal
  /** Called with every status read, including the terminal one. */
  onUpdate?: (status: TrackResponse) => void
}

/**
 * Top-level Stellar swap SDK. Everything runs against the providers directly — quoting, route
 * selection, execution and outcome tracking alike. There is no backend in the path.
 *
 * Typical flow:
 *   const q = await sdk.quote({ sellAsset, buyAsset, sellAmount, slippage, sourceAddress })
 *   // (optional) trustline gate on q.route.buyAsset before committing
 *   const route = await sdk.commit({ ...quoteParams, provider: q.provider! })
 *   const exec = await sdk.execute(route, signer, { callbacks })
 *   await sdk.track(route, exec.inboundTxHash)
 */
export class StellarSwapSDK {
  readonly config: ResolvedConfig
  readonly trustlines: TrustlineManager
  readonly horizon: HorizonClient
  /** The local routing stack (discovery → fan-out → selection). Exposed for inspection and benchmarks. */
  readonly router: LocalRouter
  /**
   * Committed routes by uuid, so `track(uuid)` works without the caller threading the route back
   * in. In-memory only and deliberately so — persisting swap state is the application's decision,
   * not the SDK's.
   */
  private readonly committed = new Map<string, CommittedRoute>()
  private readonly signedTx: SignedTransactionExecutor
  private readonly broker: StellarBrokerSession
  private readonly transfer: TransferExecutor

  constructor(config: StellarSwapConfig = {}) {
    this.config = resolveConfig(config)
    this.trustlines = new TrustlineManager(this.config)
    this.horizon = new HorizonClient(this.config)
    this.router = new LocalRouter(this.config, this.horizon)
    this.signedTx = new SignedTransactionExecutor(this.config)
    this.broker = new StellarBrokerSession(this.config)
    this.transfer = new TransferExecutor(this.config)
  }

  /**
   * Price the swap, choosing the provider set automatically from the assets:
   *   - **Stellar-native** pair (both assets Stellar) → the four Stellar providers, narrowed to
   *     the recipient-capable subset for a third-party recipient. Best `expectedBuyAmount` wins.
   *   - **Axelar ITS** pair (same token bridged Stellar ↔ Ethereum, e.g. `XLM.XLM`↔`ETH.XLM-0x…`)
   *     → the `AXELAR_ITS` provider.
   *   - any other **cross-chain** pair → NEAR only.
   * The caller needn't know the path — check `QuoteResult.crossChain`. Pass `providers` to override.
   */
  async quote(params: QuoteParams): Promise<QuoteResult> {
    const result = await this.router.quote({
      sellAsset: this.normalizeAssetId(params.sellAsset),
      buyAsset: this.normalizeAssetId(params.buyAsset),
      sellAmount: this.normalizeAmountFor(params.sellAsset, params.sellAmount),
      slippage: params.slippage,
      ...(params.sourceAddress ? { sourceAddress: params.sourceAddress } : {}),
      ...(params.destinationAddress ? { destinationAddress: params.destinationAddress } : {}),
      ...(params.providers ? { providers: params.providers } : {})
    })
    return {
      route: result.route,
      provider: result.provider,
      crossChain: result.discovery.crossChain,
      allRoutes: result.allRoutes,
      providerErrors: result.providerErrors,
      timings: result.timings
    }
  }

  /** Normalize a Stellar asset id to canonical form; pass a cross-chain identifier through as-is. */
  private normalizeAssetId(raw: string): string {
    return tryParseStellarAssetIdentifier(raw)?.identifier ?? raw.trim()
  }

  /** Truncate to Stellar's 7-dp grid for Stellar sell assets; pass other decimals through. */
  private normalizeAmountFor(sellAsset: string, amount: string): string {
    return tryParseStellarAssetIdentifier(sellAsset) ? normalizeStellarAmount(amount) : amount.trim()
  }

  /**
   * Check whether the recipient needs a buy-asset trustline before it can receive funds. Buying a
   * classic asset the recipient doesn't trust is rejected by the server preflight / on-chain, so
   * gate on this before committing and offer `activateTrustline`.
   */
  async checkTrustline(recipient: string, buyAsset: string): Promise<TrustlineStatus> {
    assertAccount(recipient, 'recipient')
    return this.trustlines.check(recipient, parseStellarAssetIdentifier(buyAsset))
  }

  /** Create the buy-asset trustline on the signer's account (a `changeTrust` submit). */
  async activateTrustline(signer: StellarSigner, asset: string, limit?: string): Promise<HorizonSubmitResult> {
    return this.trustlines.activate(signer, parseStellarAssetIdentifier(asset), limit)
  }

  /**
   * Commit against the picked provider, carrying it so the committed quote matches the price that
   * was shown. This is where a route becomes executable: the adapter builds its transaction (or its
   * session parameters), pre-flights the accounts, and attaches the tracking handle.
   *
   * `destinationAddress` defaults to `sourceAddress`. A cross-chain provider also takes a
   * `refundAddress`, defaulting to the sender.
   */
  async commit(params: CommitParams): Promise<CommittedRoute> {
    const destinationAddress = params.destinationAddress ?? params.sourceAddress
    const stellar = isStellarProvider(params.provider)
    const transfer = (CROSS_CHAIN_PROVIDERS as readonly string[]).includes(params.provider)

    if (stellar) {
      assertAccount(params.sourceAddress, 'sourceAddress')
      assertAccount(destinationAddress, 'destinationAddress')
      // SB and AQUARIUS settle on the trader account — reject a third-party recipient early.
      if (
        (params.provider === 'STELLARBROKER' || params.provider === 'AQUARIUS') &&
        destinationAddress !== params.sourceAddress
      ) {
        throw new StellarSwapError(
          'recipient_not_supported',
          `${params.provider} settles on the trader account; destinationAddress must equal sourceAddress`
        )
      }
    }

    const route = await this.router.commit({
      sellAsset: this.normalizeAssetId(params.sellAsset),
      buyAsset: this.normalizeAssetId(params.buyAsset),
      sellAmount: this.normalizeAmountFor(params.sellAsset, params.sellAmount),
      slippage: params.slippage,
      dry: false,
      provider: params.provider,
      sourceAddress: params.sourceAddress,
      destinationAddress,
      // Cross-chain providers refund to the origin chain; default to the sender.
      ...(transfer ? { refundAddress: params.refundAddress ?? params.sourceAddress } : {})
    })

    // Remember it so `track(uuid)` works without the caller threading the route back in. The
    // registry is in-memory only — after a reload, pass the stored route itself.
    this.committed.set(route.uuid, route)
    return route
  }

  /** Preview a `signed_transaction` route's fee + enforced minimum before signing. */
  previewSignedTransaction(route: CommittedRoute): SignedTxPreview {
    return this.signedTx.preview(route)
  }

  /**
   * Execute a committed route, dispatching on `execution.method`:
   *   - `signed_transaction` → sign the server-built envelope and submit to Horizon (needs `signer`).
   *   - `stellar_broker`     → run the interactive WebSocket session (needs `signer`).
   *   - `transfer` (cross-chain) → Stellar origin + `signer`: build/sign/submit the deposit payment
   *     and return its hash; any other origin (or no signer): return `result.deposit` to send yourself.
   *
   * `signer` is optional purely for the non-submitting cross-chain case; the Stellar methods throw
   * without it. For `signed_transaction`/`stellar_broker` the returned hash is what you track.
   */
  async execute(route: CommittedRoute, signer?: StellarSigner, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    const execution = route.execution
    if (execution.method === 'signed_transaction') {
      if (!signer) throw new StellarSwapError('signing_rejected', 'A signer is required for a signed_transaction route')
      const submit = await this.signedTx.execute(route, signer)
      return { method: 'signed_transaction', inboundTxHash: submit.hash, submit }
    }
    if (execution.method === 'stellar_broker') {
      if (!signer) throw new StellarSwapError('signing_rejected', 'A signer is required for a stellar_broker route')
      const sellingAsset = parseBrokerAsset(execution.sellingAsset)
      const brokerSession = await this.broker.run({
        execution,
        signer,
        sellingAsset,
        callbacks: opts.callbacks,
        signal: opts.signal
      })
      return {
        method: 'stellar_broker',
        inboundTxHash: brokerSession.trackingHash,
        brokerSession
      }
    }
    if (execution.method === 'transfer') {
      const res = await this.transfer.execute(route, signer)
      return { method: 'transfer', submitted: res.submitted, deposit: res.deposit, inboundTxHash: res.inboundTxHash, submit: res.submit }
    }
    throw new StellarSwapError('invalid_params', `Unsupported execution method: ${(execution as { method: string }).method}`)
  }

  /**
   * Execute AND read the outcome in one call — including on a StellarBroker partial failure
   * (value may already have moved; never drop a session that signed anything). Rethrows the
   * broker error after tracking so the caller still learns the swap failed.
   */
  async executeAndTrack(
    route: CommittedRoute,
    signer: StellarSigner,
    opts: ExecuteOptions = {}
  ): Promise<{ execution: ExecutionResult; track?: TrackResponse }> {
    const execution = await this.execute(route, signer, opts)

    // Tracking is best-effort: a failed status call must NEVER discard a completed/partial
    // execution (the hash lives on `execution.inboundTxHash` for a manual retry).
    let track: TrackResponse | undefined
    let trackError: unknown
    if (execution.inboundTxHash) {
      try {
        track = await this.track(route, execution.inboundTxHash)
      } catch (err) {
        trackError = err
      }
    }

    if (execution.brokerSession && execution.brokerSession.status === 'failed') {
      throw new StellarSwapError(
        execution.brokerSession.error?.code ?? 'broker_session_error',
        execution.brokerSession.error?.message ?? 'StellarBroker session failed',
        { details: { track, trackError, signedHashes: execution.brokerSession.signedHashes } }
      )
    }
    return { execution, track }
  }

  /**
   * Read the current outcome of a committed route, straight from the source of truth: Horizon for
   * the Stellar-native providers, 1Click's status endpoint for NEAR, the Axelarscan GMP API for
   * Axelar ITS.
   *
   * Pass the committed route, or the `uuid` of one committed by this SDK instance. After a page
   * reload the in-memory registry is empty, so persist the route (its `tracking` handle is all that
   * is needed) and pass it back.
   *
   * `inboundTxHash` is the broadcast hash, required wherever the provider is keyed by one. NEAR is
   * keyed by its deposit address instead, so a NEAR route can be tracked before anything is sent.
   */
  async track(
    route: CommittedRoute | string,
    inboundTxHash?: string,
    signal?: AbortSignal
  ): Promise<TrackResponse> {
    const tracking = this.resolveTracking(route)
    return trackRoute(tracking, inboundTxHash, this.router.context, this.horizon, signal)
  }

  /** Poll {@link track} until a terminal status (or timeout). */
  async pollTrack(
    route: CommittedRoute | string,
    inboundTxHash: string | undefined,
    opts: PollOptions = {}
  ): Promise<TrackResponse> {
    const tracking = this.resolveTracking(route)
    const interval = opts.intervalMs ?? 15_000
    const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000)
    for (;;) {
      if (opts.signal?.aborted) throw new StellarSwapError('aborted', 'Polling aborted')
      const status = await trackRoute(tracking, inboundTxHash, this.router.context, this.horizon, opts.signal)
      opts.onUpdate?.(status)
      if (TERMINAL_STATUSES.includes(status.status)) return status
      if (Date.now() >= deadline) return status
      await delay(interval, opts.signal)
    }
  }

  /** Resolve a route or a uuid to its tracking handle. */
  private resolveTracking(route: CommittedRoute | string): RouteTracking {
    if (typeof route !== 'string') return route.tracking
    const known = this.committed.get(route)
    if (!known) {
      throw new StellarSwapError(
        'invalid_params',
        `No committed route known for uuid ${route}. The uuid registry is in-memory only — ` +
          `after a reload, pass the stored CommittedRoute itself.`
      )
    }
    return known.tracking
  }

  // --- cross-chain helpers (the unified quote/commit/execute handle routing) ---

  /**
   * The cross-chain asset catalog for a `transfer` provider, straight from the provider. Use the
   * returned `identifier`s as `sellAsset`/`buyAsset` — never hand-build them. Defaults to NEAR.
   */
  async crossChainTokens(provider = 'NEAR'): Promise<TokenInfo[]> {
    return this.router.crossChainTokens(provider)
  }

  /**
   * The deposit a committed cross-chain (`transfer`) route requires, without submitting anything —
   * for showing "send X to this address" when the origin isn't Stellar (or you handle the deposit).
   */
  depositFor(route: CommittedRoute): DepositInstruction {
    return this.transfer.deposit(route)
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let t: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(t)
      reject(new StellarSwapError('aborted', 'Aborted'))
    }
    t = setTimeout(() => {
      // Detach so a long-lived polling signal doesn't accumulate one listener per interval.
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
