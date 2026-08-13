import { useEffect, useMemo, useState } from 'react'
import { getSupportedChains, getToken, getTokens, type ChainSupport, type Token } from '../lib/router'
import { CORE_CHAINS, chainById } from '../lib/registry'

/**
 * Tokens are trimmed per chain rather than held in full. The complete list runs
 * to tens of thousands of entries across all chains, almost all of them illiquid;
 * the head of each list covers everything a person is realistically trading, and
 * anything else is resolved on demand by address.
 */
const TOKENS_PER_CHAIN = 200

/** How many holdings per chain the balance scan looks at. */
export const RADAR_TOKENS_PER_CHAIN = 12

export type TokenState = {
  /** Chains the router can actually route, intersected with our registry. */
  tradeableChains: number[]
  chainSupport: Record<number, ChainSupport>
  tokensByChain: Record<number, Token[]>
  loading: boolean
  error: string | null
}

export function useTokens() {
  const [state, setState] = useState<TokenState>({
    tradeableChains: [],
    chainSupport: {},
    tokensByChain: {},
    loading: true,
    error: null,
  })

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      try {
        const supported = await getSupportedChains(controller.signal)

        // A chain is only usable here if the router can route it *and* the
        // dataset gives us a public RPC to read balances from.
        const support: Record<number, ChainSupport> = {}
        const tradeable: number[] = []
        for (const chain of supported) {
          if (!chainById(chain.id)) continue
          support[chain.id] = chain
          tradeable.push(chain.id)
        }

        // Keep the core ordering so familiar chains appear first.
        const coreOrder = new Map(CORE_CHAINS.map((chain, index) => [chain.chainId, index]))
        tradeable.sort((a, b) => (coreOrder.get(a) ?? 999) - (coreOrder.get(b) ?? 999))

        setState((prev) => ({ ...prev, tradeableChains: tradeable, chainSupport: support }))

        const tokens = await getTokens(tradeable, controller.signal)

        const trimmed: Record<number, Token[]> = {}
        for (const [chainId, list] of Object.entries(tokens)) {
          trimmed[Number(chainId)] = list.slice(0, TOKENS_PER_CHAIN)
        }

        setState((prev) => ({ ...prev, tokensByChain: trimmed, loading: false }))
      } catch (error) {
        if (controller.signal.aborted) return
        setState((prev) => ({
          ...prev,
          loading: false,
          error: `Could not reach the routing API: ${(error as Error).message}`,
        }))
      }
    }

    load()
    return () => controller.abort()
  }, [])

  /** A small, liquid slice per chain — enough to find where someone's money is. */
  const radarTokens = useMemo(() => {
    const map: Record<number, Token[]> = {}
    for (const [chainId, list] of Object.entries(state.tokensByChain)) {
      map[Number(chainId)] = list.slice(0, RADAR_TOKENS_PER_CHAIN)
    }
    return map
  }, [state.tokensByChain])

  return { ...state, radarTokens }
}

/** Resolve a token the trimmed list does not contain, by address. */
export function useTokenLookup(chainId: number | null, query: string, known: Token[]) {
  const [resolved, setResolved] = useState<Token | null>(null)
  const [looking, setLooking] = useState(false)

  const isAddressQuery = /^0x[a-fA-F0-9]{40}$/.test(query.trim())

  useEffect(() => {
    setResolved(null)
    if (!chainId || !isAddressQuery) return

    const address = query.trim().toLowerCase()
    if (known.some((token) => token.address.toLowerCase() === address)) return

    const controller = new AbortController()
    setLooking(true)

    getToken(chainId, address, controller.signal)
      .then((token) => setResolved(token))
      .catch(() => setResolved(null))
      .finally(() => {
        if (!controller.signal.aborted) setLooking(false)
      })

    return () => controller.abort()
  }, [chainId, query, isAddressQuery, known])

  return { resolved, looking, isAddressQuery }
}
