# Fire the CEO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution note for this repo:** per the user's global CLAUDE.md, hands-on implementation is delegated to Codex (codex-first skill); Claude specs, reviews, and verifies. Phase C5 (design pass) and Phase D (deploy/ops) stay Claude-side.

**Goal:** Ship Robin Hanson's fire-the-CEO decision markets on Sepolia with a public ranking of the top-100 US companies at https://ceo.futarchy.fi.

**Architecture:** One purpose-built Solidity contract (`FireTheCEO`) holding all companies, each with three called-off-bet LMSR markets (OUT/STAY scalars + EXIT binary) collateralized in a faucet ERC-20 (`PlayUSD`); a static Vite/React site reading the chain directly plus a 30-min snapshot JSON for history; served from farol via Caddy + Cloudflare tunnel.

**Tech Stack:** Foundry (solc 0.8.24, solady), viem/wagmi v2 + RainbowKit, Vite + React + TS, systemd user timer + node for snapshots.

**Spec:** `docs/superpowers/specs/2026-07-16-fire-the-ceo-design.md` (read it first; it is the source of truth for mechanism semantics).

## Global Constraints

- Solidity 0.8.24; fixed-point via solady `FixedPointMathLib.expWad/lnWad`; all market math in 1e18 wads (`int256` internally, `WAD = 1e18`).
- Rounding must always favor the contract: buys round cost **up** (+`DUST`), sells round proceeds **down** (−`DUST`), claims round **down**; `DUST = 1e9` (1e-9 pUSD).
- Cash never leaves the contract between a trade and resolution (sell proceeds escrow) — this is the called-off-bet invariant; do not "optimize" it away.
- Per-market share cap: `|q| ≤ 1e27` (1e9 shares) to bound exp/ln domains; `b ≥ 1e18`.
- Markets enum order is load-bearing everywhere (contract, ABI, site, snapshots): `OUT=0, STAY=1, EXIT=2`. Side: `LONG=true, SHORT=false`.
- Prices in integer **cents** on-chain (`uint32`); `floor = spotCents/4`, `cap = spotCents*7/4`.
- First cycle: `horizon = 1790812740` (2026-09-30 23:59 UTC), `settleTime = 1793394000` (2026-10-30 21:00 UTC). Dispute window `172800` s.
- Operator/oracle/deployer = `0x693E3FB46Bb36eE43C702FE94f9463df0691b43d` (key in `/home/kelvin/futarchy/workspace/.env.codex` as `PRIVATE_KEY`; never print it).
- Sepolia RPC: `https://ethereum-sepolia-rpc.publicnode.com` (fallback `https://sepolia.drpc.org`).
- Repo root: `/home/kelvin/repos/futarchy-fi/fire-the-ceo`. Commit after every task (`git -c user.name=fire-the-ceo-fable -c user.email=fleet@futarchy.fi commit`).

---

## Phase A — Contracts (`contracts/`, Foundry)

### Task A1: Scaffold + PlayUSD

**Files:**
- Create: `contracts/foundry.toml`, `contracts/src/PlayUSD.sol`, `contracts/test/PlayUSD.t.sol`
- Deps: `cd contracts && forge init --no-git --force . && forge install vectorized/solady --no-git` (forge is at `/home/kelvin/.foundry/bin/forge`; delete default Counter files)

**Interfaces (Produces):**
```solidity
contract PlayUSD is ERC20 ("Play USD", "pUSD", 18), Ownable {
    uint256 public constant FAUCET_AMOUNT = 10_000e18;
    uint256 public constant FAUCET_COOLDOWN = 24 hours;
    mapping(address => uint256) public lastFaucet;
    function faucet() external;                    // mints FAUCET_AMOUNT to msg.sender, reverts `CooldownActive()` within 24h
    function mint(address to, uint256 amt) external onlyOwner;
}
```
Use solady ERC20 + Ownable. Constructor sets owner = msg.sender.

