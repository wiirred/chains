import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { scanWallet, type TokenBalance } from '../lib/balances'
import type { Token } from '../lib/router'

export type BalanceState = {
  balances: TokenBalance[]
  /** Chains still being scanned, so the UI can say "still looking" honestly. */
  pending: number[]
  failed: number[]
  scanning: boolean
}

/**
 * Scan the connected wallet across every tradeable chain.
 *
 * Results stream in per chain. Some public RPCs will be down at any given moment,
 * and a chain that failed to answer is reported as failed rather than silently
 * shown as an empty balance — "you have nothing here" and "we could not check" are
 * very different statements to make about someone's money.
 */
export function useBalances(account: Address | null, tokensByChain: Record<number, Token[]>) {
  const [state, setState] = useState<BalanceState>({ balances: [], pending: [], failed: [], scanning: false })

  const chainKey = Object.keys(tokensByChain).sort().join(',')

  useEffect(() => {
    if (!account || Object.keys(tokensByChain).length === 0) {
      setState({ balances: [], pending: [], failed: [], scanning: false })
      return
    }

    const controller = new AbortController()
    const chainIds = Object.keys(tokensByChain).map(Number)

    setState({ balances: [], pending: chainIds, failed: [], scanning: true })

    scanWallet(
      account,
      tokensByChain,
      ({ chainId, balances, error }) => {
        setState((prev) => ({
          ...prev,
          balances: [...prev.balances, ...balances].sort((a, b) => b.usd - a.usd),
          pending: prev.pending.filter((id) => id !== chainId),
          failed: error ? [...prev.failed, chainId] : prev.failed,
        }))
      },
      controller.signal,
    ).finally(() => {
      if (!controller.signal.aborted) setState((prev) => ({ ...prev, scanning: false, pending: [] }))
    })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, chainKey])

  return state
}
