/**
 * stellar-web-sdk
 *
 * Web SDK for Stellar swaps against uswap-server. Applies the StellarBroker-first waterfall over
 * StellarBroker / Soroswap / Aquarius / Stellar DEX, executes client-side (signed-transaction +
 * StellarBroker WebSocket session with the full signing pipeline), and tracks server-side.
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

export type { StellarSwapConfig, ResolvedConfig } from './core/config.js'
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
  STELLAR_DECIMALS
} from './core/amounts.js'

// Waterfall policy (exported for custom routing / testing)
export {
  selectRoute,
  bestByExpected,
  providersForRecipient,
  isThirdPartyRecipient,
  routeProvider,
  compareDecimals
} from './core/waterfall.js'

// Services (advanced use)
export { UswapClient } from './client/UswapClient.js'
export { TrustlineManager } from './stellar/trustline.js'
export type { TrustlineStatus } from './stellar/trustline.js'
export { HorizonClient, accountHoldsTrustline } from './stellar/horizon.js'
export type { HorizonAccount, HorizonBalance, HorizonSubmitResult } from './stellar/horizon.js'
export { SignedTransactionExecutor } from './execution/signedTransaction.js'
export type { SignedTxPreview } from './execution/signedTransaction.js'
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
  StellarSignedTx,
  Fee,
  FeeType,
  EstimatedTime,
  Accuracy,
  RateRequest,
  RateResponse,
  SwapRequest,
  ProviderError,
  TrackRequest,
  TrackResponse,
  TrackStatus,
  TrackLeg,
  BalanceEntry,
  StellarProvider
} from './core/types.js'
export {
  STELLAR_PROVIDERS,
  RECIPIENT_CAPABLE_PROVIDERS,
  STELLAR_CHAIN_ID,
  TERMINAL_STATUSES
} from './core/types.js'
