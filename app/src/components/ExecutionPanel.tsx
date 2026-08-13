/**
 * Execution progress and the settled receipt.
 *
 * The receipt is the part that keeps the rest of this app honest: it puts what
 * was estimated next to what was actually paid. An interface that only ever shows
 * forecasts can be wrong forever without anyone noticing.
 */
import { formatDuration, formatToken, formatUsd } from '../lib/format'
import { chainName, explorerTxUrl } from '../lib/registry'
import type { ExecutionStage, TradeReceipt } from '../lib/execute'
import { formatUnits } from 'viem'

function ExplorerLink({ chainId, hash, label }: { chainId: number; hash: string; label: string }) {
  const url = explorerTxUrl(chainId, hash)
  if (!url) return <span className="muted">{label}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer noopener">
      {label} ↗
    </a>
  )
}

const STAGE_TEXT: Record<string, string> = {
  'switching-chain': 'Switching your wallet to the right network…',
  approving: 'Approve the router to move this token. This is the first of two transactions.',
  'approval-pending': 'Waiting for the approval to confirm…',
  signing: 'Confirm the trade in your wallet.',
  submitted: 'Submitted. Waiting for confirmation…',
  bridging: 'Bridging. Your funds have left the source chain and are in transit.',
}

export function ExecutionProgress({ stage, chainId }: { stage: ExecutionStage; chainId: number }) {
  if (stage.phase === 'idle' || stage.phase === 'done') return null

  if (stage.phase === 'failed') {
    return (
      <div className="execution execution--failed" role="alert">
        <h3>The trade did not go through</h3>
        <p>{stage.message}</p>
        {stage.hash ? <ExplorerLink chainId={chainId} hash={stage.hash} label="View transaction" /> : null}
      </div>
    )
  }

  const message =
    stage.phase === 'bridging' ? stage.message || STAGE_TEXT.bridging : STAGE_TEXT[stage.phase] ?? 'Working…'

  return (
    <div className="execution" role="status">
      <div className="execution__spinner" aria-hidden />
      <p>{message}</p>
      {'hash' in stage && stage.hash ? (
        <p className="execution__hash">
          <code>{stage.hash.slice(0, 18)}…</code>
        </p>
      ) : null}
    </div>
  )
}

/**
 * Estimated versus actual, side by side.
 */
export function ReceiptCard({ receipt, estimatedOutUsd }: { receipt: TradeReceipt; estimatedOutUsd: number | null }) {
  const gasDelta =
    receipt.gasPaidUsd !== null && receipt.gasEstimatedUsd !== null
      ? receipt.gasPaidUsd - receipt.gasEstimatedUsd
      : null

  const expectedOut = formatUnits(BigInt(receipt.expectedOut || '0'), receipt.outDecimals)
  const actualOut = receipt.actualOut ? formatUnits(BigInt(receipt.actualOut), receipt.outDecimals) : null

  return (
    <section className="receipt" aria-label="Trade receipt">
      <header className="receipt__header">
        <h2>Settled</h2>
        <span className="muted">took {formatDuration(receipt.seconds)}</span>
      </header>

      <table className="receipt__table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Estimated</th>
            <th scope="col">Actually paid</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Network fee</th>
            <td>{formatUsd(receipt.gasEstimatedUsd)}</td>
            <td>
              {formatToken(receipt.gasPaid, receipt.gasSymbol)}
              <span className="muted"> · {formatUsd(receipt.gasPaidUsd)}</span>
            </td>
          </tr>
          {receipt.approvalGasPaid ? (
            <tr>
              <th scope="row">Approval fee</th>
              <td className="muted">included above</td>
              <td>
                {formatToken(receipt.approvalGasPaid, receipt.gasSymbol)}
                <span className="muted"> · {formatUsd(receipt.approvalGasPaidUsd ?? null)}</span>
              </td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">Received</th>
            <td>
              {formatToken(expectedOut, receipt.outSymbol)}
              <span className="muted"> · {formatUsd(estimatedOutUsd)}</span>
            </td>
            <td>
              {actualOut ? formatToken(actualOut, receipt.outSymbol) : 'confirming…'}
              {receipt.actualOutUsd ? <span className="muted"> · {formatUsd(receipt.actualOutUsd)}</span> : null}
            </td>
          </tr>
        </tbody>
      </table>

      {gasDelta !== null ? (
        <p className="receipt__delta">
          {Math.abs(gasDelta) < 0.01
            ? 'The gas estimate was accurate.'
            : gasDelta > 0
              ? `Gas came in ${formatUsd(gasDelta)} above the estimate. Estimates are made before the block is built, so they move with network conditions.`
              : `Gas came in ${formatUsd(Math.abs(gasDelta))} below the estimate — you paid less than quoted.`}
        </p>
      ) : null}

      <div className="receipt__links">
        <ExplorerLink
          chainId={receipt.sourceChainId}
          hash={receipt.sourceHash}
          label={`Source transaction on ${chainName(receipt.sourceChainId)}`}
        />
        {receipt.destinationHash ? (
          <ExplorerLink
            chainId={receipt.destinationChainId}
            hash={receipt.destinationHash}
            label={`Destination transaction on ${chainName(receipt.destinationChainId)}`}
          />
        ) : null}
      </div>
    </section>
  )
}
