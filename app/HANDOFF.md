# Handoff

Written for whoever picks this up next, human or agent, with no memory of how it got here. Read this before changing anything in `src/lib/fees.ts` or `src/config.ts` — both encode decisions that look like ordinary code and are not.

- **Repo / branch**: `wiirred/chains`, branch `claude/crypto-trading-platform-inoa5e`
- **Everything lives in** `app/`. The surrounding repository is a fork of `ethereum-lists/chains` and is otherwise untouched apart from one README line.
- **Five commits**, listed at the end, each with the reasoning in its message.

---

## 1. What this is

A crypto trading interface built on two claims:

1. **Every cost of a trade is shown before you sign** — including the large one that is hidden inside the exchange rate rather than charged as a fee.
2. **Bridging happens inside the trade**, as a user-controlled option, not as a separate errand.

It is a front end. No backend, no custody, no accounts. Every transaction is signed by the user's own wallet.

Product strategy, competitor analysis and the longer-term crypto project plan are in `docs/proof-of-cost.html` — read that for *why* the product is shaped this way. This file is about *what exists and how it works*.

---

## 2. Status: verified vs unproven

Be precise about this with the user. Getting it wrong means someone loses money.

| Area | Status |
| --- | --- |
| Fee ledger arithmetic | **Verified** — 14 unit tests in `src/lib/fees.test.ts` |
| UI rendering, full cross-chain flow | **Verified** — driven in Chromium against mocked router responses |
| Bridging toggle, both states + persistence | **Verified** — driven in Chromium |
| Embed isolation in a hostile host page | **Verified** — driven in Chromium |
| Standalone build with no chains dataset | **Verified** |
| Typecheck, production builds | **Verified** — clean |
| **Live routing API** | **NEVER EXERCISED** — see below |
| **On-chain execution** | **NEVER RUN AGAINST MAINNET** |

### The two things that were impossible to test here

The environment this was built in blocks outbound HTTPS to almost everything. Confirmed blocked: `li.quest` (the routing API), `fomo.family`, `docs.onfomo.com`, `en.wikipedia.org`, `api.dexscreener.com`, `api.coingecko.com`, `api.geckoterminal.com`, `api.0x.org`, `tokens.1inch.io`, `api.llama.fi`. Reachable: `registry.npmjs.org`, `github.com`.

Consequences, both of which need closing before anyone trades real money:

1. **`src/lib/router.ts` is written against LI.FI's documented contract, not against observed responses.** Field names, the `included` flag semantics on `feeCosts`, and the shape of `includedSteps` are all as documented. If the live API differs, the ledger will be wrong in ways the tests cannot catch, because the tests use fixtures built from the same documentation. **First task for anyone with network access: capture one real `/v1/quote` response and diff it against the fixtures in `fees.test.ts`.**
2. **`src/lib/execute.ts` has never sent a transaction.** The approval → swap → bridge-status → receipt path is implemented and typechecks, but has not touched a chain. Test with a trivial amount on a cheap network first.

---

## 3. Architecture

```
app/
  src/
    config.ts              every fee this app charges, in one file
    lib/
      fees.ts              the ledger engine — the core of the product
      fees.test.ts         14 tests, incl. that the ledger always balances
      router.ts            typed LI.FI client (quote / tokens / status)
      execute.ts           approval → swap → bridge tracking → receipt
      balances.ts          cross-chain balance scan, funding radar ranking
      registry.ts          chain registry access, viem chain construction
      wallet.ts            EIP-6963 discovery, chain switching, RPC clients
      format.ts            number formatting that refuses to round to zero
    hooks/                 useWallet, useTokens, useBalances, useQuote, usePersistedState
    components/            CostLedger, TradePanel, FundingRadar, RouteDiagram,
                           AssetPicker, ExecutionPanel, WalletMenu
    App.tsx                state orchestration
    main.tsx               standalone app entry
    embed.tsx              drop-in widget entry (shadow DOM)
  scripts/
    build-chain-registry.mjs
  vendor/chains.core.json  committed fallback snapshot (29 chains)
  docs/proof-of-cost.html  product strategy & competitor analysis
```

Roughly 3,850 lines. Dependencies: `react`, `react-dom`, `viem`. Nothing else at runtime.

