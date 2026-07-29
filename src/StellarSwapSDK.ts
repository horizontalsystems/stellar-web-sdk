import { ResolvedConfig, StellarSwapConfig, resolveConfig } from './core/config.js'
import { StellarSwapError } from './core/errors.js'
import { UswapClient } from './client/UswapClient.js'
import { TrustlineManager, TrustlineStatus } from './stellar/trustline.js'
import { HorizonClient, HorizonSubmitResult } from './stellar/horizon.js'
import { SignedTransactionExecutor, SignedTxPreview } from './execution/signedTransaction.js'
import { StellarBrokerSession } from './execution/stellarBroker/StellarBrokerSession.js'
import {
  BrokerSessionCallbacks,
  BrokerSessionResult
} from './execution/stellarBroker/StellarBrokerSession.js'
import { parseBrokerAsset, parseStellarAssetIdentifier } from './core/assets.js'
import { StellarSigner, assertAccount } from './core/signer.js'
import { isThirdPartyRecipient, providersForRecipient, routeProvider, selectRoute } from './core/waterfall.js'
import {
  CommittedRoute,
  ProviderError,
  Route,
  STELLAR_CHAIN_ID,
  TERMINAL_STATUSES,
  TrackResponse
} from './core/types.js'
import { normalizeStellarAmount } from './core/amounts.js'

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
  /** The route the waterfall picked (SB-first). `undefined` when nothing routed. */
  route?: Route
  /** The provider the waterfall picked. */
  provider?: string
  /** Every route the server returned, for display/debug. */
  allRoutes: Route[]
  /** Providers that couldn't serve the pair. */
  providerErrors: ProviderError[]
}

export interface CommitParams extends QuoteParams {
  sourceAddress: string
  /** The provider to commit to — normally `QuoteResult.provider`. */
  provider: string
  /** Defaults to `sourceAddress`. */
  destinationAddress?: string
}

export interface ExecuteOptions {
  /** StellarBroker session callbacks (live quote / progress / phase). */
  callbacks?: BrokerSessionCallbacks
  signal?: AbortSignal
}

export interface ExecutionResult {
  method: 'signed_transaction' | 'stellar_broker'
  /** The hash to report to `/v2/track`. May be undefined if a broker session signed nothing. */
  inboundTxHash?: string
  /** Present for `signed_transaction` routes. */
  submit?: HorizonSubmitResult
  /** Present for `stellar_broker` routes (includes partial-failure tracking data). */
  brokerSession?: BrokerSessionResult
}

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
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
  private readonly signedTx: SignedTransactionExecutor
  private readonly broker: StellarBrokerSession

  constructor(config: StellarSwapConfig) {
    this.config = resolveConfig(config)
    this.client = new UswapClient(this.config)
    this.trustlines = new TrustlineManager(this.config)
    this.horizon = new HorizonClient(this.config)
    this.signedTx = new SignedTransactionExecutor(this.config)
    this.broker = new StellarBrokerSession(this.config)
  }

  /**
   * Price the swap across the Stellar providers and apply the waterfall. Validates assets and
   * restricts the provider set when a third-party recipient is involved (SB/AQUARIUS can't pay a
   * different destination).
   */
  async quote(params: QuoteParams): Promise<QuoteResult> {
    const sell = parseStellarAssetIdentifier(params.sellAsset)
    const buy = parseStellarAssetIdentifier(params.buyAsset)
    if (params.sourceAddress) assertAccount(params.sourceAddress, 'sourceAddress')
    if (params.destinationAddress) assertAccount(params.destinationAddress, 'destinationAddress')

    const thirdParty =
      !!params.sourceAddress && isThirdPartyRecipient(params.sourceAddress, params.destinationAddress)
    const providers = params.providers ?? providersForRecipient(thirdParty)

    const res = await this.client.rate({
      chainId: STELLAR_CHAIN_ID,
      sellAsset: sell.identifier,
      buyAsset: buy.identifier,
      sellAmount: normalizeStellarAmount(params.sellAmount),
      slippage: params.slippage,
      providers
    })

    const route = selectRoute(res.routes ?? [])
    return {
      route,
      provider: route ? routeProvider(route) : undefined,
      allRoutes: res.routes ?? [],
      providerErrors: res.providerErrors ?? []
    }
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
   * Commit against one provider (`/v2/swap`). Carries the picked provider so the committed quote
   * matches the shown price. `destinationAddress` is REQUIRED by the server even when it equals
   * the source; this defaults it to `sourceAddress`.
   */
  async commit(params: CommitParams): Promise<CommittedRoute> {
    const sell = parseStellarAssetIdentifier(params.sellAsset)
    const buy = parseStellarAssetIdentifier(params.buyAsset)
    assertAccount(params.sourceAddress, 'sourceAddress')
    const destinationAddress = params.destinationAddress ?? params.sourceAddress
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

    return this.client.swap({
      chainId: STELLAR_CHAIN_ID,
      sellAsset: sell.identifier,
      buyAsset: buy.identifier,
      sellAmount: normalizeStellarAmount(params.sellAmount),
      slippage: params.slippage,
      provider: params.provider,
      sourceAddress: params.sourceAddress,
      destinationAddress
    })
  }

  /** Preview a `signed_transaction` route's fee + enforced minimum before signing. */
  previewSignedTransaction(route: CommittedRoute): SignedTxPreview {
    return this.signedTx.preview(route)
  }

  /**
   * Execute a committed route with the trader's signer, dispatching on `execution.method`:
   *   - `signed_transaction` → sign the server-built envelope and submit to Horizon.
   *   - `stellar_broker`     → run the interactive WebSocket session (broker submits).
   * Returns the hash to track (present even on a broker partial failure).
   */
  async execute(route: CommittedRoute, signer: StellarSigner, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    const execution = route.execution
    if (execution.method === 'signed_transaction') {
      const submit = await this.signedTx.execute(route, signer)
      return { method: 'signed_transaction', inboundTxHash: submit.hash, submit }
    }
    if (execution.method === 'stellar_broker') {
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

    let track: TrackResponse | undefined
    if (execution.inboundTxHash) {
      track = await this.track(route.uuid, execution.inboundTxHash)
    }

    if (execution.brokerSession && execution.brokerSession.status === 'failed') {
      throw new StellarSwapError(
        execution.brokerSession.error?.code ?? 'broker_session_error',
        execution.brokerSession.error?.message ?? 'StellarBroker session failed',
        { details: { track, signedHashes: execution.brokerSession.signedHashes } }
      )
    }
    return { execution, track }
  }

  /** Report the broadcast hash and read current status (`POST /v2/track`). */
  async track(uuid: string, inboundTxHash?: string): Promise<TrackResponse> {
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
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new StellarSwapError('aborted', 'Aborted'))
    })
  })
}
