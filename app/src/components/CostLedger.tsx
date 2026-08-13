/**
 * The cost ledger.
 *
 * This is the product. It is not behind a disclosure triangle, it is not
 * summarised as "network fee ~$3", and it does not stop at the fees that happen
 * to be convenient to name. Every line the trade costs is listed, attributed to
 * whoever receives it, and the lines add up to the total — with the arithmetic
 * shown so the user can check it rather than trust it.
 */
import { ledgerBalance, type FeeLedger, type LedgerLine } from '../lib/fees'
import { formatPct, formatToken, formatUsd } from '../lib/format'
import { PLATFORM_FEE_BPS } from '../config'

const CHARGE_LABEL: Record<LedgerLine['charge'], string> = {
  'deducted-from-output': 'taken out of what you receive',
  'paid-on-top': 'charged on top of your trade',
  'paid-in-gas': 'paid separately in gas',
}

const KIND_LABEL: Record<LedgerLine['kind'], string> = {
  gas: 'Network',
  protocol: 'Protocol',
  bridge: 'Bridge',
  platform: 'Us',
  spread: 'Market',
}

function LedgerRow({ line, shareOfTotal }: { line: LedgerLine; shareOfTotal: number | null }) {
  return (
    <li className={`ledger-row ledger-row--${line.kind}`}>
      <div className="ledger-row__head">
        <span className={`tag tag--${line.kind}`}>{KIND_LABEL[line.kind]}</span>
        <span className="ledger-row__label">{line.label}</span>
        <span className="ledger-row__usd">{formatUsd(line.usd)}</span>
      </div>

      <div className="ledger-row__meta">
        {line.token ? <span>{formatToken(line.token.amount, line.token.symbol)}</span> : null}
        {line.rate !== undefined ? <span>{formatPct(line.rate)} of trade</span> : null}
        <span>{CHARGE_LABEL[line.charge]}</span>
        <span className="ledger-row__recipient">goes to {line.recipient}</span>
        {shareOfTotal !== null && shareOfTotal > 0 ? (
          <span className="ledger-row__share">{formatPct(shareOfTotal, 0)} of total cost</span>
        ) : null}
      </div>

      <p className="ledger-row__detail">{line.detail}</p>
    </li>
  )
}

export function CostLedger({ ledger, stale }: { ledger: FeeLedger; stale?: boolean }) {
  const { balanced, differenceUsd } = ledgerBalance(ledger)
  const total = ledger.totalCostUsd

  // Order so the largest cost leads, since that is the one people are least
  // likely to have been shown before.
  const lines = [...ledger.lines].sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0))

  return (
    <section className={`ledger${stale ? ' ledger--stale' : ''}`} aria-label="Cost breakdown">
      <header className="ledger__header">
        <h2>What this trade costs you</h2>
        <p className="ledger__lede">
          Every cost, including the ones that are usually hidden inside the price. The lines below add up to the total
          exactly.
        </p>
      </header>

      <div className="ledger__headline">
        <div className="headline-figure">
          <span className="headline-figure__label">Total cost</span>
          <span className="headline-figure__value">{formatUsd(total)}</span>
          <span className="headline-figure__sub">
            {ledger.totalCostPct !== null ? `${formatPct(ledger.totalCostPct)} of what you send` : 'not verifiable'}
          </span>
        </div>

        <div className="headline-figure headline-figure--muted">
          <span className="headline-figure__label">Worst case</span>
          <span className="headline-figure__value">{formatUsd(ledger.worstCaseCostUsd)}</span>
          <span className="headline-figure__sub">if slippage hits your limit</span>
        </div>
      </div>

      <dl className="ledger__flows">
        <div>
          <dt>You send</dt>
          <dd>
            {formatToken(ledger.send.decimal, ledger.send.symbol)}
            <span className="muted"> · {formatUsd(ledger.send.usd)}</span>
          </dd>
        </div>
        <div>
          <dt>You receive</dt>
          <dd>
            {formatToken(ledger.receive.decimal, ledger.receive.symbol)}
            <span className="muted"> · {formatUsd(ledger.receive.usd)}</span>
          </dd>
        </div>
        <div>
          <dt>Guaranteed minimum</dt>
          <dd>
            {formatToken(ledger.guaranteed.decimal, ledger.guaranteed.symbol)}
            <span className="muted"> · {formatUsd(ledger.guaranteed.usd)}</span>
          </dd>
        </div>
      </dl>

      <ul className="ledger__lines">
        {lines.map((line) => (
          <LedgerRow
            key={line.key}
            line={line}
            shareOfTotal={total && total > 0 && line.usd !== null ? line.usd / total : null}
          />
        ))}
      </ul>

      <div className="ledger__total">
        <span>Sum of every line above</span>
        <strong>{formatUsd(total)}</strong>
      </div>

      {!balanced ? (
        <p className="ledger__mismatch">
          These lines do not add up to the total — they are off by {formatUsd(Math.abs(differenceUsd))}. That is a bug in
          this interface, not a fee. Treat the numbers here as unreliable until it is fixed.
        </p>
      ) : null}

      <div className="ledger__rate">
        <div>
          <span className="muted">Your rate</span>
          <strong>
            1 {ledger.send.symbol} → {formatToken(ledger.effectiveRate ?? 0)} {ledger.receive.symbol}
          </strong>
        </div>
        <div>
          <span className="muted">Mid-market</span>
          <strong>
            1 {ledger.send.symbol} → {formatToken(ledger.midRate ?? 0)} {ledger.receive.symbol}
          </strong>
        </div>
        <div>
          <span className="muted">You are below mid-market by</span>
          <strong>{formatPct(ledger.rateGapPct)}</strong>
        </div>
      </div>

      <p className="ledger__platform">
        {PLATFORM_FEE_BPS === 0 ? (
          <>
            <strong>We take nothing on this trade.</strong> This deployment charges a platform fee of 0%. If that ever
            changes, the amount appears above as its own line, marked <span className="tag tag--platform">Us</span>.
          </>
        ) : (
          <>
            <strong>Our fee on this trade: {formatUsd(ledger.platformUsd)}</strong> — {formatPct(PLATFORM_FEE_BPS / 10_000)} of
            what you send. It is listed above as its own line, not folded into the rate.
          </>
        )}
      </p>

      {ledger.warnings.length > 0 ? (
        <ul className="ledger__warnings">
          {ledger.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
