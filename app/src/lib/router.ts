/**
 * Typed client for the routing API.
 *
 * One endpoint serves both cases the product cares about: a plain swap on one
 * chain, and a bridge-then-swap when the money is somewhere else. The caller does
 * not have to know which it is getting — it passes a source chain and a
 * destination chain, and if they differ the returned route simply contains a
 * bridge step.
 */
import { INTEGRATOR, PLATFORM_FEE_BPS, PLATFORM_FEE_RECIPIENT, ROUTER_API, routerApiKey } from '../config'

export type Token = {
  address: string
  symbol: string
  decimals: number
  chainId: number
  name: string
  coinKey?: string
  /** Mid-market USD price as a decimal string. May be '' when unknown. */
  priceUSD: string
  logoURI?: string
}

export type FeeCost = {
  name: string
  description?: string
  token: Token
  /** Fee amount in the token's smallest unit. */
  amount: string
  amountUSD?: string
  /** Fraction as a decimal string, e.g. '0.003'. */
  percentage?: string
  /**
   * true  — already subtracted from the quoted output.
   * false — charged on top, i.e. an extra debit from the wallet.
   */
  included: boolean
}

export type GasCost = {
  /** 'SEND' is the trade itself; 'APPROVE' is the separate allowance transaction. */
  type: 'SEND' | 'APPROVE' | string
  price?: string
  estimate?: string
  limit?: string
  /** Gas cost in the chain's native token, smallest unit. */
  amount: string
  amountUSD?: string
  token: Token
}

export type Estimate = {
  tool: string
  fromAmount: string
  toAmount: string
  /** Guaranteed minimum output at the requested slippage. */
  toAmountMin: string
  approvalAddress: string
  executionDuration: number
  fromAmountUSD?: string
  toAmountUSD?: string
  feeCosts?: FeeCost[]
  gasCosts?: GasCost[]
}

export type Action = {
  fromChainId: number
  toChainId: number
  fromToken: Token
  toToken: Token
  fromAmount: string
  slippage: number
  fromAddress?: string
  toAddress?: string
}

export type TransactionRequest = {
  to: string
  data: string
  value?: string
  from?: string
  chainId: number
  gasPrice?: string
  gasLimit?: string
}

export type Step = {
  id: string
  type: string
  tool: string
  toolDetails?: { key: string; name: string; logoURI?: string }
  action: Action
  estimate: Estimate
  includedSteps?: Step[]
  transactionRequest?: TransactionRequest
}

export type ChainSupport = {
  id: number
  key: string
  name: string
  logoURI?: string
}

export class RouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'RouterError'
  }
}

async function request<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const url = new URL(ROUTER_API + path)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  const apiKey = routerApiKey()
  if (apiKey) headers['x-lifi-api-key'] = apiKey

  const res = await fetch(url, { headers, signal })

  if (!res.ok) {
    // The router returns a JSON body explaining refusals (no route, amount too
    // small, unsupported pair). Surfacing that beats a bare status code.
    let detail = ''
    let code: string | undefined
    try {
      const body = await res.json()
      detail = body?.message || body?.error || ''
      code = body?.code
    } catch {
      /* non-JSON error body */
    }
    throw new RouterError(detail || `Router returned ${res.status}`, res.status, code)
  }

  return res.json() as Promise<T>
}

export type QuoteParams = {
  fromChain: number
  toChain: number
  fromToken: string
  toToken: string
  /** Input amount in the source token's smallest unit. */
  fromAmount: string
  fromAddress: string
  /** Defaults to fromAddress. */
  toAddress?: string
  /** Fraction, e.g. 0.005 for 0.5%. */
  slippage: number
  order?: 'CHEAPEST' | 'FASTEST' | 'RECOMMENDED' | 'SAFEST'
}

/**
 * Fetch one executable route. Works for same-chain and cross-chain alike; when
 * `fromChain !== toChain` the returned step contains the bridge hop.
 */
export function getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Step> {
  return request<Step>(
    '/quote',
    {
      fromChain: params.fromChain,
      toChain: params.toChain,
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: params.fromAmount,
      fromAddress: params.fromAddress,
      toAddress: params.toAddress ?? params.fromAddress,
      slippage: params.slippage,
      order: params.order ?? 'RECOMMENDED',
      integrator: INTEGRATOR,
      // Only send a fee at all when one is configured, so a zero-fee deployment
      // makes a visibly fee-free request.
      ...(PLATFORM_FEE_BPS > 0
        ? { fee: PLATFORM_FEE_BPS / 10_000, referrer: PLATFORM_FEE_RECIPIENT || undefined }
        : {}),
    },
    signal,
  )
}

export function getSupportedChains(signal?: AbortSignal): Promise<ChainSupport[]> {
  return request<{ chains: ChainSupport[] }>('/chains', {}, signal).then((r) => r.chains ?? [])
}

export function getTokens(chainIds: number[], signal?: AbortSignal): Promise<Record<string, Token[]>> {
  return request<{ tokens: Record<string, Token[]> }>('/tokens', { chains: chainIds.join(',') }, signal).then(
    (r) => r.tokens ?? {},
  )
}

export function getToken(chain: number, token: string, signal?: AbortSignal): Promise<Token> {
  return request<Token>('/token', { chain, token }, signal)
}

export type TransferStatus = {
  status: 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED'
  substatus?: string
  substatusMessage?: string
  sending?: { txHash?: string; amount?: string; token?: Token; gasAmount?: string; gasAmountUSD?: string; amountUSD?: string }
  receiving?: { txHash?: string; amount?: string; token?: Token; amountUSD?: string; chainId?: number }
}

/**
 * Poll the fate of a cross-chain transfer. The source transaction confirming
 * says nothing about whether the money landed on the far side, which is exactly
 * the gap that makes bridging feel untrustworthy.
 */
export function getTransferStatus(
  args: { txHash: string; fromChain: number; toChain: number; bridge?: string },
  signal?: AbortSignal,
): Promise<TransferStatus> {
  return request<TransferStatus>(
    '/status',
    { txHash: args.txHash, fromChain: args.fromChain, toChain: args.toChain, bridge: args.bridge },
    signal,
  )
}
