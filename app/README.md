# Clearswap

A crypto trading interface built on two ideas:

1. **You should be able to see every cost of a trade before you sign it** — including the large one that almost no interface shows, which is hidden inside the price rather than charged as a fee.
2. **If your money is on a different chain than the trade, that should be a detail, not an errand.** Bridging happens inside the trade, in one signature.

It is a front end. It holds no funds, has no backend, and every transaction is signed by your own wallet.

---

## The cost ledger

Most swap interfaces show you a network fee, maybe a "0.25% fee", and an output amount. That accounting is incomplete in a way that reliably favours whoever built the interface. On a $1,000 trade the named fees are often a couple of dollars while the real cost is fifteen — the rest disappears into the exchange rate as pool fees, price impact, and routing margin.

This app computes a ledger that **balances**. Every dollar of difference between what leaves your wallet and what arrives in it is assigned to a named line:

```
You send        $1,000.00 USDC on Arbitrum
You receive       $984.00 WETH on Base

  Liquidity spread & price impact   $11.90   66% of total cost
  Liquidity provider fee             $2.90   16%
  Network fee — transaction          $1.20    7%
  Across bridge fee                  $1.20    7%
  Destination gas                    $0.90    5%
  ─────────────────────────────────────────
  Total cost                        $18.10   1.81% of what you send
  Worst case (at max slippage)      $23.02
```

The arithmetic behind it, in `src/lib/fees.ts`:

```
valueLost  = sendUSD − receiveUSD                     (at mid-market prices)
spread     = valueLost − fees already deducted from the output
totalCost  = gas + all named fees + spread
```

The spread line is the residual — it is whatever the router did not explain. Naming it is the point: it is the number that vanishes in every other interface, and it is usually the biggest one. `ledgerBalance()` asserts that the lines sum to the total, and if they ever do not, **the UI says so on screen** rather than quietly absorbing the difference.

Some deliberate choices in that module:

- USD figures are always computed as `price × amount` from a single price source, never mixed with the router's own pre-computed USD fields. Mixing them makes the ledger stop balancing, which hides discrepancies inside the residual.
- Fees marked `included` (taken out of your output) and fees charged on top of the trade are counted differently, because they hit your wallet differently.
- If a token has no reliable price, the app **refuses to state a total cost** and says why, instead of printing a confident number derived from nothing.
- Gas is never described as "paid to us". Each line names who actually receives the money.

## The platform fee

Set in one place, `src/config.ts`:

```ts
export const PLATFORM_FEE_BPS = 0        // basis points; 100 = 1%
export const PLATFORM_FEE_RECIPIENT = ''
export const MAX_PLATFORM_FEE_BPS = 100  // a ceiling the app enforces on itself
```

The default is **zero**, and it is displayed on every quote whether it is zero or not — in the header and as its own line in the ledger, tagged `US`. An out-of-range value throws at load rather than silently charging an unintended amount.

If the app is configured to charge a fee but the router does not report taking one, the ledger warns about the discrepancy instead of quietly displaying the configured number as if it had been charged.

## Bridging inside the trade

There is no separate "bridge" tab. The trade form has a chain on each side; if they differ, the route contains a bridge and the ledger prices it like any other cost.

On top of that, the app scans your wallet across every routable chain (`src/lib/balances.ts`) and, when the source chain cannot cover the trade you have set up, tells you where your money actually is:

> You do not have enough on Base — but you do elsewhere.
> **1,240 USDC** on Arbitrum One · $1,240.00 · covers this trade

Picking one moves the source of funds and keeps the trade the same size, so the bridge becomes part of the route. Funds already on the source chain always rank first: bridging costs money, and nudging someone across a bridge they did not need would be the opposite of the point.

Chains that fail to respond are reported as **failed**, not as zero. "You have nothing here" and "we could not check" are very different things to say about someone's money.

## Where the data comes from

- **Chains, RPC endpoints, explorers** — this repository's own `_data/chains` dataset. `scripts/build-chain-registry.mjs` compiles it into two files at build time: a core set of ~29 routable chains bundled eagerly, and the full 2,300-chain registry loaded on demand. Deprecated chains are excluded (a reused chain ID is exactly the ambiguity you should never route money through), as are RPCs with unfilled API-key placeholders.
- **Routing, quotes, prices** — the [LI.FI](https://li.fi) aggregator, chosen because it quotes same-chain swaps and cross-chain routes through one endpoint and returns *itemised* `feeCosts` and `gasCosts` rather than a single net number. Without itemisation there is no ledger to build.

Because the registry supplies RPC URLs and explorer links for every chain in the dataset, the app can add an unfamiliar network to a wallet (`wallet_addEthereumChain`) and link receipts to a real explorer without hardcoding anything.

## Receipts

A quote is a forecast: gas is estimated before the block is built, and on a cross-chain route the amount that lands is decided minutes later by a bridge. After execution the app shows estimated against **actually paid**, from the transaction receipt:

| Item | Estimated | Actually paid |
| --- | --- | --- |
| Network fee | $1.20 | 0.00043 ETH · $1.29 |
| Received | 0.328 WETH · $984.00 | 0.3277 WETH · $983.10 |

An interface that only ever shows forecasts can be wrong forever without anyone noticing.

## Running it

```bash
cd app
npm install
npm run dev      # regenerates the chain registry, then starts Vite
```

```bash
npm test         # fee ledger unit tests
npm run build    # registry + typecheck + production build
```

Optional, to raise the public API rate limits — create `app/.env`:

```
VITE_ROUTER_API_KEY=your-lifi-key
```

Requires an EIP-1193 browser wallet. Wallets are discovered via EIP-6963, so having several extensions installed does not mean whichever one won the race to `window.ethereum` handles your money.

## Known limitations

- **The routing API was unreachable from the sandbox this was built in** (`li.quest` is blocked by its egress policy). The client is written against LI.FI's documented contract and the whole UI was verified end to end against mocked responses in a real browser, but it has not been exercised against the live API. Check the first real quote carefully.
- Execution has not been run against mainnet. The approval → swap → bridge-status flow is implemented but unproven with real funds; test with a small amount first.
- Token lists are trimmed to the 200 most liquid tokens per chain to keep the payload sane. Anything else is reachable by pasting a contract address, which resolves through the router's token endpoint.
- The balance scan relies on public RPCs from the dataset and on Multicall3 being deployed at its usual address. Both are best-effort; failures are surfaced rather than hidden.
- Prices come from a single source (the router). The spread line is only as trustworthy as that price feed, which is why the app flags a spread too large to be ordinary rather than presenting it as fact.

## Layout

```
src/
  config.ts              every fee this app charges, in one file
  lib/
    fees.ts              the ledger engine — the core of the product
    fees.test.ts         14 tests, including that the ledger always balances
    router.ts            typed quote/bridge/status client
    execute.ts           approval → swap → bridge tracking → receipt
    balances.ts          cross-chain balance scan and the funding radar
    registry.ts          chain registry built from _data/chains
    wallet.ts            EIP-6963 discovery, chain switching, RPC clients
  components/
    CostLedger.tsx       the itemised breakdown
    FundingRadar.tsx     "your money is on a different chain"
    RouteDiagram.tsx     hop-by-hop route, bridge included
    TradePanel.tsx       one form for swaps and bridges alike
    ...
scripts/
  build-chain-registry.mjs
```
