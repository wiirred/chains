/**
 * The route, hop by hop.
 *
 * When a trade crosses chains it is really several transactions wearing a trench
 * coat: a swap, a bridge, another swap. Showing them makes the time estimate and
 * the bridge fee legible instead of arbitrary.
 */
import type { FeeLedger, Hop } from '../lib/fees'
import { chainName } from '../lib/registry'
import { formatDuration, formatUsd } from '../lib/format'

function HopCard({ hop }: { hop: Hop }) {
  const crossChain = hop.fromChainId !== hop.toChainId

  return (
    <li className={`hop hop--${hop.type}`}>
      <span className="hop__kind">{crossChain ? 'Bridge' : 'Swap'}</span>
      <span className="hop__tool">{hop.tool}</span>
      <span className="hop__path">
        {hop.fromSymbol} → {hop.toSymbol}
      </span>
      <span className="hop__chains">
        {crossChain ? `${chainName(hop.fromChainId)} → ${chainName(hop.toChainId)}` : chainName(hop.fromChainId)}
      </span>
      <span className="hop__meta">
        {formatDuration(hop.seconds)}
        {hop.costUsd !== null ? ` · ${formatUsd(hop.costUsd)} in costs` : ''}
      </span>
    </li>
  )
}

export function RouteDiagram({ ledger }: { ledger: FeeLedger }) {
  const totalSeconds = ledger.hops.reduce((sum, hop) => sum + hop.seconds, 0)
  const crossChain = ledger.hops.some((hop) => hop.fromChainId !== hop.toChainId)

  return (
    <section className="route" aria-label="Route">
      <header className="route__header">
        <h3>{crossChain ? 'Your route across chains' : 'Your route'}</h3>
        <span className="muted">
          {ledger.hops.length} step{ledger.hops.length === 1 ? '' : 's'} · about {formatDuration(totalSeconds)}
        </span>
      </header>

      <ol className="route__hops">
        {ledger.hops.map((hop, index) => (
          <HopCard key={`${hop.tool}-${index}`} hop={hop} />
        ))}
      </ol>

      {crossChain ? (
        <p className="route__note">
          The bridge happens inside this trade. You sign once on {chainName(ledger.hops[0].fromChainId)}; the funds arrive
          already converted on {chainName(ledger.hops[ledger.hops.length - 1].toChainId)}. Until the bridge settles, the
          money is in transit — this interface will keep telling you where it is.
        </p>
      ) : null}
    </section>
  )
}
