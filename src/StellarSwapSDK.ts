import { ResolvedConfig, StellarSwapConfig, requireServer, resolveConfig } from './core/config.js'
import { StellarSwapError } from './core/errors.js'
import { UswapClient } from './client/UswapClient.js'
import { LocalRouter } from './routing/LocalRouter.js'
import { discoverProviders } from './routing/registry.js'
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
import { routeProvider, selectUnifiedRoute } from './core/waterfall.js'
import {
  CommittedRoute,
  CROSS_CHAIN_PROVIDERS,
  ProviderError,
  Route,
  STELLAR_CHAIN_ID,
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
  /** The route the unified policy picked (Stellar in-chain preferred, else cross-chain). */
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
  /** The hash to report to `/v2/track`. Undefined if a broker session signed nothing, or a cross-chain deposit wasn't submitted by the SDK. */
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
 * Top-level Stellar swap SDK. Implements the StellarBroker-first waterfall over uswap-server's
 * four Stellar providers and runs execution client-side: server-built envelopes are signed and
 * submitted to Horizon; StellarBroker routes run the interactive WebSocket session. Tracking is
 * server-side by `uuid` + broadcast hash.
 *
 * Typical flow:
 *   const q = await sdk.quote({ sellAsset, buyAsset, sellAmount, slippage, sourceAddress })
 *   // (optional) trustline gate on q.route.buyAsset before committing
 *   const route = await sdk.commit({ ...quoteParams, provider: q.provider! })
 *   const exec = await sdk.execute(route, signer, { callbacks })
 *   await sdk.track(route.uuid, exec.inboundTxHash)
 */
export class StellarSwapSDK {
  readonly config: ResolvedConfig
  readonly client: UswapClient
  readonly trustlines: TrustlineManager
  readonly horizon: HorizonClient
  /** The local routing stack (discovery → fan-out → waterfall). Exposed for inspection and benchmarks. */
  readonly router: LocalRouter
  private readonly signedTx: SignedTransactionExecutor
  private readonly broker: StellarBrokerSession
  private readonly transfer: TransferExecutor

  constructor(config: StellarSwapConfig) {
    this.config = resolveConfig(config)
    this.client = new UswapClient(this.config)
    this.trustlines = new TrustlineManager(this.config)
    this.horizon = new HorizonClient(this.config)
    this.router = new LocalRouter(this.config, this.horizon)
    this.signedTx = new SignedTransactionExecutor(this.config)
    this.broker = new StellarBrokerSession(this.config)
    this.transfer = new TransferExecutor(this.config)
  }

  /** Whether routes are priced by this package's adapters (`'local'`) or by a uswap-server (`'server'`). */
  private get isLocal(): boolean {
    return this.config.routing === 'local'
  }

  /**
   * Price the swap, choosing the provider set automatically from the assets:
   *   - **Stellar-native** pair (both assets Stellar) → the four Stellar providers (SB-first
   *     waterfall, with the recipient-capable subset for a third-party recipient).
   *   - **Axelar ITS** pair (same token bridged Stellar ↔ Ethereum, e.g. `XLM.XLM`↔`ETH.XLM-0x…`)
   *     → the `AXELAR_ITS` provider.
   *   - any other **cross-chain** pair → NEAR only.
   * The caller needn't know the path — check `QuoteResult.crossChain`. Pass `providers` to override.
   */
  async quote(params: QuoteParams): Promise<QuoteResult> {
    if (this.isLocal) {
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

    const discovery = discoverProviders({
      sellAsset: params.sellAsset,
      buyAsset: params.buyAsset,
      ...(params.sourceAddress ? { sourceAddress: params.sourceAddress } : {}),
      ...(params.destinationAddress ? { destinationAddress: params.destinationAddress } : {}),
      ...(params.providers ? { providers: params.providers } : {})
    })
    const crossChain = discovery.crossChain
    const providers = discovery.providers

    const res = await this.client.rate({
      // Stellar-native pairs keep the original `chainId: stellar` request; cross-chain assets
      // encode their own chains, so none is sent.
      ...(crossChain ? {} : { chainId: STELLAR_CHAIN_ID }),
      sellAsset: this.normalizeAssetId(params.sellAsset),
      buyAsset: this.normalizeAssetId(params.buyAsset),
      sellAmount: this.normalizeAmountFor(params.sellAsset, params.sellAmount),
      slippage: params.slippage,
      providers
    })

    const routes = res.routes ?? []
    const route = selectUnifiedRoute(routes)
    return {
      route,
      provider: route ? routeProvider(route) : undefined,
      crossChain,
      allRoutes: routes,
      providerErrors: res.providerErrors ?? [],
      // The fan-out happened on the server, so there is nothing local to time.
      timings: {}
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
   * Commit against the picked provider (`/v2/swap`), carrying it so the committed quote matches the
   * shown price. Handles both paths: a **Stellar in-chain** provider sends `chainId: stellar` and
   * validates the Stellar addresses (and rejects a third-party recipient for SB/AQUARIUS); a
   * **cross-chain** provider sends `refundAddress` (required, defaults to `sourceAddress`) and no
   * `chainId`. `destinationAddress` defaults to `sourceAddress`.
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

    if (this.isLocal) {
      return this.router.commit({
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
    }

    return this.client.swap({
      sellAsset: this.normalizeAssetId(params.sellAsset),
      buyAsset: this.normalizeAssetId(params.buyAsset),
      sellAmount: this.normalizeAmountFor(params.sellAsset, params.sellAmount),
      slippage: params.slippage,
      provider: params.provider,
      sourceAddress: params.sourceAddress,
      destinationAddress,
      // Keep each path's request exactly as the server expects: chainId for Stellar in-chain,
      // refundAddress for NEAR transfer routes, neither for Axelar ITS (a signed Stellar tx).
      ...(stellar
        ? { chainId: STELLAR_CHAIN_ID }
        : transfer
          ? { refundAddress: params.refundAddress ?? params.sourceAddress }
          : {})
    })
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
   * Execute AND report to `/v2/track` in one call — including on a StellarBroker partial failure
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
        track = await this.track(route.uuid, execution.inboundTxHash)
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
   * Report the broadcast hash and read current status (`POST /v2/track`).
   *
   * Tracking is the one capability local routing does not replace: reconciling a swap's outcome
   * means watching Horizon after the fact, which is a server's job, not a page's. Configure
   * `apiBaseUrl` + `apiKey` to use it in either routing mode. Without a server, a
   * `signed_transaction` route's outcome is already known the moment Horizon returns from the
   * submit (`ExecutionResult.submit`), since that call blocks until ledger inclusion.
   */
  async track(uuid: string, inboundTxHash?: string): Promise<TrackResponse> {
    requireServer(this.config, 'track()')
    return this.client.track({ uuid, ...(inboundTxHash ? { inboundTxHash } : {}) })
  }

  /** Poll `/v2/track` until a terminal status (or timeout). */
  async pollTrack(uuid: string, inboundTxHash: string | undefined, opts: PollOptions = {}): Promise<TrackResponse> {
    const interval = opts.intervalMs ?? 60_000
    const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000)
    // Send the hash on the first poll; subsequent polls only need the uuid (server remembers it).
    let hash = inboundTxHash
    for (;;) {
      if (opts.signal?.aborted) throw new StellarSwapError('aborted', 'Polling aborted')
      const status = await this.track(uuid, hash)
      hash = undefined
      opts.onUpdate?.(status)
      if (TERMINAL_STATUSES.includes(status.status)) return status
      if (Date.now() >= deadline) return status
      await delay(interval, opts.signal)
    }
  }

  // --- cross-chain helpers (the unified quote/commit/execute handle routing) ---

  /**
   * The cross-chain asset catalog for a `transfer` provider (`GET /v2/tokens`). Use the returned
   * `identifier`s as `sellAsset`/`buyAsset` — never hand-build them. Defaults to NEAR.
   */
  async crossChainTokens(provider = 'NEAR'): Promise<TokenInfo[]> {
    if (this.isLocal) return this.router.crossChainTokens(provider)
    return this.client.tokens(provider)
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
