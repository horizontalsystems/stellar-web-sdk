/**
 * StellarBroker WebSocket protocol message shapes. The broker is the source of
 * truth for every field; we type only what the session driver reads and keep the rest open.
 */

// --- inbound (broker → client) ---------------------------------------------

export interface ConnectedMessage {
  type: 'connected'
  uid: string
}

export interface PingMessage {
  type: 'ping'
  uid: string
}

export interface BrokerQuote {
  status: 'success' | 'unfeasible' | 'rejected' | string
  /** Estimated buy amount (decimal string) when status is success. */
  estimatedBuyingAmount?: string
  sold?: string
  bought?: string
  error?: string
  [k: string]: unknown
}

export interface QuoteMessage {
  type: 'quote'
  quote: BrokerQuote
}

export interface TxMessage {
  type: 'tx'
  /** Broker's correlation id for this tx — echo it verbatim in the reply. */
  hash: string
  /** Base64 TransactionEnvelope the broker built for the client to sign. */
  xdr: string
  /** Max network fee (stroops) the fee-bump should bid. */
  networkFee: string | number
}

export interface ProgressMessage {
  type: 'progress'
  sold?: string
  bought?: string
}

export interface PausedMessage {
  type: 'paused'
}

export interface StopMessage {
  type: 'stop'
  status: 'success' | string
  sold?: string
  bought?: string
}

export interface ErrorMessage {
  type: 'error'
  error?: string
  [k: string]: unknown
}

export type InboundMessage =
  | ConnectedMessage
  | PingMessage
  | QuoteMessage
  | TxMessage
  | ProgressMessage
  | PausedMessage
  | StopMessage
  | ErrorMessage
  | { type: string; [k: string]: unknown }

// --- outbound (client → broker) --------------------------------------------

export interface PongMessage {
  type: 'pong'
  uid: string
}

export interface QuoteRequestMessage {
  type: 'quote'
  sellingAsset: string
  buyingAsset: string
  sellingAmount: string
  slippageTolerance: number
}

export interface TradeMessage {
  type: 'trade'
  account: string
}

export interface SignedTxMessage {
  type: 'tx'
  hash: string
  xdr: string
}

export type OutboundMessage = PongMessage | QuoteRequestMessage | TradeMessage | SignedTxMessage
