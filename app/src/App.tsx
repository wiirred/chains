import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWallet } from './hooks/useWallet'
import { useTokens } from './hooks/useTokens'
import { useBalances } from './hooks/useBalances'
import { usePersistedState } from './hooks/usePersistedState'
import { useQuote } from './hooks/useQuote'
import { TradePanel, amountToRaw, type Side } from './components/TradePanel'
import { CostLedger } from './components/CostLedger'
import { RouteDiagram } from './components/RouteDiagram'
import { FundingRadar } from './components/FundingRadar'
import { AssetPicker } from './components/AssetPicker'
import { WalletMenu } from './components/WalletMenu'
import { ExecutionProgress, ReceiptCard } from './components/ExecutionPanel'
import { executeRoute, type ApprovalPolicy, type ExecutionStage } from './lib/execute'
import type { TokenBalance } from './lib/balances'
import { NATIVE_ADDRESS } from './lib/balances'
import type { Token } from './lib/router'
import { DEFAULT_SLIPPAGE, PLATFORM_FEE_BPS, QUOTE_REFRESH_MS } from './config'
import { formatToken, formatUsd } from './lib/format'
import { chainName } from './lib/registry'

const DEFAULT_CHAIN = 1

function findToken(tokens: Token[] | undefined, symbol: string): Token | null {
  return tokens?.find((token) => token.symbol.toUpperCase() === symbol.toUpperCase()) ?? null
}

