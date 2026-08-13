/**
 * The fee ledger.
 *
 * A router hands back a quote: send this much, receive that much, plus some
 * loosely-labelled cost arrays. That is not the same as knowing what a trade
 * costs, because the largest cost in a swap is usually the one nobody itemises —
 * the gap between the price you got and the price the asset is actually worth.
 *
 * This module turns a quote into a ledger that *balances*: every dollar of
 * difference between what leaves the wallet and what arrives in it is assigned to
 * a named line. Anything the router did not explain becomes an explicit
 * "liquidity spread and price impact" line rather than disappearing. If the
 * numbers cannot be verified, the ledger says so instead of guessing.
 */
import { formatUnits } from 'viem'
import type { FeeCost, GasCost, Step, Token } from './router'
import { IMPLAUSIBLE_SPREAD_PCT, PLATFORM_FEE_BPS } from '../config'

/** How a cost reaches the user's pocket. */
export type Charge =
  /** Already subtracted from the quoted output — you never see the money. */
  | 'deducted-from-output'
  /** An extra debit on top of the amount being traded. */
  | 'paid-on-top'
  /** Paid to validators in the chain's native token, separately from the trade. */
  | 'paid-in-gas'

export type LineKind = 'gas' | 'protocol' | 'bridge' | 'platform' | 'spread'

export type LedgerLine = {
  key: string
  label: string
  /** Plain-language explanation of who is being paid and why. */
  detail: string
  kind: LineKind
  charge: Charge
  usd: number | null
  /** Cost in its own token, when it is denominated in one. */
  token?: { amount: string; symbol: string; decimals: number }
  /** Fraction of the input amount, when the router expressed the fee as a rate. */
  rate?: number
  /** True when this is a forecast that the final receipt can contradict. */
  estimated: boolean
  /** Who ends up with the money. */
  recipient: string
}

export type Amount = {
  /** Smallest unit. */
  raw: string
  /** Human-readable decimal string. */
  decimal: string
  symbol: string
  decimals: number
  usd: number | null
}

export type FeeLedger = {
  send: Amount
  /** Expected output at current prices. */
  receive: Amount
  /** The contractual floor: the least you can receive before the trade reverts. */
  guaranteed: Amount

  lines: LedgerLine[]

  gasUsd: number
  /** Named fees charged by bridges, protocols and us. Excludes gas and spread. */
  explicitFeesUsd: number
  /** The unlabelled remainder: LP fees, price impact, router margin. */
  spreadUsd: number
  /** Our cut, as actually charged by the router — not as configured. */
  platformUsd: number

  /** Everything the trade costs, expected case. */
  totalCostUsd: number | null
  /** Everything the trade costs if slippage lands at the worst permitted price. */
  worstCaseCostUsd: number | null
  /** totalCostUsd as a fraction of the value sent. */
  totalCostPct: number | null

  /** Output tokens per input token, as quoted. */
  effectiveRate: number | null
  /** Output tokens per input token, at mid-market prices. */
  midRate: number | null
  /** How far the quoted rate sits below mid-market, as a fraction. */
  rateGapPct: number | null

  /** False when a token has no price, making USD verification impossible. */
  priced: boolean
  warnings: string[]

  /** Per-hop summary for the route diagram. */
  hops: Hop[]
}

