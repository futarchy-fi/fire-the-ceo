# Fire the CEO — ceo.futarchy.fi — Design

**Date:** 2026-07-16 · **Author:** fire-the-ceo-fable (autonomous, all decisions delegated by Kelvin)
**Status:** Approved for implementation (user delegated design authority; brainstorming run solo)

## 1. What this is

Robin Hanson's fire-the-CEO decision markets, built as a full working product on Sepolia
testnet and served at **https://ceo.futarchy.fi**: for each of the top 100 US public
companies, a standing pair of *called-off conditional markets* on company value — one
conditional on the sitting CEO leaving by quarter end, one conditional on them staying —
plus a probability market on the departure itself. The headline surface is the thing
Hanson has asked for for 30 years and nobody built: **a public ranking of all companies by
their market-estimated "fire premium"** (how much more the company would be worth without
its current CEO).

### Hanson-fidelity map (his requirements → product features)

| Hanson requirement (primary sources) | This product |
|---|---|
| Pair of conditional value markets, trades "called off (null and void)" if condition fails | OUT/STAY scalar markets with exact called-off-bet semantics (escrowed proceeds, full paid-in refund on void) |
| Real subsidies / subsidized market maker — he invented LMSR for this | Every market is an LMSR AMM funded with an explicit, displayed subsidy |
| Pre-announced decision rule over a measurement window | His canonical OldTek rule rendered verbatim: FIRE signal iff premium > 0 for ≥90% of snapshots in the last 7 days before quarter end |
| Insiders allowed and encouraged; CEO trades disclosed | Insider policy page; testnet = pseudonymous wallets, policy documented for the real version |
| Decision linkage / advisory board use with track record | "Memo to the board" framing per company; track-record page after first cycle resolves |
| Rank all public companies | Top-100 US by market cap at launch (dataset researched + independently verified July 2026); listing process scales |

### Lineage

Two real fire-the-CEO markets already shipped on Ethereum mainnet via the Seer-fork
FutarchyFactory `0xf9369c0F7a84CAC3b7Ef78c837cF7313309D3678` (TSLA CEO Award, resolved;
SBUX Niccol exit, hidden/never launched — both TSLAON/SBUXON Ondo tokenized stock + USDS).
A mock ranking page has been live at futarchy.fi/fire-the-ceo since Apr 2025. This product
is the real, standing, cross-company version, redesigned per the delegation to redesign.

## 2. Mechanism

Per company `i` with sitting CEO `c` pinned at listing, horizon `T` (quarter end), and
settlement read `S` (one month after `T`, letting post-decision information settle):

- **Band:** `floor = 0.25 × spot_listing`, `cap = 1.75 × spot_listing` (integer cents).
  Settlement value `w = clamp((P_S − floor)/(cap − floor), 0, 1)` where `P_S` = share
  price at `S` (split/dividend-adjusted; corporate-action policy in §6).
- **Market OUT** (scalar): LONG pays `w` pUSD/share, SHORT pays `1−w`, **valid iff the
  departure condition is true**; otherwise void → every trader reclaims exactly their
  paid-in cash.
- **Market STAY** (scalar): same payoff, valid iff the departure condition is false.
- **Market EXIT** (binary): LONG pays 1 pUSD iff departure, SHORT otherwise. Never voids.
- **Departure condition:** on or before `T`, company `i`'s CEO office ceases to be held by
  `c`, or the company publicly and irrevocably announces that `c` will cease to hold it
  (termination, resignation, retirement, death, announced transition with named successor
  or interim). Matches the SBUX-market precedent wording.
- **Fire premium** `= (E[P|OUT] − E[P|STAY]) / spot_listing`, where `E[P|·] = floor +
  mid(·)·(cap − floor)` from LMSR mids. Ranking sorts on this.

### AMM: called-off-bet LMSR

Each market is an independent two-outcome LMSR with cost `C(q) = b·ln(e^{q_L/b} +
e^{q_S/b})` (log-sum-exp with max-subtraction; solady `expWad`/`lnWad`).

- **Buys** transfer pUSD in (`paidIn += cost`, rounded up).
- **Sells** credit proceeds to per-trader **escrow** (rounded down); cash never leaves the
  contract before resolution. This is what makes trades genuinely *callable-off*.
