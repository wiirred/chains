/**
 * "Your money is on a different chain."
 *
 * The usual failure mode is not that bridging is hard, it is that the interface
 * never mentions it. Someone sits on a trade screen with an empty balance while
 * their funds are two chains away, and nothing on the page connects those facts.
 *
 * This scans every chain, and when the source chain cannot cover the trade it
 * says where the money actually is and offers to bridge it as part of the trade
 * itself.
 */
import type { TokenBalance } from '../lib/balances'
import { byChain, findFunding, totalUsd } from '../lib/balances'
import { chainName } from '../lib/registry'
import { formatToken, formatUsd } from '../lib/format'

export type FundingRadarProps = {
  balances: TokenBalance[]
  scanning: boolean
  pending: number[]
  failed: number[]
  /** The chain the trade currently starts from. */
  fromChainId: number
  /** Whether the currently selected source token covers the requested amount. */
  sufficient: boolean
  /** Roughly what the trade needs, in USD. */
  needUsd: number
  onUseFunds: (balance: TokenBalance) => void
}

export function FundingRadar({
  balances,
  scanning,
  pending,
  failed,
  fromChainId,
  sufficient,
  needUsd,
  onUseFunds,
}: FundingRadarProps) {
  const total = totalUsd(balances)
  const chains = byChain(balances)

  if (scanning && balances.length === 0) {
    return (
      <section className="radar radar--scanning">
        <p>Looking across {pending.length} chains for your funds…</p>
      </section>
    )
  }

  if (balances.length === 0) {
    return (
      <section className="radar">
        <p className="muted">No balances found on any chain we can reach.</p>
        {failed.length > 0 ? (
          <p className="radar__failed">
            {failed.length} chain{failed.length === 1 ? '' : 's'} did not respond, so this may be incomplete.
          </p>
        ) : null}
      </section>
    )
  }

  // Only suggest bridging when the source chain genuinely cannot cover the trade.
  const elsewhere = sufficient
    ? []
    : findFunding(balances, { chainId: fromChainId, usd: needUsd }).filter((option) => !option.local).slice(0, 4)

  return (
    <section className="radar" aria-label="Your funds across chains">
      <header className="radar__header">
        <h3>Your funds</h3>
        <span className="radar__total">
          {formatUsd(total)} across {chains.length} chain{chains.length === 1 ? '' : 's'}
        </span>
      </header>

      <ul className="radar__chains">
        {chains.slice(0, 6).map((group) => (
          <li key={group.chainId} className={group.chainId === fromChainId ? 'is-current' : ''}>
            <span className="radar__chain-name">{chainName(group.chainId)}</span>
            <span className="radar__chain-usd">{formatUsd(group.usd)}</span>
          </li>
        ))}
      </ul>

      {elsewhere.length > 0 ? (
        <div className="radar__bridge">
          <p className="radar__bridge-lede">
            You do not have enough on {chainName(fromChainId)} — but you do elsewhere. Pick one and the bridge becomes
            part of this trade, in a single signature.
          </p>

          <ul className="radar__options">
            {elsewhere.map((option) => (
              <li key={`${option.balance.chainId}-${option.balance.token.address}`}>
                <button type="button" className="radar__option" onClick={() => onUseFunds(option.balance)}>
                  <span className="radar__option-amount">
                    {formatToken(option.balance.decimal, option.balance.token.symbol)}
                  </span>
                  <span className="radar__option-chain">on {chainName(option.balance.chainId)}</span>
                  <span className="radar__option-usd">{formatUsd(option.balance.usd)}</span>
                  <span className={`radar__option-covers${option.covers ? '' : ' is-partial'}`}>
                    {option.covers ? 'covers this trade' : 'partial'}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <p className="radar__bridge-note">
            Bridging is not free. Whatever it costs shows up in the breakdown as its own line before you sign.
          </p>
        </div>
      ) : null}

      {failed.length > 0 ? (
        <p className="radar__failed">
          Could not reach {failed.length} chain{failed.length === 1 ? '' : 's'} ({failed.map(chainName).join(', ')}). Balances
          there are unknown rather than zero.
        </p>
      ) : null}
    </section>
  )
}
