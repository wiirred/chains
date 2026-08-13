/**
 * Where the user's money actually is.
 *
 * The premise of the bridging feature is that people hold funds on one chain and
 * want to trade on another, and today that means leaving the trade, finding a
 * bridge, waiting, and coming back. To fold bridging into the trade we first have
 * to know what is sitting where, so this scans a wallet across every chain the
 * router can reach.
 */
import { erc20Abi, isAddress, type Address } from 'viem'
import { formatUnits } from 'viem'
import type { Token } from './router'
import { publicClientFor } from './wallet'

/** The router's convention for "this chain's native coin". */
export const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000'

export type TokenBalance = {
  chainId: number
  token: Token
  raw: bigint
  decimal: string
  usd: number
}

function priceOf(token: Token): number {
  const price = Number(token.priceUSD)
  return Number.isFinite(price) ? price : 0
}

function toBalance(chainId: number, token: Token, raw: bigint): TokenBalance {
  const decimal = formatUnits(raw, token.decimals)
  return { chainId, token, raw, decimal, usd: Number(decimal) * priceOf(token) }
}

/**
 * Balances for one chain. Native coin via `eth_getBalance`, everything else in a
 * single multicall so scanning thirty chains does not mean a thousand round
 * trips.
 */
export async function scanChain(chainId: number, account: Address, tokens: Token[]): Promise<TokenBalance[]> {
  const client = publicClientFor(chainId)
  if (!client) return []

  const native = tokens.filter((token) => token.address.toLowerCase() === NATIVE_ADDRESS)
  const erc20s = tokens.filter(
    (token) => token.address.toLowerCase() !== NATIVE_ADDRESS && isAddress(token.address),
  )

  const results: TokenBalance[] = []

  const [nativeResult, erc20Results] = await Promise.allSettled([
    native.length ? client.getBalance({ address: account }) : Promise.resolve(null),
    erc20s.length
      ? client.multicall({
          contracts: erc20s.map((token) => ({
            address: token.address as Address,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [account] as const,
          })),
          allowFailure: true,
        })
      : Promise.resolve([]),
  ])

  if (nativeResult.status === 'fulfilled' && nativeResult.value !== null && native[0]) {
    results.push(toBalance(chainId, native[0], nativeResult.value))
  }

  if (erc20Results.status === 'fulfilled') {
    erc20Results.value.forEach((entry, index) => {
      // A chain without Multicall3, or a token that is not really an ERC-20,
      // fails individually rather than taking the whole scan down.
      if (entry.status !== 'success') return
      const raw = entry.result as bigint
      if (raw > 0n) results.push(toBalance(chainId, erc20s[index], raw))
    })
  }

  return results.filter((balance) => balance.raw > 0n)
}

export type ScanProgress = {
  chainId: number
  balances: TokenBalance[]
  error?: string
}

/**
 * Scan many chains at once, reporting each as it lands so the UI can fill in
 * progressively instead of blocking on the slowest public RPC.
 */
export async function scanWallet(
  account: Address,
  tokensByChain: Record<number, Token[]>,
  onChain?: (progress: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<TokenBalance[]> {
  const chainIds = Object.keys(tokensByChain).map(Number)

  const settled = await Promise.all(
    chainIds.map(async (chainId) => {
      if (signal?.aborted) return []
      try {
        const balances = await scanChain(chainId, account, tokensByChain[chainId] ?? [])
        if (!signal?.aborted) onChain?.({ chainId, balances })
        return balances
      } catch (error) {
        if (!signal?.aborted) {
          onChain?.({ chainId, balances: [], error: error instanceof Error ? error.message : 'RPC unavailable' })
        }
        return []
      }
    }),
  )

  return settled.flat().sort((a, b) => b.usd - a.usd)
}

export type FundingOption = {
  balance: TokenBalance
  /** True when these funds are already on the chain the trade starts from. */
  local: boolean
  /** True when the holding alone covers what the trade needs. */
  covers: boolean
}

/**
 * Given what a trade needs, rank the holdings that could pay for it.
 *
 * Funds already on the source chain sort first — bridging costs money and time,
 * and an interface that nudges people across a bridge they did not need is doing
 * the opposite of its job. Everything else is ranked by whether it covers the
 * trade outright, then by size.
 */
export function findFunding(
  balances: TokenBalance[],
  need: { chainId: number; usd: number },
  options: { minUsd?: number } = {},
): FundingOption[] {
  const minUsd = options.minUsd ?? 1

  return balances
    .filter((balance) => balance.usd >= minUsd)
    .map((balance) => ({
      balance,
      local: balance.chainId === need.chainId,
      covers: balance.usd >= need.usd,
    }))
    .sort((a, b) => {
      if (a.local !== b.local) return a.local ? -1 : 1
      if (a.covers !== b.covers) return a.covers ? -1 : 1
      return b.balance.usd - a.balance.usd
    })
}

/** Total portfolio value across every scanned chain. */
export function totalUsd(balances: TokenBalance[]): number {
  return balances.reduce((sum, balance) => sum + balance.usd, 0)
}

/** Portfolio value grouped by chain, largest first. */
export function byChain(balances: TokenBalance[]): { chainId: number; usd: number; balances: TokenBalance[] }[] {
  const groups = new Map<number, TokenBalance[]>()
  for (const balance of balances) {
    const group = groups.get(balance.chainId)
    if (group) group.push(balance)
    else groups.set(balance.chainId, [balance])
  }

  return [...groups.entries()]
    .map(([chainId, group]) => ({ chainId, usd: totalUsd(group), balances: group }))
    .sort((a, b) => b.usd - a.usd)
}