- [x] **Step 1:** Write `contracts/test/PlayUSD.t.sol`: tests `test_FaucetMints10k`, `test_FaucetRevertsWithin24h`, `test_FaucetAgainAfter24h` (use `vm.warp`), `test_OwnerMint`, `test_MintNotOwnerReverts`.
- [x] **Step 2:** `forge test` → fails (no contract).
- [x] **Step 3:** Implement `PlayUSD.sol`.
- [x] **Step 4:** `forge test` → all pass. `forge fmt`.
- [x] **Step 5:** Commit `feat(contracts): PlayUSD faucet collateral`.

### Task A2: LMSR library

**Files:**
- Create: `contracts/src/LMSR.sol`, `contracts/test/LMSR.t.sol`

**Interfaces (Produces):**
```solidity
library LMSR {
    int256 constant WAD = 1e18;
    // b, q in wads. All pure. Revert-free within domain |q|<=1e27, b>=1e18.
    function cost(int256 qL, int256 qS, int256 b) internal pure returns (int256);
    // C(q) = m + b*ln(exp((qL-m)/b) + exp((qS-m)/b)), m = max(qL,qS)  [log-sum-exp, exp args <= 0]
    function priceL(int256 qL, int256 qS, int256 b) internal pure returns (uint256); // in [0,1e18]
    function buyCost(int256 qL, int256 qS, int256 b, int256 dq, bool onL) internal pure returns (int256);  // cost(q+dq)-cost(q)
    function initialQ(int256 b, uint256 p0Wad) internal pure returns (int256 qL0);   // b*(ln(p0)-ln(1-p0))/WAD, qS0=0
    function worstCaseLoss(int256 qL, int256 qS, int256 b) internal pure returns (uint256); // cost(q) - min(qL,qS)
}
```
Reference implementation of `cost`:
```solidity
function cost(int256 qL, int256 qS, int256 b) internal pure returns (int256) {
    int256 m = qL > qS ? qL : qS;
    int256 eL = FixedPointMathLib.expWad(((qL - m) * WAD) / b);
    int256 eS = FixedPointMathLib.expWad(((qS - m) * WAD) / b);
    return m + (b * FixedPointMathLib.lnWad(eL + eS)) / WAD;
}
```

- [x] **Step 1:** Tests with reference values (compute expected with Python `mpmath`, tolerance 1e-9 relative): `test_CostSymmetricZero` (`cost(0,0,b) == b*ln2 ±tol`), `test_PriceHalfAtZero`, `test_PriceMatchesSigmoid` (q=(2000e18,-1000e18), b=5000e18 → pL=sigmoid(3000/5000)=0.645656…), `test_BuyCostPositive_SellNegative`, `test_InitialQGivesP0` (p0=0.05 → priceL(initialQ(b,0.05),0,b)≈0.05), `test_WorstCaseLoss_EvenPrior` (=b*ln2), `test_WorstCaseLoss_SkewedPrior` (p0=0.05 → ≈ b*ln(1/0.05) on the improbable side: worstCaseLoss(initialQ(b,5e16),0,b) ≈ b*2.9957…), fuzz `testFuzz_CostMonotoneInQ`, fuzz `testFuzz_DomainNoRevert` (|q|≤1e27, 1e18≤b≤1e24).
- [x] **Step 2:** `forge test --match-contract LMSR` fails.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Tests pass.
- [x] **Step 5:** Commit `feat(contracts): LMSR fixed-point library`.

### Task A3: FireTheCEO storage + listing + views

**Files:**
- Create: `contracts/src/FireTheCEO.sol`, `contracts/test/FireTheCEO.listing.t.sol`

