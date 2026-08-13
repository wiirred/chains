import { useCallback, useEffect, useRef, useState } from 'react'
import { getQuote, RouterError, type Step } from '../lib/router'
import { buildLedger, type FeeLedger } from '../lib/fees'
import { QUOTE_REFRESH_MS } from '../config'

export type QuoteRequest = {
  fromChain: number
  toChain: number
  fromToken: string
  toToken: string
  fromAmount: string
  fromAddress: string
  slippage: number
}

export type QuoteState = {
  step: Step | null
  ledger: FeeLedger | null
  loading: boolean
  refreshing: boolean
  error: string | null
  /** When the current quote was fetched, for the staleness countdown. */
  fetchedAt: number | null
}

function friendlyError(error: unknown): string {
  if (error instanceof RouterError) {
    if (error.status === 404) return 'No route exists for this pair right now.'
    if (error.status === 429) return 'The routing API is rate-limiting us. Try again in a moment.'
    return error.message
  }
  if (error instanceof TypeError) {
    return 'Could not reach the routing API. Check your connection.'
  }
  return (error as Error)?.message ?? 'Something went wrong fetching the quote.'
}

/**
 * Fetch and keep alive a quote for the current trade.
 *
 * Quotes decay: prices move and the guaranteed minimum stops being achievable, so
 * an unrefreshed quote is a trade that reverts. This refreshes on a timer, but
 * pauses while the user is mid-execution so the route cannot change under them
 * after they have started signing.
 */
export function useQuote(request: QuoteRequest | null, options: { paused?: boolean } = {}) {
  const [state, setState] = useState<QuoteState>({
    step: null,
    ledger: null,
    loading: false,
    refreshing: false,
    error: null,
    fetchedAt: null,
  })

  const controllerRef = useRef<AbortController | null>(null)
  const paused = options.paused ?? false

  const key = request
    ? [request.fromChain, request.toChain, request.fromToken, request.toToken, request.fromAmount, request.fromAddress, request.slippage].join('|')
    : null

  const fetchQuote = useCallback(
    async (isRefresh: boolean) => {
      if (!request) return

      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller

      setState((prev) => ({
        ...prev,
        loading: !isRefresh,
        refreshing: isRefresh,
        error: isRefresh ? prev.error : null,
      }))

      try {
        const step = await getQuote(request, controller.signal)
        if (controller.signal.aborted) return

        setState({
          step,
          ledger: buildLedger(step),
          loading: false,
          refreshing: false,
          error: null,
          fetchedAt: Date.now(),
        })
      } catch (error) {
        if (controller.signal.aborted) return
        setState({
          step: null,
          ledger: null,
          loading: false,
          refreshing: false,
          error: friendlyError(error),
          fetchedAt: null,
        })
      }
    },
    // `key` captures every input that changes the quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  )

  useEffect(() => {
    if (!request || paused) {
      if (!request) {
        controllerRef.current?.abort()
        setState({ step: null, ledger: null, loading: false, refreshing: false, error: null, fetchedAt: null })
      }
      return
    }

    // Debounce so typing an amount does not fire a request per keystroke.
    const timer = setTimeout(() => fetchQuote(false), 250)
    return () => {
      clearTimeout(timer)
      controllerRef.current?.abort()
    }
  }, [key, paused, fetchQuote, request])

  useEffect(() => {
    if (!request || paused || !state.fetchedAt) return
    const timer = setInterval(() => fetchQuote(true), QUOTE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [key, paused, state.fetchedAt, fetchQuote, request])

  return { ...state, refresh: () => fetchQuote(true) }
}
