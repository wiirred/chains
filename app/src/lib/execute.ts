/**
 * Executing a route, and telling the truth about it afterwards.
 *
 * A quote is a forecast. Gas is estimated, slippage is a range, and on a
 * cross-chain route the amount that lands is decided minutes later by a bridge.
 * So execution here is not fire-and-forget: it tracks each stage, then settles
 * the estimate against what the chain actually did.
 */
import {
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import type { Step } from './router'
import { getTransferStatus } from './router'
import { NATIVE_ADDRESS } from './balances'
import { publicClientFor, sendTransaction, switchChain } from './wallet'

export type ExecutionStage =
  | { phase: 'idle' }
  | { phase: 'switching-chain'; chainId: number }
  | { phase: 'approving'; spender: string }
  | { phase: 'approval-pending'; hash: Hash }
  | { phase: 'signing' }
  | { phase: 'submitted'; hash: Hash }
  | { phase: 'bridging'; hash: Hash; message: string }
  | { phase: 'done'; receipt: TradeReceipt }
  | { phase: 'failed'; message: string; hash?: Hash }

/**
 * What the trade actually cost, measured rather than predicted.
 */
export type TradeReceipt = {
  sourceHash: Hash
  sourceChainId: number
  destinationHash?: string
  destinationChainId: number

  /** Gas actually burned on the source chain, in native units. */
  gasPaid: string
  gasSymbol: string
  gasPaidUsd: number | null
  /** What the quote predicted, for comparison. */
  gasEstimatedUsd: number | null

  approvalGasPaid?: string
  approvalGasPaidUsd?: number | null

  /** Output the route promised, and what arrived. Both in smallest units. */
  expectedOut: string
  actualOut?: string
  outSymbol: string
  outDecimals: number
  actualOutUsd?: number | null

  crossChain: boolean
  seconds: number
}

export async function allowanceOf(
  chainId: number,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  const client = publicClientFor(chainId)
  if (!client) throw new Error(`No RPC available for chain ${chainId}`)

  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })
}

export type ApprovalPolicy = 'exact' | 'unlimited'

/**
 * Approve the router to move exactly this trade's input by default.
 *
 * An unlimited approval saves gas on the next trade and is what most interfaces
 * do silently. It also leaves a standing permission on the wallet forever, so it
 * is offered as a choice rather than taken as one.
 */
export function buildApproval(spender: Address, amount: bigint, policy: ApprovalPolicy) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, policy === 'unlimited' ? maxUint256 : amount],
  })
}

function nativeSymbolFor(step: Step): string {
  const gas = step.estimate.gasCosts?.[0]
  return gas?.token.symbol ?? 'ETH'
}

function nativePriceFor(step: Step): number | null {
  const price = Number(step.estimate.gasCosts?.[0]?.token.priceUSD)
  return Number.isFinite(price) ? price : null
}

export type ExecuteOptions = {
  provider: EIP1193Provider
  account: Address
  step: Step
  approvalPolicy?: ApprovalPolicy
  onStage: (stage: ExecutionStage) => void
  signal?: AbortSignal
}

/**
 * Run a quoted route end to end.
 */