**Interfaces (Produces — later tasks and the site depend on these exact signatures):**
```solidity
contract FireTheCEO is Ownable {
    enum MarketKind { Out, Stay, Exit }
    struct Market { int128 qL; int128 qS; uint128 b; }
    struct Company {
        string ticker; string name; string ceo;
        uint32 spotCents; uint32 floorCents; uint32 capCents;
        uint64 horizon; uint64 settleTime;
        bool resolved; bool fired; uint32 settledPriceCents; uint64 resolvedAt;
        string resolutionURI;
    }
    struct Pos { uint128 sharesL; uint128 sharesS; uint128 paidIn; uint128 escrow; }

    IERC20 public immutable pusd;
    address public oracle;                 // = owner initially; setOracle(address) onlyOwner
    uint64 public constant DISPUTE_WINDOW = 172800;
    uint256 public constant DUST = 1e9;

    Company[] public companies;            // index = companyId
    mapping(uint256 => Market[3]) internal markets_;
    mapping(uint256 => mapping(uint8 => mapping(address => Pos))) public positions;

    event CompanyListed(uint256 indexed companyId, string ticker, string ceo, uint256 subsidy);
    event Trade(uint256 indexed companyId, uint8 indexed kind, address indexed trader,
                bool isBuy, bool longSide, uint256 shares, uint256 amount); // amount = cost or escrowed proceeds
    event Resolved(uint256 indexed companyId, bool fired, uint32 priceCents, string sourceURI);
    event Claimed(uint256 indexed companyId, address indexed trader, uint256 amount);

    function listCompany(string ticker, string name, string ceo, uint32 spotCents,
                         uint64 horizon, uint64 settleTime,
                         uint128 bScalar, uint128 bExit, uint256 initExitProbWad)
        external onlyOwner returns (uint256 companyId);
    // floor=spotCents/4, cap=spotCents*7/4. OUT/STAY q=(0,0,bScalar); EXIT qL=LMSR.initialQ(bExit, initExitProbWad).
    // subsidy = Σ worstCaseLoss over 3 markets, +DUST each, rounded up; transferFrom(msg.sender).

    function companyCount() external view returns (uint256);
    function getMarkets(uint256 companyId) external view returns (Market[3] memory);
    function getAllPrices() external view returns (uint256[] memory midOut, uint256[] memory midStay,
                                                   uint256[] memory pExit, uint8[] memory state);
    // state: 0=trading, 1=awaiting resolution (>=horizon), 2=resolved-disputable, 3=claimable
    function quoteBuy(uint256 companyId, MarketKind kind, bool longSide, uint256 shares) external view returns (uint256 cost);
    function quoteSell(uint256 companyId, MarketKind kind, bool longSide, uint256 shares) external view returns (uint256 proceeds);
}
```

- [x] **Step 1:** Tests: `test_ListStoresCompanyAndBands` (spot 40000¢ → floor 10000, cap 70000), `test_ListPullsExactSubsidy` (even priors: `2*(bScalar*ln2)+bExit*ln2` ±(3*DUST+tol) — assert via `pusd.balanceOf`), `test_ListSkewedPriorSubsidyHigher` (initExitProb=0.05 → subsidy component ≈ bExit*2.9957), `test_ExitOpensAtPrior` (`getAllPrices()[2][id]` ≈ 5e16), `test_ScalarsOpenAtHalf`, `test_ListNotOwnerReverts`, `test_QuoteBuyMatchesLMSR`.
- [x] **Step 2:** fails → **Step 3:** implement → **Step 4:** pass, `forge fmt` → **Step 5:** commit `feat(contracts): FireTheCEO listing + board views`.

### Task A4: Trading (buy/sell with escrow)

**Files:**
- Modify: `contracts/src/FireTheCEO.sol`
- Create: `contracts/test/FireTheCEO.trading.t.sol`

**Interfaces (Produces):**
```solidity
function buy(uint256 companyId, MarketKind kind, bool longSide, uint256 shares, uint256 maxCost) external returns (uint256 cost);
function sell(uint256 companyId, MarketKind kind, bool longSide, uint256 shares, uint256 minProceeds) external returns (uint256 proceeds);
// buy: require now < horizon; cost = uint(buyCost(...)) + DUST; require cost <= maxCost; transferFrom; paidIn += cost; shares += ; q += .
// sell: require held shares; proceeds = uint(-buyCost(..., -dq)) - DUST (floor at 0); require >= minProceeds; escrow += proceeds; NO transfer out.
```

