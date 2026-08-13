/**
 * Everything this app charges, in one file.
 *
 * The whole point of the product is that a user can answer "what is this costing
 * me?" without trusting us, so the answer starts by being answerable without
 * reading the rest of the source.
 */

/**
 * Our cut, in basis points of the input amount. 100 bps = 1%.
 *
 * The default is zero. An operator has to deliberately raise it, and whatever
 * they set here is rendered in the trade panel on every single quote — including
 * when it is zero.
 */
export const PLATFORM_FEE_BPS = 0

/** Address that receives the platform fee. Only meaningful when the fee is > 0. */
export const PLATFORM_FEE_RECIPIENT = ''

/**
 * A ceiling the UI enforces on itself. A fat-fingered extra digit in
 * PLATFORM_FEE_BPS should stop the app from loading, not quietly take 30% of
 * somebody's trade.
 */
export const MAX_PLATFORM_FEE_BPS = 100

/**
 * Identifier sent to the routing API. Routers use it for attribution and, when a
 * fee is set, to know who to pay.
 */
export const INTEGRATOR = 'clearswap'

/**
 * Route aggregator. LI.FI is used because it quotes same-chain swaps and
 * cross-chain bridge routes through one endpoint and — critically for this app —
 * returns itemised `feeCosts` and `gasCosts` rather than a single net number.
 */
export const ROUTER_API = 'https://li.quest/v1'

/** Optional API key. Public rate limits apply without one. */
export const ROUTER_API_KEY = import.meta.env?.VITE_ROUTER_API_KEY ?? ''

/** Default max slippage, as a fraction. 0.005 = 0.5%. */
export const DEFAULT_SLIPPAGE = 0.005

/** Slippage above this gets a visible warning before the trade can be sent. */
export const HIGH_SLIPPAGE_WARNING = 0.03

/** Refresh a live quote this often, in ms. Quotes go stale and stale quotes revert. */
export const QUOTE_REFRESH_MS = 20_000

/**
 * If the router's own price data implies a cost above this fraction of the trade,
 * we stop calling it a spread and start calling it a warning.
 */
export const IMPLAUSIBLE_SPREAD_PCT = 0.05

if (PLATFORM_FEE_BPS < 0 || PLATFORM_FEE_BPS > MAX_PLATFORM_FEE_BPS) {
  throw new Error(
    `PLATFORM_FEE_BPS is ${PLATFORM_FEE_BPS}, outside the permitted range 0..${MAX_PLATFORM_FEE_BPS}. ` +
      `Refusing to load rather than charge an unintended fee.`,
  )
}

if (PLATFORM_FEE_BPS > 0 && !PLATFORM_FEE_RECIPIENT) {
  throw new Error('PLATFORM_FEE_BPS is set but PLATFORM_FEE_RECIPIENT is empty.')
}