export async function executeRoute({
  provider,
  account,
  step,
  approvalPolicy = 'exact',
  onStage,
  signal,
}: ExecuteOptions): Promise<TradeReceipt> {
  const fromChainId = step.action.fromChainId
  const toChainId = step.action.toChainId
  const crossChain = fromChainId !== toChainId
  const startedAt = Date.now()

  const request = step.transactionRequest
  if (!request) throw new Error('This quote has no executable transaction. Refresh and try again.')

  const client = publicClientFor(fromChainId)
  if (!client) throw new Error(`No RPC available for chain ${fromChainId}`)

  onStage({ phase: 'switching-chain', chainId: fromChainId })
  await switchChain(provider, fromChainId)

  let approvalGasPaid: string | undefined
  let approvalGasPaidUsd: number | null | undefined

  const tokenAddress = step.action.fromToken.address
  const isNative = tokenAddress.toLowerCase() === NATIVE_ADDRESS

  if (!isNative) {
    const spender = step.estimate.approvalAddress as Address
    const needed = BigInt(step.action.fromAmount)
    const current = await allowanceOf(fromChainId, tokenAddress as Address, account, spender)

    if (current < needed) {
      onStage({ phase: 'approving', spender })
      const approvalHash = await sendTransaction(provider, account, {
        to: tokenAddress as Address,
        data: buildApproval(spender, needed, approvalPolicy),
        chainId: fromChainId,
      })

      onStage({ phase: 'approval-pending', hash: approvalHash })
      const approvalReceipt = await client.waitForTransactionReceipt({ hash: approvalHash })

      if (approvalReceipt.status !== 'success') {
        throw new Error('The approval transaction reverted. Nothing was traded.')
      }

      const cost = approvalReceipt.gasUsed * approvalReceipt.effectiveGasPrice
      approvalGasPaid = (Number(cost) / 1e18).toString()
      const price = nativePriceFor(step)
      approvalGasPaidUsd = price === null ? null : Number(approvalGasPaid) * price
    }
  }

  onStage({ phase: 'signing' })

  const hash = await sendTransaction(provider, account, {
    to: request.to as Address,
    data: request.data as `0x${string}`,
    value: request.value ? BigInt(request.value) : undefined,
    chainId: fromChainId,
    gas: request.gasLimit ? BigInt(request.gasLimit) : undefined,
  })

  onStage({ phase: 'submitted', hash })

  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error('The transaction reverted on chain. You still paid gas for the failed attempt.')
  }

  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice
  const gasPaid = (Number(gasCost) / 1e18).toString()
  const nativePrice = nativePriceFor(step)

  const base: TradeReceipt = {
    sourceHash: hash,
    sourceChainId: fromChainId,
    destinationChainId: toChainId,
    gasPaid,
    gasSymbol: nativeSymbolFor(step),
    gasPaidUsd: nativePrice === null ? null : Number(gasPaid) * nativePrice,
    gasEstimatedUsd: (step.estimate.gasCosts ?? []).reduce<number | null>((sum, cost) => {
      const value = Number(cost.amountUSD)
      if (!Number.isFinite(value)) return sum
      return (sum ?? 0) + value
    }, null),
    approvalGasPaid,
    approvalGasPaidUsd,
    expectedOut: step.estimate.toAmount,
    outSymbol: step.action.toToken.symbol,
    outDecimals: step.action.toToken.decimals,
    crossChain,
    seconds: (Date.now() - startedAt) / 1000,
  }

  if (!crossChain) {
    const done = { ...base, actualOut: step.estimate.toAmount, seconds: (Date.now() - startedAt) / 1000 }
    onStage({ phase: 'done', receipt: done })
    return done
  }

  // Cross-chain: the source transaction confirming means the money has left, not
  // that it has arrived. Poll until the far side settles.
  const settled = await waitForBridge({ hash, fromChainId, toChainId, tool: step.tool, onStage, signal })

  const done: TradeReceipt = {
    ...base,
    destinationHash: settled?.receiving?.txHash,
    actualOut: settled?.receiving?.amount,
    actualOutUsd: Number(settled?.receiving?.amountUSD) || null,
    seconds: (Date.now() - startedAt) / 1000,
  }

  onStage({ phase: 'done', receipt: done })
  return done
}

async function waitForBridge({
  hash,
  fromChainId,
  toChainId,
  tool,
  onStage,
  signal,
}: {
  hash: Hash
  fromChainId: number
  toChainId: number
  tool: string
  onStage: (stage: ExecutionStage) => void
  signal?: AbortSignal
}) {
  const deadline = Date.now() + 30 * 60 * 1000
  let delay = 5_000

  while (Date.now() < deadline) {
    if (signal?.aborted) return null

    try {
      const status = await getTransferStatus({ txHash: hash, fromChain: fromChainId, toChain: toChainId, bridge: tool }, signal)

      if (status.status === 'DONE') return status
      if (status.status === 'FAILED') {
        throw new Error(
          status.substatusMessage ||
            'The bridge reported that this transfer failed. Your funds are usually refunded on the source chain.',
        )
      }

      onStage({
        phase: 'bridging',
        hash,
        message: status.substatusMessage || 'Waiting for the bridge to release funds on the destination chain.',
      })
    } catch (error) {
      if (error instanceof Error && /failed/i.test(error.message)) throw error
      // A transient status-API error is not a failed bridge; keep polling.
    }

    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 1.3, 20_000)
  }

  throw new Error(
    'The bridge has not settled after 30 minutes. Your source transaction succeeded — track it on the explorer; ' +
      'most bridges complete or refund on their own.',
  )
}
