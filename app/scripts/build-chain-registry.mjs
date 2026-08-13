/**
 * Builds the runtime chain registry.
 *
 * The trading app needs three things per chain: a name to show, a public RPC it
 * can call from a browser, and a block explorer to link receipts to. The
 * ethereum-lists/chains dataset holds all three; everything else is dropped so
 * the bundle stays small.
 *
 * Two files come out of this, because the full dataset is far too large to sit
 * in the initial bundle:
 *   - chains.core.json  every chain a major bridge or DEX aggregator can route,
 *                       shipped eagerly so the trade panel renders immediately.
 *   - chains.json       all 2300+ non-deprecated chains, loaded on demand when
 *                       someone opens the full network browser.
 *
 * The dataset is found in this order, so that the app builds whether or not it
 * lives next to a checkout of it:
 *   1. $CHAINS_DATA_DIR             — an explicit path
 *   2. ../_data/chains              — a sibling checkout (this repo)
 *   3. vendor/chains.core.json      — a committed snapshot, always present
 *
 * Falling back to the snapshot costs the long tail of chains, not correctness:
 * the app still trades on every routable network, it just knows fewer obscure
 * ones for explorer links and wallet network-adding.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'src', 'generated')
const snapshotFile = join(here, '..', 'vendor', 'chains.core.json')

function resolveDataDir() {
  const candidates = [process.env.CHAINS_DATA_DIR, join(here, '..', '..', '_data', 'chains')]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

const dataDir = resolveDataDir()

/**
 * Chains that liquidity venues and bridges actually serve today. Being on this
 * list only means "show it up front" — the routing API remains the authority on
 * what is genuinely routable, and the app intersects the two at runtime.
 */
const CORE_CHAIN_IDS = [
  1, // Ethereum
  10, // OP Mainnet
  56, // BNB Smart Chain
  100, // Gnosis
  130, // Unichain
  137, // Polygon
  146, // Sonic
  169, // Manta Pacific
  250, // Fantom
  252, // Fraxtal
  324, // zkSync Era
  480, // World Chain
  1088, // Metis
  1101, // Polygon zkEVM
  1868, // Soneium
  1923, // Swellchain
  2741, // Abstract
  5000, // Mantle
  8453, // Base
  34443, // Mode
  42161, // Arbitrum One
  42170, // Arbitrum Nova
  42220, // Celo
  43114, // Avalanche
  57073, // Ink
  59144, // Linea
  81457, // Blast
  534352, // Scroll
  59144, // Linea
  7777777, // Zora
]

/** RPCs we cannot use: templated keys, websockets, and non-TLS endpoints. */
function usableRpcs(rpc = []) {
  return rpc.filter(
    (url) =>
      typeof url === 'string' &&
      url.startsWith('https://') &&
      !url.includes('${') &&
      !url.includes('API_KEY'),
  )
}

/** Prefer an EIP-3091 explorer so we can build /tx/<hash> links deterministically. */
function pickExplorer(explorers = []) {
  const eip3091 = explorers.find((e) => e.standard === 'EIP3091' && e.url)
  const any = explorers.find((e) => e.url)
  const chosen = eip3091 || any
  return chosen ? { name: chosen.name, url: chosen.url.replace(/\/+$/, '') } : null
}

function readDataset(directory) {
  const collected = []

  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) continue

    let chain
    try {
      chain = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${err.message}`)
    }

    // A deprecated chain may have had its ID reused, which is exactly the kind of
    // ambiguity we must never route someone's money through.
    if (chain.status === 'deprecated') continue
    if (typeof chain.chainId !== 'number') continue

    const rpcs = usableRpcs(chain.rpc)
    if (rpcs.length === 0) continue

    collected.push({
      chainId: chain.chainId,
      name: chain.name,
      shortName: chain.shortName,
      // Cap the RPC list: we only need a couple of fallbacks, not twelve.
      rpcs: rpcs.slice(0, 4),
      nativeCurrency: chain.nativeCurrency,
      explorer: pickExplorer(chain.explorers),
      testnet: /testnet|devnet|sepolia|goerli|holesky/i.test(chain.name) || undefined,
    })
  }

  return collected
}

const usingSnapshot = dataDir === null

if (usingSnapshot && !existsSync(snapshotFile)) {
  throw new Error(
    `No chain dataset found and no snapshot at ${snapshotFile}. ` +
      `Set CHAINS_DATA_DIR to a checkout of ethereum-lists/chains, or restore the snapshot.`,
  )
}

const chains = usingSnapshot ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : readDataset(dataDir)

chains.sort((a, b) => a.chainId - b.chainId)

const core = new Set(CORE_CHAIN_IDS)
const coreChains = chains.filter((c) => core.has(c.chainId))

const missing = CORE_CHAIN_IDS.filter((id) => !coreChains.some((c) => c.chainId === id))
if (missing.length) {
  // A core chain with no usable public RPC in the dataset would silently vanish
  // from the trade panel, so fail loudly instead.
  throw new Error(
    `Core chains missing from the dataset or lacking a public RPC: ${missing.join(', ')}`,
  )
}

mkdirSync(outDir, { recursive: true })

for (const [file, value] of [
  ['chains.core.json', coreChains],
  ['chains.json', chains],
]) {
  const json = JSON.stringify(value)
  writeFileSync(join(outDir, file), json)
  const kb = Math.round(Buffer.byteLength(json) / 1024)
  console.log(`${file}: ${value.length} chains, ${kb} KB`)
}

// Refresh the committed snapshot whenever the real dataset is available, so a
// standalone build never drifts far behind the source of truth.
if (!usingSnapshot) {
  mkdirSync(dirname(snapshotFile), { recursive: true })
  writeFileSync(snapshotFile, JSON.stringify(coreChains, null, 2) + '\n')
  console.log(`source: ${dataDir}`)
} else {
  console.log(`source: committed snapshot (long-tail chains unavailable)`)
}