- **Valid resolution:** trader claims `escrow + sharesL·w + sharesS·(1−w)`.
- **Void:** trader claims `paidIn` (full refund); shares and escrow cancel.
- **Solvency:** funded subsidy per market = worst-case MM loss `C(q₀) − min(q₀_L, q₀_S)`
  (`= b·ln 2` for even priors, `b·ln(1/min p₀)` for skewed priors), computed and required
  on-chain at listing. Void path holds because cash never exits pre-resolution:
  contract ≥ Σ paidIn always. Verified by randomized simulation (2,000 trials, zero
  shortfall at extreme settlements and on void); Foundry fuzz/invariant tests will re-prove
  including skewed `q₀` and rounding.
- **Priors:** scalar markets open at mid 0.5 → implied `E[P] = spot`, premium 0 (symmetric
  band makes this exact). EXIT opens at a listing prior (default 4%/quarter base rate;
  raised where a transition is already announced, e.g. AAPL→Ternus effective 2026-09-01 ⇒
  prior ≈ 0.95 — an intentional live demonstration of a near-certain condition).

Positions are internal contract balances (not ERC-20s): all trading happens against the
subsidized LMSR — which is the point of the design. *ponytail: skipped token wrappers;
add ERC-1155 wrapping only if composability is ever requested.*

## 3. Contracts (Foundry, Sepolia)

`contracts/src/PlayUSD.sol` — ERC-20 `pUSD` (18 dec). `faucet()` mints 10,000 pUSD per
address per 24 h; owner can mint arbitrarily (subsidies, seeding).

`contracts/src/FireTheCEO.sol` — the whole exchange in one contract:

- `listCompany(ticker, name, ceo, spotCents, horizon, settleTime, bScalar, bExit, initExitProbWad)`
  (owner): stores company, initializes 3 markets, pulls exact subsidy in pUSD.
- `buy(companyId, market, side, shares, maxCost)` / `sell(companyId, market, side, shares, minProceeds)`
  — LMSR-priced, slippage-guarded; selling requires held shares (no naked shorts; the
  SHORT side exists for that). Trading closes at `T` for all three markets (conditions
  become knowable between `T` and `S`).
- `resolveCompany(companyId, fired, priceCents, sourceURI)` (oracle role; = operator on
  testnet) after
  `settleTime`; 48 h dispute window during which the oracle may re-resolve; `claim(companyId)`
  opens after the window. Oracle is a swappable address — a Reality.eth v3 adapter
  (deployed on Sepolia at `0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA`) can slot in later.
  *ponytail: operator oracle + dispute window; upgrade path documented, not built.*
- Views: `quoteBuy/quoteSell`, `getCompany`, `getAllPrices()` (entire board in one
  `eth_call`), `getPositions(trader, companyId)`.
- Events: `CompanyListed`, `Trade`, `Resolved`, `Claimed` — enough to rebuild any history.

Parameters: `bScalar = 5_000e18` (subsidy ≈ 3,466 pUSD/market), `bExit = 2_000e18`
(subsidy ≤ ~6.4k pUSD at skewed priors). ~101 listings ≈ 1.4 M pUSD subsidy total, minted
to operator. Gas ≈ 80 M total, ~0.12 ETH of the operator key's 1.42 sepETH
(`0x693E3FB46Bb36eE43C702FE94f9463df0691b43d`).

First cycle: listing now → `T = 2026-09-30 23:59 UTC`, `S = 2026-10-30 21:00 UTC`
(US market close). A `TEST` company with `T` ≈ +2 h is listed first and taken through the
full lifecycle (trade → resolve → dispute window → claim) on-chain before real listings.

## 4. Data plane

No indexer. (Sweep verdict: the Checkpoint/charts stack is Gnosis-hardwired,
proposal-centric, operationally fragile; strictly more work than needed.)

- **Live reads:** browser → Sepolia public RPCs (viem fallback transport,
  publicnode/drpc) → `getAllPrices()` multiread.
- **History:** `ops/snapshot.mjs` (node+viem) on a farol systemd **user timer** (30 min;
  crontab is reaped by fleet setup.sh — timers only) appends the board state to
  `site/dist/data/history.json` + writes `latest.json`. Sparklines and the Hanson
  decision-rule computation read history.json.
- **Company metadata** (sector, market cap, CEO tenure, note, sources):
  `data/companies.json` baked into the site. CEO names verified 2026-07 by an independent
  second-source cross-check, 100/100 confirmed.