- [ ] **Step 1:** Tests: `test_BuyMovesPriceUpAndChargesQuote`, `test_BuyRevertsOverMaxCost`, `test_SellEscrowsNoTransfer` (trader pUSD balance unchanged by sell; escrow increases), `test_SellMoreThanHeldReverts`, `test_BuyAfterHorizonReverts` (vm.warp), `test_RoundTripCostsAtLeastTwoDust` (buy then sell same shares → paidIn − escrow ≥ 2*DUST), `test_ShareCapEnforced` (buy pushing q past 1e27 reverts `ShareCapExceeded()`), `test_TradeEventEmitted`.
- [ ] **Steps 2-5:** fail → implement → pass → commit `feat(contracts): trading with called-off-bet escrow`.

### Task A5: Resolution, dispute, claim

**Files:**
- Modify: `contracts/src/FireTheCEO.sol`
- Create: `contracts/test/FireTheCEO.resolution.t.sol`

**Interfaces (Produces):**
```solidity
function resolveCompany(uint256 companyId, bool fired, uint32 priceCents, string calldata sourceURI) external; // oracle only, now >= settleTime; re-callable until resolvedAt + DISPUTE_WINDOW
function claim(uint256 companyId) external returns (uint256 amount);  // now > resolvedAt + DISPUTE_WINDOW
// settlement wWad = clamp((priceCents-floor)*WAD/(cap-floor), 0, WAD)
// OUT valid iff fired; STAY valid iff !fired; EXIT always valid with w = fired?WAD:0
// valid market entitlement  = escrow + sharesL*w/WAD + sharesS*(WAD-w)/WAD   (floor division)
// void market entitlement   = paidIn
// claim sums 3 markets, zeroes Pos, single transfer.
```

- [ ] **Step 1:** Tests: `test_ResolveOnlyOracle`, `test_ResolveBeforeSettleReverts`, `test_ReResolveWithinWindow` (flip fired, second resolve wins), `test_ReResolveAfterWindowReverts`, `test_ClaimBeforeWindowEndsReverts`, `test_ClaimFiredPath` (buyer of OUT-LONG gets w-share; STAY buyer refunded paidIn exactly), `test_ClaimRetainedPath` (mirror), `test_ClaimExitBinaryPayout`, `test_SellerEscrowPaidOnValid_CancelledOnVoid` (void: seller gets paidIn back, escrow zeroed), `test_ClaimTwiceZero`, `test_SettlementClampsBelowFloorAboveCap`.
- [ ] **Steps 2-5:** fail → implement → pass → commit `feat(contracts): resolution + dispute window + claims`.

### Task A6: Solvency invariant + fuzz suite

**Files:**
- Create: `contracts/test/FireTheCEO.invariants.t.sol`

- [ ] **Step 1:** Foundry invariant test: handler with 6 actors doing random faucet/buy/sell across 3 companies (one skewed EXIT prior 0.05, one 0.95, one 0.04); invariant: for every scenario in {fired, !fired} × priceCents in {0, floor, spot, cap, 2*cap}: `Σ_traders Σ_markets entitlement(scenario) ≤ pusd.balanceOf(contract)` (expose an external simulation helper or compute in the test via getters). Second invariant: `paidIn_total − escrow_total ≥ 0` per market.
- [ ] **Step 2:** `forge test --match-contract Invariant -vv` with `[invariant] runs=64, depth=128` in foundry.toml → must pass.
- [ ] **Step 3:** Commit `test(contracts): solvency invariants under random trading`.

### Task A7: Deploy + listing + seed scripts

