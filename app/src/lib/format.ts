/**
 * Number formatting.
 *
 * Rounding is where transparency quietly dies: "$0.00" for a real cost and "0%"
 * for a real rate are both lies of precision. These helpers round toward showing
 * the user something true rather than something tidy.
 */

export function formatUsd(value: number | null | undefined, options: { sign?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'

  const sign = value < 0 ? '-' : options.sign && value > 0 ? '+' : ''
  const magnitude = Math.abs(value)

  if (magnitude === 0) return '$0.00'
  // Never round a real cost down to nothing.
  if (magnitude < 0.01) return `${sign}<$0.01`
  if (magnitude < 1000) return `${sign}$${magnitude.toFixed(2)}`

  return `${sign}$${magnitude.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

export function formatPct(fraction: number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—'

  const pct = fraction * 100
  if (pct === 0) return '0%'
  if (Math.abs(pct) < 0.01) return pct > 0 ? '<0.01%' : '>-0.01%'

  return `${pct.toFixed(digits)}%`
}

/**
 * Token amounts, with enough significant figures that small balances stay
 * distinguishable from zero.
 */
export function formatToken(decimal: string | number, symbol?: string): string {
  const value = typeof decimal === 'number' ? decimal : Number(decimal)
  if (!Number.isFinite(value)) return symbol ? `— ${symbol}` : '—'

  let text: string
  if (value === 0) text = '0'
  else if (Math.abs(value) < 0.000001) text = value.toExponential(2)
  else if (Math.abs(value) < 1) text = value.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '')
  else if (Math.abs(value) < 1000) text = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  else text = value.toLocaleString('en-US', { maximumFractionDigits: 2 })

  return symbol ? `${text} ${symbol}` : text
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60)
    return `${minutes} min`
  }
  return `${(seconds / 3600).toFixed(1)} h`
}

export function shortAddress(address: string): string {
  if (!address || address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