export default function App() {
  const wallet = useWallet()
  const { tradeableChains, tokensByChain, radarTokens, loading: tokensLoading, error: tokensError } = useTokens()
  const { balances, pending, failed, scanning } = useBalances(wallet.account, radarTokens)

  const [from, setFrom] = useState<Side>({ chainId: DEFAULT_CHAIN, token: null })
  const [to, setTo] = useState<Side>({ chainId: DEFAULT_CHAIN, token: null })
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE)
  const [bridging, setBridging] = usePersistedState('clearswap:bridging', true)
  const [picking, setPicking] = useState<'from' | 'to' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>('exact')
  const [stage, setStage] = useState<ExecutionStage>({ phase: 'idle' })

  // Seed a sensible pair once token lists arrive.
  useEffect(() => {
    if (from.token || to.token) return
    const list = tokensByChain[DEFAULT_CHAIN]
    if (!list?.length) return

    const native = list.find((token) => token.address.toLowerCase() === NATIVE_ADDRESS) ?? list[0]
    setFrom({ chainId: DEFAULT_CHAIN, token: native })
    setTo({ chainId: DEFAULT_CHAIN, token: findToken(list, 'USDC') ?? list[1] ?? null })
  }, [tokensByChain, from.token, to.token])

  const fromRaw = amountToRaw(amount, from.token)

  const executing = stage.phase !== 'idle' && stage.phase !== 'done' && stage.phase !== 'failed'

  const quoteRequest = useMemo(() => {
    if (!wallet.account || !from.token || !to.token || !fromRaw) return null
    if (from.chainId === to.chainId && from.token.address.toLowerCase() === to.token.address.toLowerCase()) return null
    // Never request a route the user has forbidden.
    if (!bridging && from.chainId !== to.chainId) return null

    return {
      fromChain: from.chainId,
      toChain: to.chainId,
      fromToken: from.token.address,
      toToken: to.token.address,
      fromAmount: fromRaw,
      fromAddress: wallet.account,
      slippage,
    }
  }, [wallet.account, from, to, fromRaw, slippage, bridging])

  const quote = useQuote(quoteRequest, { paused: executing || confirming })

  const fromBalance = useMemo<TokenBalance | null>(() => {
    if (!from.token) return null
    const address = from.token.address.toLowerCase()
    return (
      balances.find((balance) => balance.chainId === from.chainId && balance.token.address.toLowerCase() === address) ??
      null
    )
  }, [balances, from])

  const sufficient = Boolean(fromBalance && fromRaw && fromBalance.raw >= BigInt(fromRaw))

  const needUsd = useMemo(() => {
    const price = Number(from.token?.priceUSD)
    const size = Number(amount)
    return Number.isFinite(price) && Number.isFinite(size) ? price * size : 0
  }, [from.token, amount])

  /**
   * Move the source of funds to another chain, keeping the trade the user asked
   * for. The amount is re-expressed in the new token so the trade stays the same
   * size in dollars, capped by what they actually hold there.
   */
  const useFundsFrom = useCallback(
    (balance: TokenBalance) => {
      const price = Number(balance.token.priceUSD)
      const held = Number(balance.decimal)

      let next = held
      if (Number.isFinite(price) && price > 0 && needUsd > 0) {
        next = Math.min(held, needUsd / price)
      }

      setFrom({ chainId: balance.chainId, token: balance.token })
      setAmount(next > 0 ? String(Number(next.toPrecision(8))) : '')
      setConfirming(false)
    },
    [needUsd],
  )

  const onPickAsset = useCallback(
    (chainId: number, token: Token) => {
      if (picking === 'from') {
        setFrom({ chainId, token })
        // With bridging off, a trade must begin and end on the same chain, so
        // moving one side moves the other rather than silently producing a pair
        // that can never be routed.
        if (!bridging) setTo((previous) => (previous.chainId === chainId ? previous : { chainId, token: null }))
      }
      if (picking === 'to') {
        setTo({ chainId, token })
        if (!bridging) setFrom((previous) => (previous.chainId === chainId ? previous : { chainId, token: null }))
      }
      setPicking(null)
      setConfirming(false)
    },
    [picking, bridging],
  )

  /** Turning bridging off collapses an in-progress cross-chain trade onto one chain. */
  const onBridgingChange = useCallback(
    (enabled: boolean) => {
      setBridging(enabled)
      setConfirming(false)
      if (!enabled && from.chainId !== to.chainId) {
        setTo({ chainId: from.chainId, token: null })
      }
    },
    [from.chainId, to.chainId, setBridging],
  )

  const flip = useCallback(() => {
    setFrom(to)
    setTo(from)
    setAmount('')
    setConfirming(false)
  }, [from, to])

  const runTrade = useCallback(async () => {
    if (!wallet.provider || !wallet.account || !quote.step) return

    setConfirming(false)
    try {
      await executeRoute({
        provider: wallet.provider,
        account: wallet.account,
        step: quote.step,
        approvalPolicy,
        onStage: setStage,
      })
    } catch (error) {
      setStage({ phase: 'failed', message: (error as Error).message })
    }
  }, [wallet.provider, wallet.account, quote.step, approvalPolicy])

  const ledger = quote.ledger
  const quoteAge = quote.fetchedAt ? Date.now() - quote.fetchedAt : 0

  return (
    <div className="app">
      <header className="app__header">
        <div className="brand">
          <span className="brand__mark" aria-hidden />
          <div>
            <h1>Clearswap</h1>
            <p>Every fee itemised. Bridging inside the trade.</p>
          </div>
        </div>

        <div className="app__header-right">
          <span className="fee-badge" title="The platform fee this deployment charges">
            Platform fee {(PLATFORM_FEE_BPS / 100).toFixed(2)}%
          </span>
          <WalletMenu
            wallets={wallet.wallets}
            account={wallet.account}
            chainId={wallet.chainId}
            connecting={wallet.connecting}
            error={wallet.error}
            onConnect={wallet.connect}
            onDisconnect={wallet.disconnect}
          />
        </div>
      </header>

      {tokensError ? <p className="banner banner--error">{tokensError}</p> : null}

      <main className="app__main">
        <div className="column">
          <TradePanel
            from={from}
            to={to}
            amount={amount}
            slippage={slippage}
            balance={fromBalance}
            receive={ledger ? { decimal: ledger.receive.decimal, symbol: ledger.receive.symbol, usd: ledger.receive.usd } : null}
            bridging={bridging}
            onBridgingChange={onBridgingChange}
            onAmountChange={(next) => {
              setAmount(next)
              setConfirming(false)
            }}
            onSlippageChange={(next) => {
              setSlippage(next)
              setConfirming(false)
            }}
            onPick={setPicking}
            onFlip={flip}
          />

          {wallet.account ? (
            <FundingRadar
              balances={balances}
              scanning={scanning}
              pending={pending}
              failed={failed}
              fromChainId={from.chainId}
              sufficient={sufficient}
              needUsd={needUsd}
              bridging={bridging}
              onUseFunds={useFundsFrom}
              onEnableBridging={() => setBridging(true)}
            />
          ) : null}

          {ledger ? <RouteDiagram ledger={ledger} /> : null}

          <div className="actions">
            {!wallet.account ? (
              <p className="actions__hint">Connect a wallet to see live prices and costs for your own balances.</p>
            ) : !fromRaw ? (
              <p className="actions__hint">Enter an amount to price the trade.</p>
            ) : quote.loading ? (
              <p className="actions__hint">Pricing the route…</p>
            ) : quote.error ? (
              <p className="actions__hint actions__hint--error">{quote.error}</p>
            ) : null}

            {ledger && quote.step && !executing ? (
              confirming ? (
                <div className="confirm">
                  <p>
                    You are sending {formatToken(ledger.send.decimal, ledger.send.symbol)} and will receive at least{' '}
                    <strong>{formatToken(ledger.guaranteed.decimal, ledger.guaranteed.symbol)}</strong>. The most this can
                    cost you is <strong>{formatUsd(ledger.worstCaseCostUsd)}</strong>.
                  </p>

                  {from.token && from.token.address.toLowerCase() !== NATIVE_ADDRESS ? (
                    <label className="confirm__approval">
                      <input
                        type="checkbox"
                        checked={approvalPolicy === 'unlimited'}
                        onChange={(event) => setApprovalPolicy(event.target.checked ? 'unlimited' : 'exact')}
                      />
                      Approve an unlimited amount, so future trades of this token skip the approval step. Leaving this
                      unchecked approves only this trade.
                    </label>
                  ) : null}

                  <div className="confirm__buttons">
                    <button type="button" className="button button--ghost" onClick={() => setConfirming(false)}>
                      Back
                    </button>
                    <button type="button" className="button button--primary" onClick={runTrade}>
                      Confirm and sign
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="button button--primary button--wide"
                  onClick={() => setConfirming(true)}
                  disabled={!sufficient}
                >
                  {sufficient
                    ? from.chainId === to.chainId
                      ? 'Review this trade'
                      : `Review this bridge & trade`
                    : `Not enough ${from.token?.symbol ?? 'funds'} on ${chainName(from.chainId)}`}
                </button>
              )
            ) : null}

            <ExecutionProgress stage={stage} chainId={from.chainId} />

            {stage.phase === 'done' ? (
              <ReceiptCard receipt={stage.receipt} estimatedOutUsd={ledger?.receive.usd ?? null} />
            ) : null}
          </div>
        </div>

        <div className="column column--ledger">
          {ledger ? (
            <>
              <CostLedger ledger={ledger} stale={quoteAge > QUOTE_REFRESH_MS * 2} />
              <p className="quote-age">
                {quote.refreshing ? 'Refreshing…' : `Quote refreshes every ${QUOTE_REFRESH_MS / 1000}s.`}{' '}
                <button type="button" className="linkish" onClick={quote.refresh}>
                  Refresh now
                </button>
              </p>
            </>
          ) : (
            <section className="ledger ledger--empty">
              <h2>What this trade costs you</h2>
              <p>
                Enter a trade and every cost appears here: network fees, the liquidity spread, any bridge fee, and our
                cut — which on this deployment is {(PLATFORM_FEE_BPS / 100).toFixed(2)}%.
              </p>
              <p className="muted">
                The lines always add up to the total. If they ever do not, this panel says so rather than hiding the
                difference.
              </p>
            </section>
          )}
        </div>
      </main>

      {picking ? (
        <AssetPicker
          title={picking === 'from' ? 'Pay with' : 'Receive'}
          chainIds={tradeableChains}
          tokensByChain={tokensByChain}
          balances={balances}
          initialChainId={picking === 'from' ? from.chainId : to.chainId}
          note={
            bridging
              ? undefined
              : 'Bridging is off, so both sides of the trade stay on one chain. Choosing another chain here moves the whole trade to it.'
          }
          onSelect={onPickAsset}
          onClose={() => setPicking(null)}
        />
      ) : null}

      {tokensLoading ? <p className="banner">Loading chains and token lists…</p> : null}

      <footer className="app__footer">
        <p>
          Chain data, RPC endpoints and explorer links come from the{' '}
          <a href="https://github.com/ethereum-lists/chains" target="_blank" rel="noreferrer noopener">
            ethereum-lists/chains
          </a>{' '}
          dataset. Routing and pricing come from the LI.FI aggregator. Nothing here custodies your funds — every
          transaction is signed by your own wallet.
        </p>
      </footer>
    </div>
  )
}
