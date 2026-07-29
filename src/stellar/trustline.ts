import { Account, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { ResolvedConfig } from '../core/config.js'
import { StellarSwapError } from '../core/errors.js'
import { StellarAsset, isNativeAsset, toStellarSdkAsset } from '../core/assets.js'
import { HorizonClient, HorizonSubmitResult, accountHoldsTrustline } from './horizon.js'
import { StellarSigner, signTransaction } from '../core/signer.js'

/** Base fee (stroops) for the small single-op changeTrust tx. Generous to survive mild surge. */
const CHANGE_TRUST_BASE_FEE = '10000'

export interface TrustlineStatus {
  /** `true` when a trustline must be created before the buy asset can be received. */
  required: boolean
  /** The asset that needs (or has) the trustline. */
  asset: StellarAsset
  /** Whether the account already exists on-chain. */
  accountExists: boolean
}

/**
 * Trustline gate for buying a classic asset. Buying an asset the recipient doesn't hold a
 * trustline for is rejected (server preflight / on-chain `op_no_trust`) — so the SDK checks the
 * recipient's balances first and offers activation (a `changeTrust` op) before quoting. Native
 * XLM never needs one. See guide §3.
 */
export class TrustlineManager {
  private readonly horizon: HorizonClient

  constructor(private readonly config: ResolvedConfig) {
    this.horizon = new HorizonClient(config)
  }

  /** Does `recipient` need a trustline before it can receive `buyAsset`? */
  async check(recipient: string, buyAsset: StellarAsset): Promise<TrustlineStatus> {
    if (isNativeAsset(buyAsset)) {
      return { required: false, asset: buyAsset, accountExists: true }
    }
    const account = await this.horizon.getAccount(recipient)
    return {
      required: !accountHoldsTrustline(account, buyAsset),
      asset: buyAsset,
      accountExists: account !== null
    }
  }

  /**
   * Build, sign, and submit a `changeTrust` transaction that activates `asset` on the signer's
   * own account. `limit` is optional (default = max). The signer MUST be the account gaining the
   * trustline. Returns the Horizon submit result; the caller can then re-quote.
   */
  async activate(signer: StellarSigner, asset: StellarAsset, limit?: string): Promise<HorizonSubmitResult> {
    if (isNativeAsset(asset)) {
      throw new StellarSwapError('invalid_params', 'Native XLM does not need a trustline')
    }
    const account = await this.horizon.getAccount(signer.publicKey)
    if (!account) {
      throw new StellarSwapError(
        'invalid_params',
        `Account ${signer.publicKey} does not exist on-chain — fund it with XLM before adding a trustline`
      )
    }
    const source = new Account(account.id, account.sequence)
    const tx = new TransactionBuilder(source, {
      fee: CHANGE_TRUST_BASE_FEE,
      networkPassphrase: this.config.networkPassphrase
    })
      .addOperation(
        Operation.changeTrust({
          asset: toStellarSdkAsset(asset),
          ...(limit ? { limit } : {})
        })
      )
      .setTimeout(180)
      .build()

    await signTransaction(tx, signer)
    return this.horizon.submit(tx)
  }
}
