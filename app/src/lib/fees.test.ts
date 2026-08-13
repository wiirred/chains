import { describe, expect, it } from 'vitest'
import { buildLedger, ledgerBalance } from './fees'
import type { Step, Token } from './router'

const USDC: Token = {
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  symbol: 'USDC',
  decimals: 6,
  chainId: 1,
  name: 'USD Coin',
  priceUSD: '1',
}

const WETH: Token = {
  address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  symbol: 'WETH',
  decimals: 18,
  chainId: 1,
  name: 'Wrapped Ether',
  priceUSD: '3000',
}

const ETH: Token = { ...WETH, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH' }

/** 1000 USDC -> 0.33 WETH, with a 3 USDC pool fee and 0.002 ETH of gas. */
function sameChainQuote(overrides: Partial<Step> = {}): Step {
  return {
    id: 'quote-1',
    type: 'lifi',
    tool: 'uniswap',
    toolDetails: { key: 'uniswap', name: 'Uniswap V3' },
    action: {
      fromChainId: 1,
      toChainId: 1,
      fromToken: USDC,
      toToken: WETH,
      fromAmount: '1000000000',
      slippage: 0.005,
    },
    estimate: {
      tool: 'uniswap',
      fromAmount: '1000000000',
      toAmount: '330000000000000000',
      toAmountMin: '328350000000000000',
      approvalAddress: '0x1111111111111111111111111111111111111111',
      executionDuration: 30,
      feeCosts: [
        {
          name: 'Liquidity provider fee',
          description: 'Paid to the pool',
          token: USDC,
          amount: '3000000',
          percentage: '0.003',
          included: true,
        },
      ],
      gasCosts: [{ type: 'SEND', amount: '2000000000000000', token: ETH }],
    },
    ...overrides,
  }
}

describe('buildLedger', () => {
  it('assigns every dollar of the trade to a named line', () => {
    const ledger = buildLedger(sameChainQuote())

    expect(ledger.priced).toBe(true)
    expect(ledger.send.usd).toBeCloseTo(1000, 6)
    expect(ledger.receive.usd).toBeCloseTo(990, 6)

    // $6 gas + $3 pool fee + $7 unexplained
    expect(ledger.gasUsd).toBeCloseTo(6, 6)
    expect(ledger.explicitFeesUsd).toBeCloseTo(3, 6)
    expect(ledger.spreadUsd).toBeCloseTo(7, 6)
    expect(ledger.totalCostUsd).toBeCloseTo(16, 6)
    expect(ledger.totalCostPct).toBeCloseTo(0.016, 6)

    const { balanced, differenceUsd } = ledgerBalance(ledger)
    expect(balanced, `ledger is off by $${differenceUsd}`).toBe(true)
  })

  it('names the unexplained remainder rather than dropping it', () => {
    const ledger = buildLedger(sameChainQuote())
    const spread = ledger.lines.find((line) => line.kind === 'spread')

    expect(spread).toBeDefined()
    expect(spread!.usd).toBeCloseTo(7, 6)
    expect(spread!.label).toMatch(/spread/i)
  })

  it('prices the worst case off the guaranteed minimum, not the expected output', () => {
    const ledger = buildLedger(sameChainQuote())

    // 0.32835 WETH = $985.05 guaranteed; $1000 sent + $6 gas.
    expect(ledger.guaranteed.usd).toBeCloseTo(985.05, 6)
    expect(ledger.worstCaseCostUsd).toBeCloseTo(20.95, 6)
    expect(ledger.worstCaseCostUsd!).toBeGreaterThan(ledger.totalCostUsd!)
  })

  it('reports the quoted rate against mid-market', () => {
    const ledger = buildLedger(sameChainQuote())

    expect(ledger.midRate).toBeCloseTo(1 / 3000, 12)
    expect(ledger.effectiveRate).toBeCloseTo(0.00033, 12)
    expect(ledger.rateGapPct).toBeCloseTo(0.01, 6)
  })

  it('counts on-top fees as an extra debit, not as a deduction from output', () => {
    const quote = sameChainQuote()
    quote.estimate.feeCosts!.push({
      name: 'Bridge relayer fee',
      description: 'Destination gas',
      token: ETH,
      amount: '1000000000000000', // 0.001 ETH = $3
      included: false,
    })

    const ledger = buildLedger(quote)

    // The extra $3 does not change what arrives, so the spread is unmoved...
    expect(ledger.spreadUsd).toBeCloseTo(7, 6)
    // ...but it does raise the total: $6 gas + $3 pool + $3 relayer + $7 spread.
    expect(ledger.totalCostUsd).toBeCloseTo(19, 6)

    const relayer = ledger.lines.find((line) => line.label === 'Bridge relayer fee')
    expect(relayer!.charge).toBe('paid-on-top')
    expect(relayer!.kind).toBe('bridge')
    expect(ledgerBalance(ledger).balanced).toBe(true)
  })

  it('separates our own cut from third-party fees', () => {
    const quote = sameChainQuote()
    quote.estimate.feeCosts!.push({
      name: 'Integrator fee',
      token: USDC,
      amount: '2500000', // $2.50
      percentage: '0.0025',
      included: true,
    })

    const ledger = buildLedger(quote)
    const platform = ledger.lines.find((line) => line.kind === 'platform')

    expect(platform).toBeDefined()
    expect(ledger.platformUsd).toBeCloseTo(2.5, 6)
    expect(platform!.recipient).toBe('This platform')
    // Ours comes out of the same $10 gap, so the unexplained part shrinks.
    expect(ledger.spreadUsd).toBeCloseTo(4.5, 6)
    expect(ledger.totalCostUsd).toBeCloseTo(16, 6)
    expect(ledgerBalance(ledger).balanced).toBe(true)
  })

  it('refuses to invent a cost when a token has no price', () => {
    const quote = sameChainQuote()
    quote.action.toToken = { ...WETH, symbol: 'MYSTERY', priceUSD: '' }

    const ledger = buildLedger(quote)

    expect(ledger.priced).toBe(false)
    expect(ledger.totalCostUsd).toBeNull()
    expect(ledger.spreadUsd).toBe(0)
    expect(ledger.warnings.join(' ')).toMatch(/cannot be verified/i)
    // The fees we do know about are still reported.
    expect(ledger.gasUsd).toBeCloseTo(6, 6)
  })

  it('flags a spread too large to be ordinary', () => {
    const quote = sameChainQuote()
    quote.estimate.toAmount = '250000000000000000' // 0.25 WETH = $750 out of $1000

    const ledger = buildLedger(quote)

    expect(ledger.warnings.join(' ')).toMatch(/unexplained part/i)
    expect(ledgerBalance(ledger).balanced).toBe(true)
  })

  it('describes a price better than mid-market without pretending it is a gift', () => {
    const quote = sameChainQuote()
    quote.estimate.toAmount = '335000000000000000' // $1005 out of $1000
    quote.estimate.feeCosts = []

    const ledger = buildLedger(quote)

    expect(ledger.spreadUsd).toBeCloseTo(-5, 6)
    expect(ledger.lines.find((line) => line.kind === 'spread')!.label).toBe('Price improvement')
    expect(ledger.lines.find((line) => line.kind === 'spread')!.detail).toMatch(/stale/i)
  })

  it('flags the second transaction when an approval is required', () => {
    const quote = sameChainQuote()
    quote.estimate.gasCosts!.unshift({ type: 'APPROVE', amount: '500000000000000', token: ETH })

    const ledger = buildLedger(quote)

    expect(ledger.gasUsd).toBeCloseTo(7.5, 6)
    expect(ledger.warnings.join(' ')).toMatch(/two transactions/i)
    expect(ledger.lines.find((line) => line.key.includes('APPROVE'))!.label).toMatch(/approval/i)
  })
})

describe('cross-chain routes', () => {
  /** 1000 USDC on Arbitrum -> WETH on Base, via a bridge then a swap. */
  function bridgeQuote(): Step {
    const usdcArb = { ...USDC, chainId: 42161 }
    const usdcBase = { ...USDC, chainId: 8453 }
    const wethBase = { ...WETH, chainId: 8453 }

    return {
      id: 'quote-x',
      type: 'lifi',
      tool: 'across',
      toolDetails: { key: 'across', name: 'Across' },
      action: {
        fromChainId: 42161,
        toChainId: 8453,
        fromToken: usdcArb,
        toToken: wethBase,
        fromAmount: '1000000000',
        slippage: 0.005,
      },
      estimate: {
        tool: 'across',
        fromAmount: '1000000000',
        toAmount: '328000000000000000', // 0.328 WETH = $984
        toAmountMin: '326360000000000000',
        approvalAddress: '0x2222222222222222222222222222222222222222',
        executionDuration: 180,
        feeCosts: [
          { name: 'Across bridge fee', token: usdcArb, amount: '1200000', percentage: '0.0012', included: true },
          { name: 'Liquidity provider fee', token: usdcBase, amount: '2900000', percentage: '0.003', included: true },
        ],
        gasCosts: [{ type: 'SEND', amount: '400000000000000', token: { ...ETH, chainId: 42161 } }],
      },
      includedSteps: [
        {
          id: 'x-1',
          type: 'cross',
          tool: 'across',
          toolDetails: { key: 'across', name: 'Across' },
          action: { fromChainId: 42161, toChainId: 8453, fromToken: usdcArb, toToken: usdcBase, fromAmount: '1000000000', slippage: 0.005 },
          estimate: {
            tool: 'across',
            fromAmount: '1000000000',
            toAmount: '998800000',
            toAmountMin: '998800000',
            approvalAddress: '0x2222222222222222222222222222222222222222',
            executionDuration: 120,
            feeCosts: [{ name: 'Across bridge fee', token: usdcArb, amount: '1200000', included: true }],
            gasCosts: [{ type: 'SEND', amount: '400000000000000', token: { ...ETH, chainId: 42161 } }],
          },
        },
        {
          id: 'x-2',
          type: 'swap',
          tool: 'aerodrome',
          toolDetails: { key: 'aerodrome', name: 'Aerodrome' },
          action: { fromChainId: 8453, toChainId: 8453, fromToken: usdcBase, toToken: wethBase, fromAmount: '998800000', slippage: 0.005 },
          estimate: {
            tool: 'aerodrome',
            fromAmount: '998800000',
            toAmount: '328000000000000000',
            toAmountMin: '326360000000000000',
            approvalAddress: '0x3333333333333333333333333333333333333333',
            executionDuration: 60,
            feeCosts: [{ name: 'Liquidity provider fee', token: usdcBase, amount: '2900000', included: true }],
            gasCosts: [],
          },
        },
      ],
    }
  }

  it('prices a bridge and a swap as one trade', () => {
    const ledger = buildLedger(bridgeQuote())

    expect(ledger.send.usd).toBeCloseTo(1000, 6)
    expect(ledger.receive.usd).toBeCloseTo(984, 6)
    expect(ledger.gasUsd).toBeCloseTo(1.2, 6)
    expect(ledger.explicitFeesUsd).toBeCloseTo(4.1, 6)
    expect(ledger.spreadUsd).toBeCloseTo(11.9, 6)
    expect(ledger.totalCostUsd).toBeCloseTo(17.2, 6)
    expect(ledgerBalance(ledger).balanced).toBe(true)
  })

  it('breaks the route into hops so the bridge is visible', () => {
    const ledger = buildLedger(bridgeQuote())

    expect(ledger.hops).toHaveLength(2)
    expect(ledger.hops[0]).toMatchObject({ type: 'bridge', tool: 'Across', fromChainId: 42161, toChainId: 8453 })
    expect(ledger.hops[1]).toMatchObject({ type: 'swap', tool: 'Aerodrome', fromChainId: 8453, toChainId: 8453 })
  })

  it('does not double-count fees that appear on both the route and its hops', () => {
    const ledger = buildLedger(bridgeQuote())
    const bridgeFees = ledger.lines.filter((line) => line.label === 'Across bridge fee')

    expect(bridgeFees).toHaveLength(1)
  })

  it('falls back to per-hop costs when the route summary omits them', () => {
    const quote = bridgeQuote()
    quote.estimate.feeCosts = []
    quote.estimate.gasCosts = []

    const ledger = buildLedger(quote)

    expect(ledger.explicitFeesUsd).toBeCloseTo(4.1, 6)
    expect(ledger.gasUsd).toBeCloseTo(1.2, 6)
    expect(ledgerBalance(ledger).balanced).toBe(true)
  })
})