**Files:**
- Create: `contracts/script/Deploy.s.sol` (deploys PlayUSD then FireTheCEO(pusd), mints 2,000,000 pUSD to operator, approves FireTheCEO),
  `contracts/script/ListCompanies.s.sol` (reads `data/listings.json` via `vm.readFile`/`vm.parseJson`: array of {ticker,name,ceo,spotCents,initExitProbWad}; lists each with global horizon/settle/b constants; idempotent: skips tickers already listed by scanning `companies`),
  `contracts/script/SeedTrades.s.sol` (reads `data/seed-trades.json`: {ticker, kind, longSide, shares}; faucet+buys from the broadcast key),
  `contracts/script/Resolve.s.sol` (env-driven single resolve for the TEST rehearsal).
- [ ] **Step 1:** Local rehearsal: `anvil` fork-less; run Deploy + a 3-company listings fixture + seeds against `--fork-url http://localhost:8545`; assert board via `cast call getAllPrices`.
- [ ] **Step 2:** Commit `feat(contracts): deploy/list/seed/resolve scripts`.

## Phase B — Sepolia deployment (Claude-side)

### Task B1: Deploy + verify
- [ ] `source /home/kelvin/futarchy/workspace/.env.codex; forge script Deploy --rpc-url $SEPOLIA_RPC --broadcast --private-key $PRIVATE_KEY` (RPC from Global Constraints). Record addresses into `data/deployment.json` `{chainId:11155111, pusd, fireTheCeo, deployBlock}`.
- [ ] Verify on Etherscan if `ETHERSCAN_API_KEY` findable on box, else `forge verify-contract --verifier sourcify`.
- [ ] Commit.

### Task B2: TEST-company lifecycle rehearsal on Sepolia
- [ ] List `TEST` company (horizon = now+30min, settle = now+40min, tiny b=1e18·200); buy OUT-LONG + EXIT-LONG; sell part (escrow visible); wait past settle (Monitor until-loop); `resolveCompany(TEST, fired=true, priceCents=cap+1, "rehearsal")`; wait dispute window? — NO: for rehearsal only, deploy uses `DISPUTE_WINDOW` const; instead rehearse claim-gating by asserting claim reverts pre-window, then (since 48h is too long) assert entitlement views correct and leave TEST unclaimed. Record tx hashes in `docs/rehearsal.md`.
- [ ] Commit `docs: sepolia rehearsal evidence`.

### Task B3: Curate listings + list 100 + seed
- [ ] Build `data/listings.json` from `data/companies-raw.json`: spotCents = round(share_price_usd*100); initExitProbWad: default 4e16; 95e16 where transition announced (AAPL); 8e16–15e16 where note indicates succession watch/activist pressure (curated by hand, documented in the JSON as `prior_rationale`).
- [ ] Run ListCompanies (batched ~10/tx-run, resumable); verify `companyCount()==101` (incl. TEST) and spot-check 5 boards vs dataset.
- [ ] Curate `data/seed-trades.json` (~15 trades with rationale strings sourced from dataset notes) and run SeedTrades; verify premiums moved only where seeded.
- [ ] Commit `feat(data): 100 listings + seed trades live on sepolia`.

## Phase C — Site (`site/`)

### Task C1: Scaffold + chain plumbing
**Files:** `site/` via `bun create vite site --template react-ts`; add `wagmi viem @rainbow-me/rainbowkit @tanstack/react-query`.
**Produces (site-wide contracts):**
```ts
// site/src/lib/config.ts
export const CHAIN = sepolia; export const RPCS = ['https://ethereum-sepolia-rpc.publicnode.com','https://sepolia.drpc.org'];
export const ADDR = deploymentJson;         // data/deployment.json imported
// site/src/lib/board.ts
export type BoardRow = { id:number; ticker:string; name:string; ceo:string; ceoSince:string; sector:string;
  mcapB:number; spot:number; midOut:number; midStay:number; pExit:number; premium:number;  // premium = (EOut-EStay)/spot
  eOut:number; eStay:number; state:number; note?:string };
export function useBoard(): { rows: BoardRow[]|null; error?: Error }   // getAllPrices multiread + companies.json join, refresh 30s
export function useHistory(): HistorySnapshot[]|null                    // fetch('/data/history.json')
export function fireSignal(rows: HistorySnapshot[], id:number): 'FIRE'|'KEEP'|'WATCH'  // Hanson rule: premium>0 in >=90% of snapshots over trailing 7d (WATCH if <20 snapshots)
```
- [ ] Scaffold, wire RainbowKit (Sepolia only), implement useBoard against deployed contract, render raw table smoke page. `bun run build` passes. Commit.