## 5. Frontend (site/, Vite + React + TS + wagmi/viem + RainbowKit, static export)

Routes:
- `/` — **The Board**: all 100 companies ranked by fire premium; columns: rank, company +
  CEO (tenure), P(exit), E[P|out], E[P|stay], fire premium %, FIRE/KEEP signal badge
  (Hanson rule), 7-day premium sparkline, market cap. Sortable; search.
- `/company/:ticker` — the memo to the board: three markets with prices, premium history
  chart, trade panel (buy/sell with quote preview + slippage), positions + claim, the
  resolution criteria text, subsidy figure displayed (Hanson's complaint answered
  explicitly), CEO/tenure/context note with sources.
- `/about` — Hanson's vision with citations (his papers + posts), how called-off bets
  work, the decision rule, insider policy, testnet disclaimer, faucet.
- Faucet + wallet onboarding flow (Sepolia chain add, pUSD mint, first trade) as a
  first-run banner.

Design: `frontend-design` skill drives the aesthetic at build time (direction: austere
"boardroom terminal" — editorial serif display, tabular numerals, ink-on-paper with
disciplined red/green semantics; must not read as a template). Charts follow the `dataviz`
skill (sparklines, premium history, palette validator).

## 6. Resolution policy (published on /about verbatim)

- Departure condition as §2. Settlement price = official closing price on the settlement
  date from the primary exchange, adjusted for splits; extraordinary cash distributions
  and M&A: if shares cease trading before `S` (acquisition), `P_S` = final deal
  consideration per share; spin-offs add per-share value of distributed entities.
- Oracle = operator key on testnet, 48 h dispute window, all resolutions posted with a
  source link in the resolution tx calldata (string arg) and shown in UI.

## 7. Deployment

- **Contracts:** forge scripts from the operator key; Etherscan verification if an API key
  is available on box, else Sourcify, else post-hoc.
- **Site:** build → `/home/kelvin/fleet/apps/ceo/dist`; Caddy site block
  `http://ceo.futarchy.fi:8080` (sharpe pattern, public, no Access); tunnel ingress rule
  for `ceo.futarchy.fi` via CF API (remote-managed tunnel `8e5ae8e1-…`, inserted before
  the 404 catch-all); DNS CNAME `ceo` → `<tunnel>.cfargotunnel.com`, proxied, in the
  futarchy.fi zone (`3208f9fbe42ffc575f5fb9f0c7c70646`, same CF account as the tunnel).
  Fallback if cross-zone tunnel routing refuses: Cloudflare Pages via wrangler with the
  on-box Global API Key.
- **Verify public surface** (standing rule): `curl https://ceo.futarchy.fi` must return
  the expected marker before any "live" claim.

## 8. Seeding & launch state

After listing all companies: a small set of scripted seed trades from 2–3 labelled seed
wallets express *defensible, sourced* priors (e.g. long OUT where activist pressure is
public; the dataset note field drives this), so the launch board isn't uniformly zero.
Every seed trade is disclosed on /about (wallet addresses + rationale). No fake data
anywhere — every number on the board comes from the chain.

## 9. Explicitly skipped (ponytail ledger)

- ERC-20/1155 position tokens, Uniswap pools, CTF integration — LMSR-internal balances
  suffice; upgrade path documented.
- Reality.eth resolution — oracle slot exists; adapter when someone asks.
- Indexer/API service — direct RPC + snapshot JSON; revisit only if RPC reads become the
  bottleneck.
- Combinatorial (cross-company) markets — Hanson's combinatorial vision is real but v2;
  the repo's WIP framework is untested and unneeded for the ranking.
- Mainnet/tokenized-stock (Ondo) integration — the mainnet markets exist as precedent;
  this product is testnet by instruction.

## 10. Verification plan

1. Foundry: unit + fuzz + invariant tests (solvency: contract balance ≥ max claimable
   under every resolution × void combination; LMSR cost monotonicity; rounding direction).
2. TEST-company full lifecycle on Sepolia before real listings.
3. Seed-trade scripts assert expected price moves.
4. Live-site E2E: headless chromium loads ceo.futarchy.fi, board renders 100 rows from
   chain, a trade quote matches `quoteBuy` via cast.
5. `curl` marker check + snapshot timer runs twice cleanly before declaring done.
