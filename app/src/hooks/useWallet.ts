import { useCallback, useEffect, useState } from 'react'
import type { Address, EIP1193Provider } from 'viem'
import { connect as requestAccounts, currentChainId, discoverWallets, type DiscoveredWallet } from '../lib/wallet'

export type WalletState = {
  wallets: DiscoveredWallet[]
  provider: EIP1193Provider | null
  account: Address | null
  chainId: number | null
  connecting: boolean
  error: string | null
}

const LAST_WALLET_KEY = 'clearswap:last-wallet'

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    wallets: [],
    provider: null,
    account: null,
    chainId: null,
    connecting: false,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    discoverWallets().then((wallets) => {
      if (!cancelled) setState((prev) => ({ ...prev, wallets }))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const connect = useCallback(async (wallet: DiscoveredWallet) => {
    setState((prev) => ({ ...prev, connecting: true, error: null }))
    try {
      const [account] = await requestAccounts(wallet.provider)
      const chainId = await currentChainId(wallet.provider)
      localStorage.setItem(LAST_WALLET_KEY, wallet.id)
      setState((prev) => ({ ...prev, provider: wallet.provider, account, chainId, connecting: false }))
    } catch (error) {
      const code = (error as { code?: number })?.code
      setState((prev) => ({
        ...prev,
        connecting: false,
        error: code === 4001 ? 'Connection declined.' : (error as Error).message,
      }))
    }
  }, [])

  const disconnect = useCallback(() => {
    localStorage.removeItem(LAST_WALLET_KEY)
    setState((prev) => ({ ...prev, provider: null, account: null, chainId: null }))
  }, [])

  // Track the wallet's own state changes; a user switching accounts in the
  // extension must not leave a stale address on screen next to a quote.
  useEffect(() => {
    const provider = state.provider
    if (!provider) return

    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[]
      setState((prev) => ({ ...prev, account: (accounts[0] as Address) ?? null }))
    }
    const onChainChanged = (...args: unknown[]) => {
      const chainId = args[0] as string
      setState((prev) => ({ ...prev, chainId: Number.parseInt(chainId, 16) }))
    }

    provider.on('accountsChanged', onAccountsChanged)
    provider.on('chainChanged', onChainChanged)

    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged)
      provider.removeListener('chainChanged', onChainChanged)
    }
  }, [state.provider])

  return { ...state, connect, disconnect }
}
