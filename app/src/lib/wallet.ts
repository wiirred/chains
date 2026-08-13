/**
 * Wallet connection over EIP-1193, with EIP-6963 discovery so that having three
 * wallet extensions installed does not mean whichever one won the race to
 * `window.ethereum` gets to handle the money.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  type Address,
  type EIP1193Provider,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { addChainParams, chainById, resolveChain, toViemChain, type ChainInfo } from './registry'

export type DiscoveredWallet = {
  id: string
  name: string
  icon?: string
  provider: EIP1193Provider
}

type Eip6963Detail = {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: EIP1193Provider
}

/**
 * Announce-and-listen handshake from EIP-6963. Wallets respond synchronously, so
 * a short window is enough; the legacy `window.ethereum` is included as a
 * fallback for wallets that never adopted the standard.
 */
export function discoverWallets(timeoutMs = 300): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>()

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail
      if (!detail?.info || !detail.provider) return
      found.set(detail.info.rdns, {
        id: detail.info.rdns,
        name: detail.info.name,
        icon: detail.info.icon,
        provider: detail.provider,
      })
    }

    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)

      const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum
      if (legacy && found.size === 0) {
        found.set('injected', { id: 'injected', name: 'Browser wallet', provider: legacy })
      }

      resolve([...found.values()])
    }, timeoutMs)
  })
}

export function walletClientFor(provider: EIP1193Provider, account: Address, chain?: ChainInfo): WalletClient {
  return createWalletClient({
    account,
    chain: chain ? toViemChain(chain) : undefined,
    transport: custom(provider),
  })
}

const publicClients = new Map<number, PublicClient>()

/**
 * Read-only client for a chain, using the public RPCs from the dataset.
 *
 * Public endpoints are individually unreliable, so every RPC listed for the chain
 * is stacked behind a fallback transport rather than trusting the first one.
 */
export function publicClientFor(chainId: number): PublicClient | null {
  const cached = publicClients.get(chainId)
  if (cached) return cached

  const info = chainById(chainId)
  if (!info) return null

  const client = createPublicClient({
    chain: toViemChain(info),
    transport: fallback(
      info.rpcs.map((url) => http(url, { timeout: 8_000, retryCount: 1 })),
      { rank: false },
    ),
    batch: { multicall: true },
  }) as PublicClient

  publicClients.set(chainId, client)
  return client
}

export async function connect(provider: EIP1193Provider): Promise<Address[]> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[]
  return accounts
}

export async function currentChainId(provider: EIP1193Provider): Promise<number> {
  const hex = (await provider.request({ method: 'eth_chainId' })) as string
  return Number.parseInt(hex, 16)
}

export class ChainSwitchError extends Error {}

/**
 * Move the wallet to `chainId`, adding the network first if the wallet has never
 * heard of it. The details come from the dataset, so this works for chains no
 * wallet ships by default.
 */
export async function switchChain(provider: EIP1193Provider, chainId: number): Promise<void> {
  const hexChainId = `0x${chainId.toString(16)}`

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    } as never)
    return
  } catch (error) {
    // 4902 is the standard "unrecognised chain" code, but several wallets report
    // it inconsistently, so the add-then-retry path is attempted on any failure
    // that is not an outright user rejection.
    const code = (error as { code?: number })?.code
    if (code === 4001) throw new ChainSwitchError('You declined the network switch.')

    const info = await resolveChain(chainId)
    if (!info) throw new ChainSwitchError(`Chain ${chainId} is not in the registry.`)

    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [addChainParams(info)],
      } as never)
    } catch (addError) {
      const addCode = (addError as { code?: number })?.code
      throw new ChainSwitchError(
        addCode === 4001
          ? `You declined adding ${info.name}.`
          : `Could not switch to ${info.name}. Add it in your wallet and try again.`,
      )
    }
  }
}

export type SendableTransaction = {
  to: Address
  data: `0x${string}`
  value?: bigint
  chainId: number
  gas?: bigint
}

export async function sendTransaction(
  provider: EIP1193Provider,
  account: Address,
  tx: SendableTransaction,
): Promise<Hash> {
  const chain = chainById(tx.chainId)
  const client = walletClientFor(provider, account, chain)

  return client.sendTransaction({
    account,
    chain: chain ? toViemChain(chain) : null,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: tx.gas,
  })
}
