import { useState } from 'react'
import type { DiscoveredWallet } from '../lib/wallet'
import type { Address } from 'viem'
import { chainName } from '../lib/registry'
import { shortAddress } from '../lib/format'

export type WalletMenuProps = {
  wallets: DiscoveredWallet[]
  account: Address | null
  chainId: number | null
  connecting: boolean
  error: string | null
  onConnect: (wallet: DiscoveredWallet) => void
  onDisconnect: () => void
}

export function WalletMenu({ wallets, account, chainId, connecting, error, onConnect, onDisconnect }: WalletMenuProps) {
  const [open, setOpen] = useState(false)

  if (account) {
    return (
      <div className="wallet">
        <span className="wallet__chain">{chainId ? chainName(chainId) : 'Unknown network'}</span>
        <button type="button" className="wallet__account" onClick={onDisconnect} title="Disconnect">
          {shortAddress(account)}
        </button>
      </div>
    )
  }

  if (wallets.length === 0) {
    return (
      <a className="button button--ghost" href="https://ethereum.org/en/wallets/find-wallet/" target="_blank" rel="noreferrer noopener">
        No wallet detected
      </a>
    )
  }

  if (wallets.length === 1) {
    return (
      <button type="button" className="button" onClick={() => onConnect(wallets[0])} disabled={connecting}>
        {connecting ? 'Connecting…' : `Connect ${wallets[0].name}`}
      </button>
    )
  }

  return (
    <div className="wallet">
      <button type="button" className="button" onClick={() => setOpen((value) => !value)} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>

      {open ? (
        <ul className="wallet__list">
          {wallets.map((wallet) => (
            <li key={wallet.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onConnect(wallet)
                }}
              >
                {wallet.icon ? <img src={wallet.icon} alt="" width={20} height={20} /> : null}
                {wallet.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="wallet__error">{error}</p> : null}
    </div>
  )
}
