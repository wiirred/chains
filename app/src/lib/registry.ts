/**
 * Chain registry, sourced from this repository's own `_data/chains`.
 *
 * Using the dataset directly means the app knows about every EVM chain the list
 * covers — including the RPC endpoints and block explorer needed to add an
 * unfamiliar network to a wallet and to link a receipt to a real explorer page.
 */
import { defineChain, type Chain } from 'viem'
import coreChains from '../generated/chains.core.json'

export type ChainInfo = {
  chainId: number
  name: string
  shortName: string
  rpcs: string[]
  nativeCurrency: { name: string; symbol: string; decimals: number }
  explorer: { name: string; url: string } | null
  testnet?: boolean
}

/** Chains shown up front, bundled eagerly. */
export const CORE_CHAINS = coreChains as ChainInfo[]

const byId = new Map<number, ChainInfo>(CORE_CHAINS.map((chain) => [chain.chainId, chain]))

let fullRegistry: Promise<ChainInfo[]> | null = null

/**
 * The complete registry — every non-deprecated chain in the dataset. Loaded on
 * demand because it is several hundred kilobytes and most sessions never need it.
 */
export function loadAllChains(): Promise<ChainInfo[]> {
  if (!fullRegistry) {
    fullRegistry = import('../generated/chains.json').then((module) => {
      const chains = module.default as ChainInfo[]
      for (const chain of chains) {
        if (!byId.has(chain.chainId)) byId.set(chain.chainId, chain)
      }
      return chains
    })
  }
  return fullRegistry
}

/** Synchronous lookup. Resolves core chains always, others once the full registry is loaded. */
export function chainById(chainId: number): ChainInfo | undefined {
  return byId.get(chainId)
}

/** Look up a chain, loading the full registry if the id is not a core one. */
export async function resolveChain(chainId: number): Promise<ChainInfo | undefined> {
  const known = byId.get(chainId)
  if (known) return known
  await loadAllChains()
  return byId.get(chainId)
}

export function chainName(chainId: number): string {
  return byId.get(chainId)?.name ?? `Chain ${chainId}`
}

/** EIP-3091 explorer link for a transaction. */
export function explorerTxUrl(chainId: number, hash: string): string | null {
  const explorer = byId.get(chainId)?.explorer
  return explorer ? `${explorer.url}/tx/${hash}` : null
}

export function explorerAddressUrl(chainId: number, address: string): string | null {
  const explorer = byId.get(chainId)?.explorer
  return explorer ? `${explorer.url}/address/${address}` : null
}

/**
 * Multicall3 ships at the same address on essentially every EVM chain, which is
 * what makes scanning a wallet across dozens of chains cheap enough to do on page
 * load. Chains without it are handled by falling back to individual calls.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

export function toViemChain(info: ChainInfo): Chain {
  return defineChain({
    id: info.chainId,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: info.rpcs } },
    blockExplorers: info.explorer
      ? { default: { name: info.explorer.name, url: info.explorer.url } }
      : undefined,
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    testnet: info.testnet,
  })
}

/** Payload for `wallet_addEthereumChain`, built straight from the dataset. */
export function addChainParams(info: ChainInfo) {
  return {
    chainId: `0x${info.chainId.toString(16)}`,
    chainName: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: info.rpcs,
    blockExplorerUrls: info.explorer ? [info.explorer.url] : [],
  }
}
