/**
 * Chain and token selection in one dialog, because on a cross-chain venue they
 * are one decision: "USDC" means nothing until you say where.
 */
import { useMemo, useState } from 'react'
import type { Token } from '../lib/router'
import type { TokenBalance } from '../lib/balances'
import { useTokenLookup } from '../hooks/useTokens'
import { chainName } from '../lib/registry'
import { formatToken, formatUsd } from '../lib/format'

export type AssetPickerProps = {
  title: string
  chainIds: number[]
  tokensByChain: Record<number, Token[]>
  balances: TokenBalance[]
  initialChainId: number
  onSelect: (chainId: number, token: Token) => void
  onClose: () => void
}

export function AssetPicker({
  title,
  chainIds,
  tokensByChain,
  balances,
  initialChainId,
  onSelect,
  onClose,
}: AssetPickerProps) {
  const [chainId, setChainId] = useState(initialChainId)
  const [query, setQuery] = useState('')

  const tokens = tokensByChain[chainId] ?? []
  const { resolved, looking, isAddressQuery } = useTokenLookup(chainId, query, tokens)

  const balanceFor = useMemo(() => {
    const map = new Map<string, TokenBalance>()
    for (const balance of balances) {
      map.set(`${balance.chainId}:${balance.token.address.toLowerCase()}`, balance)
    }
    return map
  }, [balances])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = needle
      ? tokens.filter(
          (token) =>
            token.symbol.toLowerCase().includes(needle) ||
            token.name.toLowerCase().includes(needle) ||
            token.address.toLowerCase() === needle,
        )
      : tokens

    // Tokens the user actually holds come first — that is nearly always what
    // they are reaching for.
    return [...list].sort((a, b) => {
      const balanceA = balanceFor.get(`${chainId}:${a.address.toLowerCase()}`)?.usd ?? 0
      const balanceB = balanceFor.get(`${chainId}:${b.address.toLowerCase()}`)?.usd ?? 0
      return balanceB - balanceA
    })
  }, [tokens, query, balanceFor, chainId])

  const results = resolved ? [resolved, ...filtered] : filtered

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal__backdrop" onClick={onClose} />

      <div className="modal__panel">
        <header className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="modal__chains">
          {chainIds.map((id) => (
            <button
              key={id}
              type="button"
              className={`chip${id === chainId ? ' is-active' : ''}`}
              onClick={() => setChainId(id)}
            >
              {chainName(id)}
            </button>
          ))}
        </div>

        <input
          className="modal__search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a symbol, or paste a token address"
          autoFocus
        />

        {looking ? <p className="modal__hint">Looking up that address on {chainName(chainId)}…</p> : null}
        {isAddressQuery && !looking && !resolved && filtered.length === 0 ? (
          <p className="modal__hint modal__hint--warn">
            No token found at that address on {chainName(chainId)}. Check the chain before sending anything to it.
          </p>
        ) : null}

        <ul className="modal__tokens">
          {results.map((token) => {
            const balance = balanceFor.get(`${chainId}:${token.address.toLowerCase()}`)
            return (
              <li key={`${token.chainId}-${token.address}`}>
                <button type="button" className="token-row" onClick={() => onSelect(chainId, token)}>
                  <span className="token-row__symbol">{token.symbol}</span>
                  <span className="token-row__name">{token.name}</span>
                  {balance ? (
                    <span className="token-row__balance">
                      {formatToken(balance.decimal)}
                      <span className="muted"> · {formatUsd(balance.usd)}</span>
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>

        {results.length === 0 && !looking ? (
          <p className="modal__hint">
            Nothing matches on {chainName(chainId)}. Only the most liquid tokens are listed — paste a contract address to
            reach anything else.
          </p>
        ) : null}
      </div>
    </div>
  )
}
