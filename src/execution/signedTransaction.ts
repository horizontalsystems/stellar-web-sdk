import { FeeBumpTransaction, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { ResolvedConfig } from '../core/config.js'
import { StellarSwapError } from '../core/errors.js'
import { HorizonClient, HorizonSubmitResult } from '../stellar/horizon.js'
import { StellarSigner, signTransaction } from '../core/signer.js'
import { fromStroops } from '../core/amounts.js'
import { CommittedRoute, SignedTransactionExecution } from '../core/types.js'

export interface SignedTxPreview {
  /** The parsed envelope. */
  tx: Transaction | FeeBumpTransaction
  /** Max network fee bid, in XLM (envelope fee / 10^7). */
  networkFeeXlm: string
  /** The enforced on-chain minimum received, echoed from the committed route (may be null for SB — N/A here). */
  minBuyAmount: string | null
  /** The route's expected buy amount, for display. */
  expectedBuyAmount: string
}

/**
 * The straightforward execution path: SOROSWAP / AQUARIUS / STELLAR_DEX return a fully built
 * envelope. Parse it (to preview fee + enforced minimum), sign it verbatim with the trader key,
 * and submit to Horizon. Do NOT re-sequence, re-fee, or rebuild — Soroban routes carry a
 * simulated resource footprint tied to exactly this tx.
 */
export class SignedTransactionExecutor {
  private readonly horizon: HorizonClient

  constructor(private readonly config: ResolvedConfig) {
    this.horizon = new HorizonClient(config)
  }

  /** Parse the committed route's envelope and expose fee + minimum for a confirmation screen. */
  preview(route: CommittedRoute): SignedTxPreview {
    const execution = expectSignedTx(route.execution)
    const xdr = firstStellarXdr(execution)
    const tx = TransactionBuilder.fromXDR(xdr, this.config.networkPassphrase)
    return {
      tx,
      networkFeeXlm: fromStroops(BigInt(tx.fee)),
      minBuyAmount: route.minBuyAmount,
      expectedBuyAmount: route.expectedBuyAmount
    }
  }

  /**
   * Sign and submit the committed route's envelope. Returns the Horizon result — its `hash` is
   * what you track by. Horizon submit is synchronous, so a failure surfaces here.
   */
  async execute(route: CommittedRoute, signer: StellarSigner): Promise<HorizonSubmitResult> {
    const { tx } = this.preview(route)
    // A server-built envelope is never a fee-bump; guard so we don't try to re-sign a wrapper.
    if (tx instanceof FeeBumpTransaction) {
      throw new StellarSwapError('signing_rejected', 'Unexpected fee-bump envelope from a signed_transaction route')
    }
    await signTransaction(tx, signer)
    return this.horizon.submit(tx)
  }
}

function expectSignedTx(execution: CommittedRoute['execution']): SignedTransactionExecution {
  if (execution.method !== 'signed_transaction') {
    throw new StellarSwapError(
      'invalid_params',
      `Route execution.method is ${execution.method}, not signed_transaction`
    )
  }
  return execution
}

function firstStellarXdr(execution: SignedTransactionExecution): string {
  const tx = execution.transactions?.[0]
  if (!tx || tx.kind !== 'stellar' || !tx.xdr) {
    throw new StellarSwapError('server_error', 'signed_transaction route has no Stellar envelope', {
      details: execution
    })
  }
  return tx.xdr
}
