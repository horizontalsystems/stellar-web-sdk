/**
 * AXELAR_ITS static catalog — the assets we bridge, and the chain-name encodings the route needs.
 * Ported from `uswap-server/src/providers/axelar/AxelarConfig.ts`.
 *
 * ITS is same-token bridging (1:1, no pricing): an asset here exists on several chains under ONE
 * ITS token id, and a transfer burns or locks on the source and mints or unlocks on the
 * destination. Axelar's registry lists six Stellar-touching assets; only the ones whose Stellar
 * side is native XLM or a CLASSIC asset are carried. Pure-Soroban tokens (USDC.axl, solvBTC,
 * xSolvBTC) are deliberately excluded — wallets can't hold them, and USDC.axl in particular is NOT
 * Circle's classic Stellar USDC, so bridging it would strand users with a token no Stellar anchor
 * recognizes.
 *
 * The table is hardcoded rather than synced: after that filter the yield is two assets, and each
 * entry carries hand-verified execution facts (the token id, the decimals) that a blind sync
 * could not vouch for.
 */

export interface AxelarItsEntry {
  /** Chain code, matching our asset identifiers. */
  chain: string
  /** Our asset identifier, with the address suffix uppercased. */
  identifier: string
  /** The ERC-20 contract on an EVM chain. Absent on the Stellar side. */
  erc20?: string
}

export interface AxelarItsAsset {
  symbol: string
  /** The ITS token id (bytes32) — one per asset, shared across every chain it lives on. */
  tokenId: string
  entries: AxelarItsEntry[]
}

/**
 * Chain code → the identifier the Axelarscan/GMP API uses (`estimateITSFee`, `searchGMP`).
 */
export const AXELAR_GMP_CHAIN_NAMES: Record<string, string> = {
  XLM: 'stellar',
  ETH: 'ethereum'
}

/**
 * Chain code → the chain name as the ITS GATEWAYS know it: the `destination_chain` argument of an
 * interchain transfer. This is NOT the same casing as the GMP API names. Amplifier chains are
 * lowercase (`stellar`) while consensus EVM chains keep their original capitalized registration
 * (`Ethereum`), and the trusted-chain lookup is an exact string match — a lowercase `ethereum`
 * sent from Stellar is an untrusted chain and the transfer reverts. Both casings are verified
 * against live on-chain transfer decodes.
 */
export const AXELAR_ITS_CHAIN_NAMES: Record<string, string> = {
  XLM: 'stellar',
  ETH: 'Ethereum'
}

/**
 * Both assets are 7 decimals on BOTH sides — the ERC-20s mirror Stellar's classic precision — so
 * the base-unit amount crosses the bridge unchanged and the stroop helpers serve both directions.
 */
export const AXELAR_ITS_DECIMALS = 7

export const AXELAR_ITS_ASSETS: AxelarItsAsset[] = [
  {
    symbol: 'XLM',
    // NOT the Axelarscan registry's id, which is stale and divergent — the Stellar ITS rejects it
    // with InvalidTokenId. The authoritative id is the one embedded in the Ethereum ERC-20
    // (`interchainTokenId()`) and used by live transfers, verified both ways. SHX's registry id
    // happens to match its embedded id; XLM's does not.
    tokenId: '0x03f70cfcbaa3dbf171db65410238e05b58c3ae7cb0219cb7068d59d56af96fb4',
    entries: [
      { chain: 'XLM', identifier: 'XLM.XLM' },
      {
        chain: 'ETH',
        identifier: 'ETH.XLM-0X8CF74FC1EC7B2187DDA77EA289F78CC54E2B7C8B',
        erc20: '0x8CF74FC1EC7B2187DDA77EA289F78CC54E2B7C8B'
      }
    ]
  },
  {
    symbol: 'SHX',
    tokenId: '0x91e104d86483f05635e0dbb3a9016677e00a7504572ea1890ca478eb8750bcfe',
    entries: [
      { chain: 'XLM', identifier: 'XLM.SHX-GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH' },
      {
        chain: 'ETH',
        identifier: 'ETH.SHX-0X516D31321928700C6B4FB0DB0C8C6BC5D6799787',
        erc20: '0x516D31321928700C6B4FB0DB0C8C6BC5D6799787'
      }
    ]
  }
]

/** Stellar mainnet InterchainTokenService contract (official axelar-contract-deployments registry). */
export const DEFAULT_STELLAR_ITS_CONTRACT = 'CBDBMIOFHGWUFRYH3D3STI2DHBOWGDDBCRKQEUB4RGQEBVG74SEED6C6'

/** Resolve a request identifier to its ITS asset and chain entry. Case-insensitive. */
export function findAxelarEntry(identifier: string): { asset: AxelarItsAsset; entry: AxelarItsEntry } | undefined {
  const wanted = identifier.toUpperCase()
  for (const asset of AXELAR_ITS_ASSETS) {
    const entry = asset.entries.find((e) => e.identifier.toUpperCase() === wanted)
    if (entry) return { asset, entry }
  }
  return undefined
}

/** Every identifier AXELAR_ITS can bridge — used by route discovery to skip an ineligible pair. */
export function axelarIdentifiers(): string[] {
  return AXELAR_ITS_ASSETS.flatMap((a) => a.entries.map((e) => e.identifier))
}