### Task C2: The Board (`/`)
- [ ] `BoardTable`: rank, company+CEO(tenure), P(exit), E[P|out], E[P|stay], premium% (signed, colored), `SignalBadge` (FIRE/KEEP/WATCH), 7d `PremiumSparkline` (from history), mcap. Sort by any column (default premium desc); text filter. Loading skeleton; error state with RPC retry. Commit.

### Task C3: Company page (`/company/:ticker`)
- [ ] Three `MarketCard`s (OUT/STAY scalars showing implied E[P] + band; EXIT prob), premium history line chart, `TradePanel` (kind/side/shares → live `quoteBuy/quoteSell` debounced, slippage 1%, approve-then-trade flow, trading-closed state), `PositionsCard` (per-market sharesL/S, paidIn, escrow; claim button when claimable), resolution criteria + subsidy figure ("This market is subsidized with X pUSD via LMSR"), CEO context note + source link. Commit.

### Task C4: About + faucet + first-run
- [ ] `/about`: Hanson's vision w/ citations (use URLs from sweep report §hanson-vision), called-off-bet explainer, decision rule verbatim, insider policy, seed-trade disclosure table, testnet disclaimer. `FaucetBanner`: detect no-pUSD wallet → guided add-Sepolia + faucet() + approve flow. Commit.

### Task C5 (Claude-side): Design pass
- [ ] Invoke `frontend-design` + `dataviz` skills; apply the "boardroom terminal" direction from the spec across all pages; validate palette; dark+light. Commit.

## Phase D — Ops + launch (Claude-side)

### Task D1: Snapshot pipeline
- [ ] `ops/snapshot.mjs` (node+viem): read getAllPrices → append full row to `ops/archive.jsonl`; rewrite `site/public/data/history.json` = hourly downsample, trailing 168 points, 4dp. `ops/ceo-snapshot.service`+`.timer` (30min, `systemctl --user`, farol). Two clean runs observed. Commit.
### Task D2: Serve + DNS
- [ ] Build site → rsync `site/dist/` → `/home/kelvin/fleet/apps/ceo/dist`; Caddy block `http://ceo.futarchy.fi:8080` (sharpe pattern, immutable /assets, index revalidate); `caddy validate` + reload; tunnel ingress via CF API PUT configurations (hostname `ceo.futarchy.fi` → `http://127.0.0.1:8080`, httpHostHeader, before 404 catch-all); DNS CNAME `ceo` → `8e5ae8e1-42db-4dbd-86e7-cefb1f78251f.cfargotunnel.com` proxied in zone `3208f9fbe42ffc575f5fb9f0c7c70646`. Fallback: CF Pages via wrangler.
### Task D3: Verify public surface
- [ ] `curl -s https://ceo.futarchy.fi | grep -i "fire the ceo"`; headless chromium: board renders 100 rows, a quote matches `cast call quoteBuy`; snapshot timer green; trade from a second throwaway key through the site's write path (or cast if wallet automation flaky) confirmed on-chain.
### Task D4: Publish + handoff
- [ ] Push repo to `github.com/futarchy-fi/fire-the-ceo` (if org perms allow; else report), README with addresses + runbook, memory file update, final report to user.

## Self-review notes
- Spec §2 called-off semantics → A4/A5; §2 solvency → A6; §3 params → Global Constraints; §4 data → D1/C1; §5 routes → C2-C4; §6 policy text → C4; §7 deploy → D2; §8 seeds → B3; §10 verification → B2/D3. Gap check: spec's `getPositions(trader, companyId)` = `positions` public mapping getter (C3 uses it) — covered. Types cross-checked: `MarketKind` enum order OUT/STAY/EXIT consistent in A3/C1/D1.
