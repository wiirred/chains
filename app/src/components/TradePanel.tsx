/**
 * The trade form.
 *
 * One panel handles both cases. If the two sides name different chains, the
 * route simply contains a bridge — there is no separate "bridge mode" to find,
 * because making bridging a separate destination is what makes it feel hard.
 */
import { parseUnits } from 'viem'
import type { Token } from '../lib/router'
import type { TokenBalance } from '../lib/balances'
import { chainName } from '../lib/registry'
import { formatToken, formatUsd } from '../lib/format'
import { DEFAULT_SLIPPAGE, HIGH_SLIPPAGE_WARNING } from '../config'

export type Side = {
  chainId: number
  token: Token | null
}

export type TradePanelProps = {
  from: Side
  to: Side
  amount: string
  slippage: number
  balance: TokenBalance | null
  /** Quoted output, once a route has been priced. */
  receive: { decimal: string; symbol: string; usd: number | null } | null
  onAmountChange: (amount: string) => void
  onSlippageChange: (slippage: number) => void
  onPick: (side: 'from' | 'to') => void
  onFlip: () => void
}

export function amountToRaw(amount: string, token: Token | null): string | null {
  if (!token) return null
  const trimmed = amount.trim()
  if (!trimmed || Number(trimmed) <= 0) return null
  try {
    return parseUnits(trimmed, token.decimals).toString()
  } catch {
    return null
  }
}

function SideField({
  label,
  side,
  token,
  onPick,
  children,
}: {
  label: string
  side: Side
  token: Token | null
  onPick: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="side">
      <div className="side__label">{label}</div>
      <button type="button" className="side__asset" onClick={onPick}>
        <span className="side__symbol">{token ? token.symbol : 'Select token'}</span>
        <span className="side__chain">on {chainName(side.chainId)}</span>
      </button>
      {children}
    </div>
  )
}

export function TradePanel({
  from,
  to,
  amount,
  slippage,
  balance,
  receive,
  onAmountChange,
  onSlippageChange,
  onPick,
  onFlip,
}: TradePanelProps) {
  const crossChain = from.chainId !== to.chainId
  const balanceUsd = balance?.usd ?? 0

  return (
    <section className="trade" aria-label="Trade">
      <SideField label="You pay" side={from} token={from.token} onPick={() => onPick('from')}>
        <div className="side__amount">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              const next = event.target.value
              // Digits and one decimal point only; a stray character silently
              // becoming a different number is not acceptable here.
              if (next === '' || /^\d*\.?\d*$/.test(next)) onAmountChange(next)
            }}
            placeholder="0.0"
            aria-label="Amount to pay"
          />
          {balance ? (
            <button
              type="button"
              className="side__max"
              onClick={() => onAmountChange(balance.decimal)}
              title={`Balance: ${formatToken(balance.decimal, balance.token.symbol)}`}
            >
              Max
            </button>
          ) : null}
        </div>

        {balance ? (
          <p className="side__balance">
            Balance {formatToken(balance.decimal, balance.token.symbol)}
            <span className="muted"> · {formatUsd(balanceUsd)}</span>
          </p>
        ) : from.token ? (
          <p className="side__balance muted">No balance on {chainName(from.chainId)}</p>
        ) : null}
      </SideField>

      <button type="button" className="trade__flip" onClick={onFlip} aria-label="Swap the two sides">
        ↓
      </button>

      <SideField label="You receive" side={to} token={to.token} onPick={() => onPick('to')}>
        {receive ? (
          <div className="side__amount side__amount--readonly">
            <span className="side__output">{formatToken(receive.decimal)}</span>
            <span className="muted">{formatUsd(receive.usd)}</span>
          </div>
        ) : null}
      </SideField>

      {crossChain ? (
        <p className="trade__crosschain">
          This trade crosses chains: {chainName(from.chainId)} → {chainName(to.chainId)}. The bridge is included in the
          route and priced in the breakdown.
        </p>
      ) : null}

      <div className="trade__slippage">
        <label htmlFor="slippage">Max slippage</label>
        <div className="trade__slippage-controls">
          {[0.001, 0.005, 0.01].map((value) => (
            <button
              key={value}
              type="button"
              className={`chip chip--small${Math.abs(slippage - value) < 1e-9 ? ' is-active' : ''}`}
              onClick={() => onSlippageChange(value)}
            >
              {(value * 100).toFixed(value < 0.01 ? 1 : 0)}%
            </button>
          ))}
          <input
            id="slippage"
            className="trade__slippage-input"
            inputMode="decimal"
            value={(slippage * 100).toString()}
            onChange={(event) => {
              const parsed = Number(event.target.value)
              if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 50) onSlippageChange(parsed / 100)
            }}
            aria-label="Custom slippage percent"
          />
          <span className="muted">%</span>
        </div>
      </div>

      {slippage > HIGH_SLIPPAGE_WARNING ? (
        <p className="trade__warning">
          At {(slippage * 100).toFixed(1)}% slippage you are authorising the trade to fill at a materially worse price
          than quoted. The worst case in the breakdown is what you are agreeing to, not the headline number.
        </p>
      ) : null}

      {slippage < DEFAULT_SLIPPAGE / 5 ? (
        <p className="trade__warning trade__warning--soft">
          Very tight slippage often means the trade simply reverts, and a reverted trade still costs gas.
        </p>
      ) : null}
    </section>
  )
}