### Data flow

```
user input → useQuote → router.ts (LI.FI /quote) → Step
                                                    ↓
                                         fees.ts buildLedger()
                                                    ↓
                                    CostLedger + RouteDiagram render
                                                    ↓
                          execute.ts → wallet → chain → TradeReceipt
```

---

## 4. Decisions that must not be casually reverted

These are the ones where the obvious "cleanup" breaks the product.

### The ledger must balance

`fees.ts` guarantees that the sum of every displayed line equals the stated total. The mechanism:

```
valueLost = sendUSD − receiveUSD                    (at mid-market prices)
spread    = valueLost − fees already deducted from output
total     = gas + all named fees + spread
```

`spread` is a **residual** — it absorbs whatever the router did not explain, and is displayed as "Liquidity spread & price impact". This is the entire point of the product: that number is typically the largest cost of a trade and no competitor shows it. `ledgerBalance()` asserts the invariant, and `CostLedger.tsx` renders an on-screen error if it ever fails. **Do not "fix" a failing balance by hiding the difference.**

### USD values come from one source, always

`usdOf()` computes `price × amount` from `token.priceUSD`. It deliberately ignores the router's own `amountUSD` fields. Mixing the two makes the ledger stop balancing, and the discrepancy then hides inside the residual — which is worse than no ledger at all. A future edit that "uses the API's USD value because it's already there" silently breaks the core invariant.

### Unpriced tokens produce no total

If a token has no price, `priced` is `false`, `totalCostUsd` is `null`, and the UI says the cost cannot be verified. Do not substitute a fallback price to make the number appear.

### The platform fee is compile-time

`PLATFORM_FEE_BPS` in `config.ts`, default `0`, hard ceiling `MAX_PLATFORM_FEE_BPS = 100`, throws at module load if out of range. It is **not** settable at runtime, and specifically not via the embed's data attributes — a fee a host page can set is a fee a user cannot verify by reading the source. The routing API key *is* runtime-settable; the fee is not. That asymmetry is deliberate.

The fee is displayed on every quote whether it is zero or not. If the app is configured to charge but the router does not report taking a fee, the ledger warns about the discrepancy rather than displaying the configured number as if charged.

### The embed uses shadow DOM

`embed.tsx` renders into a shadow root and rewrites `:root` → `:host` in the injected stylesheet. This is load-bearing, not tidiness: `styles.css` styles bare `section`, `button` and `input`, which would wreck any host page they escaped into. Verified against a host page using `!important` overrides on those exact selectors.

### Deprecated chains are excluded from the registry

A deprecated chain ID may have been reassigned. Routing money through an ambiguous chain ID is a replay-attack surface. `build-chain-registry.mjs` drops them, and drops RPC URLs containing unfilled `${API_KEY}` placeholders.

---

## 5. Running it

```bash
cd app
npm install

npm run dev          # standalone app on Vite's dev server
npm test             # 14 ledger tests
npm run typecheck
npm run build        # standalone SPA  → dist/
npm run build:embed  # drop-in widget  → dist-embed/clearswap.js
npm run build:all
```

Optional `app/.env`: `VITE_ROUTER_API_KEY=...` (lifts LI.FI public rate limits).

Requires an EIP-1193 browser wallet. Discovery is via EIP-6963, so multiple installed wallets are listed rather than whichever won the race to `window.ethereum`.

### The chain registry

`scripts/build-chain-registry.mjs` runs before every build and resolves its data source in order:

1. `$CHAINS_DATA_DIR`
2. `../_data/chains` — a sibling checkout, which is how it resolves inside this repo
3. `vendor/chains.core.json` — committed snapshot, always present

With the dataset: 2,344 chains. With only the snapshot: 29. The fallback costs the long tail, not correctness — trading works on every routable network either way; the app just knows fewer obscure ones for explorer links and `wallet_addEthereumChain`. The snapshot self-refreshes whenever a real dataset is present, so it cannot drift far.

Output goes to `src/generated/` which is gitignored.

---

## 6. Outstanding work, in priority order

### Before real money touches it

