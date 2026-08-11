/**
 * stellar-web-sdk
 *
 * A self-contained Stellar swap SDK. It ships the provider adapters themselves — StellarBroker,
 * Soroswap, Aquarius, Stellar DEX, NEAR and Axelar ITS — so quote fetching, normalization, route
 * construction, route discovery and the routing solver all run in this package. Execution is
 * client-side too: signed envelopes go straight to Horizon, and StellarBroker routes run the
 * interactive WebSocket session with its full signing pipeline.
 *
 * Outcome tracking runs the same way: Horizon for the Stellar-native providers, 1Click's status
 * endpoint for NEAR, the Axelarscan GMP API for Axelar ITS. No backend is involved anywhere.
 */

export { StellarSwapSDK } from './StellarSwapSDK.js'
export type {
  QuoteParams,
  QuoteResult,
  CommitParams,
  ExecuteOptions,
  ExecutionResult,
  PollOptions
} from './StellarSwapSDK.js'

export type { StellarSwapConfig, ResolvedConfig, ValidationCloudConfig } from './core/config.js'
export { StellarSwapError } from './core/errors.js'
export type { StellarSwapErrorCode } from './core/errors.js'

// Signer
export type { StellarSigner } from './core/signer.js'
export {
  keypairSigner,
  signTransaction,
  txCarriesSignatureFrom,
  signAuthEntry,
  signatureHint
} from './core/signer.js'

// Assets & amounts
export {
  parseStellarAssetIdentifier,
  parseBrokerAsset,
  stellarAssetId,
  horizonAssetString,
  horizonAssetType,
  sacContractId,
  toStellarSdkAsset,
  isNativeAsset,
  isStellarAccountId,
  isStellarContractId,
  isStellarAssetCode
} from './core/assets.js'
export type { StellarAsset } from './core/assets.js'
export {
  normalizeStellarAmount,
  toStroops,
  fromStroops,
  apiAmountToStroops,
  floorAfterSlippage,
  parseUnits,
  formatUnits,
  STELLAR_DECIMALS
} from './core/amounts.js'

// ---------------------------------------------------------------------------
// Provider adapters and the routing stack. These are the funded components — quote fetching,
// normalization, route construction, route discovery and the solver — exported individually so
// each can be inspected, tested or replaced without going through the SDK facade.
// ---------------------------------------------------------------------------

export { LocalRouter } from './routing/LocalRouter.js'
export type { LocalQuoteResult } from './routing/LocalRouter.js'
export { PROVIDER_REGISTRY, discoverProviders, providerByName, isAxelarPair } from './routing/registry.js'
export type { RegisteredProvider, Discovery, DiscoveryInput, PairKind } from './routing/registry.js'
export { runFanout, toProviderError } from './routing/fanout.js'
export type { FanoutResult } from './routing/fanout.js'
export {
  makeRoute,
  makeSignedTxExecution,
  makeStellarBrokerExecution,
  makeTransferExecution,
  replaceInboundFee
} from './routing/route.js'
export type { MakeRouteArgs } from './routing/route.js'

export { ProviderQuoteError, DEFAULT_TUNABLES } from './providers/types.js'
export type {
  QuoteErrorCode,
  ProviderQuoteRequest,
  ProviderContext,
  ProviderGetQuote,
  ProviderCredentials,
  ProviderEndpoints,
  RoutingTunables,
  ServiceFeeConfig
} from './providers/types.js'

export { getQuote as quoteStellarBroker } from './providers/stellarbroker/index.js'
export { getQuote as quoteSoroswap } from './providers/soroswap/index.js'
export { getQuote as quoteAquarius } from './providers/aquarius/index.js'
export { getQuote as quoteStellarDex, pickBestPath } from './providers/stellardex/index.js'
export { getQuote as quoteNear, fetchTokens as fetchNearTokens } from './providers/near/index.js'
export { getQuote as quoteAxelar } from './providers/axelar/index.js'
export {
  AXELAR_ITS_ASSETS,
  findAxelarEntry,
  axelarIdentifiers,
  AXELAR_GMP_CHAIN_NAMES,
  AXELAR_ITS_CHAIN_NAMES
} from './providers/axelar/config.js'
export type { AxelarItsAsset, AxelarItsEntry } from './providers/axelar/config.js'
export { encodeInterchainTransfer, INTERCHAIN_TRANSFER_SELECTOR } from './providers/axelar/abi.js'
export { stellarPreflight } from './stellar/preflight.js'

// Outcome tracking — Horizon for the Stellar providers, 1Click for NEAR, Axelarscan for Axelar.
export { trackRoute, trackStellar, trackNear, trackAxelar, sumEffects } from './tracking/index.js'

// Route-selection policy (exported for custom ranking / testing)
export {
  selectRoute,
  selectUnifiedRoute,
  bestByExpected,
  providersForRecipient,
  isThirdPartyRecipient,
  routeProvider,
  compareDecimals
} from './core/selection.js'

// Services (advanced use)
export { TrustlineManager } from './stellar/trustline.js'
export type { TrustlineStatus } from './stellar/trustline.js'
export { HorizonClient, accountHoldsTrustline } from './stellar/horizon.js'
export type { HorizonAccount, HorizonBalance, HorizonSubmitResult } from './stellar/horizon.js'
export { SignedTransactionExecutor } from './execution/signedTransaction.js'
export type { SignedTxPreview } from './execution/signedTransaction.js'
export { TransferExecutor } from './execution/transfer.js'
export type { TransferResult, DepositInstruction } from './execution/transfer.js'
export { StellarBrokerSession } from './execution/stellarBroker/StellarBrokerSession.js'
export type {
  BrokerSessionCallbacks,
  BrokerSessionResult,
  BrokerSessionPhase,
  RunSessionOptions
} from './execution/stellarBroker/StellarBrokerSession.js'
export { SigningPipeline } from './execution/stellarBroker/SigningPipeline.js'
export type { SigningPipelineOptions, SignResult } from './execution/stellarBroker/SigningPipeline.js'

// Wire types
export type {
  Route,
  CommittedRoute,
  Execution,
  SignedTransactionExecution,
  StellarBrokerExecution,
  TransferExecution,
  TokenInfo,
  RouteTracking,
  StellarSignedTx,
  EvmSignedTx,
  SignableTx,
  Fee,
  FeeType,
  EstimatedTime,
  Accuracy,
  ProviderError,
  TrackResponse,
  TrackStatus,
  TrackLeg,
  StellarProvider
} from './core/types.js'
export {
  STELLAR_PROVIDERS,
  RECIPIENT_CAPABLE_PROVIDERS,
  STELLAR_CHAIN_ID,
  TERMINAL_STATUSES
} from './core/types.js'