export type Hop = {
  type: 'swap' | 'bridge' | 'other'
  tool: string
  fromChainId: number
  toChainId: number
  fromSymbol: string
  toSymbol: string
  costUsd: number | null
  seconds: number
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function num(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Decimal string for an amount in smallest units. */
function decimalOf(raw: string, decimals: number): string {
  try {
    return formatUnits(BigInt(raw), decimals)
  } catch {
    return '0'
  }
}

/**
 * USD value of a token amount.
 *
 * Always price × amount, never the router's pre-computed `amountUSD`. Mixing the
 * two makes the ledger stop balancing, and a ledger that does not balance is
 * worse than no ledger at all — it hides the discrepancy inside the residual.
 */
function usdOf(raw: string, token: Pick<Token, 'decimals' | 'priceUSD'>): number | null {
  const price = num(token.priceUSD)
  if (price === null) return null
  const amount = Number(decimalOf(raw, token.decimals))
  if (!Number.isFinite(amount)) return null
  return amount * price
}

function amountOf(raw: string, token: Token): Amount {
  return {
    raw,
    decimal: decimalOf(raw, token.decimals),
    symbol: token.symbol,
    decimals: token.decimals,
    usd: usdOf(raw, token),
  }
}

/**
 * Does this fee line look like our own cut?
 *
 * Routers do not tag the integrator fee with a stable machine-readable flag, so
 * this is a heuristic on the human label. It only ever affects presentation: the
 * money is counted in the total either way, this decides whether it gets shown as
 * "our fee" or as a third party's.
 */
function isPlatformFee(fee: FeeCost): boolean {
  return /integrator|lifi\s*fee|platform\s*fee|partner\s*fee/i.test(`${fee.name} ${fee.description ?? ''}`)
}

function classifyFee(fee: FeeCost): { kind: LineKind; recipient: string } {
  if (isPlatformFee(fee)) return { kind: 'platform', recipient: 'This platform' }
  if (/bridge|relay|destination|cross.?chain|messag/i.test(`${fee.name} ${fee.description ?? ''}`)) {
    return { kind: 'bridge', recipient: 'Bridge operator' }
  }
  return { kind: 'protocol', recipient: 'Liquidity protocol' }
}

function gasLine(gas: GasCost, index: number): LedgerLine {
  const isApproval = gas.type === 'APPROVE'
  return {
    key: `gas-${gas.type}-${index}`,
    label: isApproval ? 'Network fee — token approval' : 'Network fee — transaction',
    detail: isApproval
      ? `A separate transaction granting the router permission to move your tokens. Paid to ${gas.token.symbol} validators, not to us.`
      : `Paid to ${gas.token.symbol} validators for including your transaction. Not paid to us, and not refundable if the trade fails.`,
    kind: 'gas',
    charge: 'paid-in-gas',
    usd: usdOf(gas.amount, gas.token),
    token: { amount: decimalOf(gas.amount, gas.token.decimals), symbol: gas.token.symbol, decimals: gas.token.decimals },
    estimated: true,
    recipient: `${gas.token.symbol} validators`,
  }
}

function feeLine(fee: FeeCost, index: number): LedgerLine {
  const { kind, recipient } = classifyFee(fee)
  const rate = num(fee.percentage)
  return {
    key: `fee-${index}-${fee.name}`,
    label: fee.name || 'Fee',
    detail:
      fee.description ||
      (fee.included
        ? 'Taken out of the amount you receive.'
        : 'Charged on top of the amount you are trading.'),
    kind,
    charge: fee.included ? 'deducted-from-output' : 'paid-on-top',
    usd: usdOf(fee.amount, fee.token),
    token: { amount: decimalOf(fee.amount, fee.token.decimals), symbol: fee.token.symbol, decimals: fee.token.decimals },
    rate: rate ?? undefined,
    estimated: true,
    recipient,
  }
}

function hopOf(step: Step): Hop {
  const crossChain = step.action.fromChainId !== step.action.toChainId
  const gas = (step.estimate.gasCosts ?? []).reduce((sum, g) => sum + (usdOf(g.amount, g.token) ?? 0), 0)
  const fees = (step.estimate.feeCosts ?? []).reduce((sum, f) => sum + (usdOf(f.amount, f.token) ?? 0), 0)
  return {
    type: crossChain ? 'bridge' : step.type === 'swap' ? 'swap' : 'other',
    tool: step.toolDetails?.name ?? step.tool,
    fromChainId: step.action.fromChainId,
    toChainId: step.action.toChainId,
    fromSymbol: step.action.fromToken.symbol,
    toSymbol: step.action.toToken.symbol,
    costUsd: gas + fees || null,
    seconds: step.estimate.executionDuration ?? 0,
  }
}

/**
 * Collect fee and gas entries from the whole route.
 *
 * For a cross-chain route the top-level estimate summarises the source
 * transaction, while the real per-hop detail lives in `includedSteps`. Reading
 * only the top level loses the bridge's own charges; reading both would count
 * them twice. The top level is authoritative, and included steps are used only to
 * fill in categories the top level omitted entirely.
 */
function collectCosts(step: Step): { fees: FeeCost[]; gas: GasCost[] } {
  const fees = [...(step.estimate.feeCosts ?? [])]
  const gas = [...(step.estimate.gasCosts ?? [])]

  if (fees.length === 0) {
    for (const inner of step.includedSteps ?? []) {
      fees.push(...(inner.estimate.feeCosts ?? []))
    }
  }
  if (gas.length === 0) {
    for (const inner of step.includedSteps ?? []) {
      gas.push(...(inner.estimate.gasCosts ?? []))
    }
  }

  return { fees, gas }
}

/**
 * Build the ledger for a quoted route.
 */
export function buildLedger(step: Step): FeeLedger {
  const { fromToken, toToken } = step.action
  const warnings: string[] = []

  const send = amountOf(step.estimate.fromAmount || step.action.fromAmount, fromToken)
  const receive = amountOf(step.estimate.toAmount, toToken)
  const guaranteed = amountOf(step.estimate.toAmountMin, toToken)

  const { fees, gas } = collectCosts(step)

  const lines: LedgerLine[] = [
    ...gas.map(gasLine),
    ...fees.map(feeLine),
  ]

  const gasUsd = gas.reduce((sum, g) => sum + (usdOf(g.amount, g.token) ?? 0), 0)
  const includedFeesUsd = fees
    .filter((f) => f.included)
    .reduce((sum, f) => sum + (usdOf(f.amount, f.token) ?? 0), 0)
  const onTopFeesUsd = fees
    .filter((f) => !f.included)
    .reduce((sum, f) => sum + (usdOf(f.amount, f.token) ?? 0), 0)
  const explicitFeesUsd = includedFeesUsd + onTopFeesUsd
  const platformUsd = fees
    .filter(isPlatformFee)
    .reduce((sum, f) => sum + (usdOf(f.amount, f.token) ?? 0), 0)

  const priced = send.usd !== null && receive.usd !== null && send.usd > 0

  let spreadUsd = 0
  let totalCostUsd: number | null = null
  let worstCaseCostUsd: number | null = null
  let totalCostPct: number | null = null

  if (priced) {
    // Every dollar that went in and did not come out, minus the fees already
    // named above. Whatever is left is the price you paid for liquidity.
    spreadUsd = send.usd! - receive.usd! - includedFeesUsd
    totalCostUsd = gasUsd + explicitFeesUsd + spreadUsd
    worstCaseCostUsd = send.usd! + gasUsd + onTopFeesUsd - (guaranteed.usd ?? receive.usd!)
    totalCostPct = totalCostUsd / send.usd!

    lines.push({
      key: 'spread',
      label: spreadUsd >= 0 ? 'Liquidity spread & price impact' : 'Price improvement',
      detail:
        spreadUsd >= 0
          ? 'The gap between the market price of what you send and what you receive, after the named fees above. This is the pool fee plus the price your own trade moves. It is the cost most interfaces never show.'
          : 'This route quoted better than the reference mid-market price. That usually means the price feed is slightly stale rather than that you are being paid to trade.',
      kind: 'spread',
      charge: 'deducted-from-output',
      usd: spreadUsd,
      estimated: true,
      recipient: 'Liquidity providers and the market',
    })

    if (Math.abs(spreadUsd) / send.usd! > IMPLAUSIBLE_SPREAD_PCT) {
      warnings.push(
        `The unexplained part of this trade is ${(Math.abs(spreadUsd / send.usd!) * 100).toFixed(1)}% of what you are sending. ` +
          `Either this route has thin liquidity, or the price data for one of these tokens is unreliable. Trade a smaller size to tell them apart.`,
      )
    }
  } else {
    warnings.push(
      'One of these tokens has no reliable price feed, so the true cost of this trade cannot be verified. ' +
        'Only the fees the router names explicitly are shown below — there may be more inside the price.',
    )
  }

  if (PLATFORM_FEE_BPS > 0 && platformUsd === 0) {
    warnings.push(
      `This deployment is configured to charge ${(PLATFORM_FEE_BPS / 100).toFixed(2)}%, but the router did not report ` +
        `taking a platform fee on this route. You are not being charged one here.`,
    )
  }

  const sendDecimal = Number(send.decimal)
  const receiveDecimal = Number(receive.decimal)
  const fromPrice = num(fromToken.priceUSD)
  const toPrice = num(toToken.priceUSD)

  const effectiveRate = sendDecimal > 0 ? receiveDecimal / sendDecimal : null
  const midRate = fromPrice !== null && toPrice !== null && toPrice > 0 ? fromPrice / toPrice : null
  const rateGapPct = effectiveRate !== null && midRate !== null && midRate > 0 ? (midRate - effectiveRate) / midRate : null

  const hops = (step.includedSteps?.length ? step.includedSteps : [step]).map(hopOf)

  const approvalNeeded = fromToken.address !== ZERO_ADDRESS && gas.some((g) => g.type === 'APPROVE')
  if (approvalNeeded) {
    warnings.push('This trade needs two transactions: an approval, then the trade itself. Both cost gas.')
  }

  return {
    send,
    receive,
    guaranteed,
    lines,
    gasUsd,
    explicitFeesUsd,
    spreadUsd,
    platformUsd,
    totalCostUsd,
    worstCaseCostUsd,
    totalCostPct,
    effectiveRate,
    midRate,
    rateGapPct,
    priced,
    warnings,
    hops,
  }
}

/**
 * Verify that the ledger accounts for every dollar.
 *
 * Exported so the UI can display the check rather than merely assert it, and so
 * the tests can catch a future edit that quietly stops the sum from adding up.
 */
export function ledgerBalance(ledger: FeeLedger): { balanced: boolean; differenceUsd: number } {
  if (!ledger.priced || ledger.totalCostUsd === null) return { balanced: true, differenceUsd: 0 }
  const sum = ledger.lines.reduce((total, line) => total + (line.usd ?? 0), 0)
  const difference = sum - ledger.totalCostUsd
  return { balanced: Math.abs(difference) < 1e-6, differenceUsd: difference }
}