1. **Validate the live API contract.** Capture a real `/v1/quote` response; diff against `fees.test.ts` fixtures; fix `router.ts` types and `fees.ts` field handling if they differ.
2. **Execute a tiny trade on a cheap chain.** Confirm approval, swap, and receipt. Then a small cross-chain one, confirming `/v1/status` polling terminates correctly on both DONE and FAILED.
3. **Decide the fee.** `PLATFORM_FEE_BPS` is `0`. If it should not be, set it and `PLATFORM_FEE_RECIPIENT` together — the app throws at load if a fee is set without a recipient.

### The four differentiators (specified in `docs/proof-of-cost.html`, none built)

4. **Cost odometer** — lifetime total of what trading has cost this wallet, broken out by gas / spread / bridge / platform. Needs local persistence of receipts. *Days.*
5. **Comparative pricing** — "this trade would cost $X on a flat-0.5% venue". Pure arithmetic on numbers already in hand. *Days.*
6. **Exportable receipts** — CSV/JSON with tx hashes, itemised costs, cost basis. *Days.*
7. **Execution scoring** — grade routers on how often quotes hold, using estimated-vs-actual already captured in `TradeReceipt`. *Weeks.*

### Feature parity gaps versus the competitor

8. Limit orders (*weeks*), social/copytrading (*needs a backend*), embedded wallet + email signup (*needs a provider account*), card funding (*needs an on-ramp partner and KYC*), gasless swaps (*needs a funded paymaster*), Solana support (*different stack — viem is EVM-only; the ledger's fee model would need rework for Solana's fee structure*).

---

## 7. The MAKIAI.app integration — not started

**Nothing was built against MAKIAI.app, and nothing was guessed at.** That session could reach only `wiirred/chains` and `wiirred/solana-copy-trader` (the latter explicitly out of scope per the user). No MAKIAI.app project, no `.env`, and no uploaded app files existed anywhere in the container; `/mnt/attach` was empty.

What the user stated about it:

- Built from **a combination of Python and JavaScript scripts**. Exact framework unknown.
- **One codebase, two builds** — the app and the website are updated together.
- It has an **`.env` already configured**, pointing at a server.
- The trading interface should become **a whole new page** on it, connected to the "Maki universe".

Because the framework is unknown, `src/embed.tsx` was built specifically for this: one self-contained file that mounts into any page with no bundler, npm install, or framework agreement on the host side.

```html
<div data-clearswap></div>
<script src="/static/clearswap.js"></script>
```

That is the recommended integration path until someone can actually see the codebase. Since it is one file consumed by one codebase, both builds pick it up from the same place.

**Open questions for whoever gets access:**

- Is the Python side serving templates (Flask/Django/FastAPI + Jinja), or is it an API behind a JS frontend? Templates → the embed is the answer. JS frontend → consider importing the components directly instead.
- Should the router API key come from the existing `.env` (recommended — one place for secrets) or stay self-contained?
- Where does the Maki brand layer sit? `styles.css` is a single token block at the top; retheming is a palette swap, not a rewrite.
- Does the Python backend get used for the "public cost index" in `docs/proof-of-cost.html` phase 2? They already have a server, which is the expensive prerequisite.

**Do not ask the user to paste `.env` contents.** Variable *names* and the service they point at are enough to write against.

---

## 8. Things the user has been told, so stay consistent

- The FOMO competitor analysis is based on **secondary sources only** — every primary source was blocked, and most pages ranking for FOMO reviews are affiliate-funded. It is labelled a hypothesis to verify, and should stay labelled that way until someone checks it with real access.
- The recommendation on the crypto project is to **ship three phases with no token at all** (receipts → public cost index → cost-aware routing), and only introduce a token if the index becomes something people rely on and lying about it becomes worth someone's money.
- The recommendation on Maki is to **keep the lore out of the token's value accrual**. Brand and community, yes; anything a user must understand to know what a trade costs them, no.

---

## 9. Commits on this branch

```
196ad7d  Add a drop-in embed build for a non-JS host
92a170a  Let the app build outside this repository
a26f370  Add the FOMO gap analysis and durable-utility strategy
2cf8d89  Make bridging a setting the user controls
bea050c  Add Clearswap: a trading interface with a fee ledger that balances
```

Each message explains the reasoning, not just the change. Read `bea050c` for the founding rationale.
