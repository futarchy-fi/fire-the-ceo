# FireTheCEO V2 — Polymarket-style CLOB + decentralized data plane

**Status: proposal, synthesized 2026-07-17 from three verified research streams** (Polymarket
deep research: 102 agents, all claims 3-0 adversarially verified; The Graph network
assessment; live on-chain verification of Algebra pool oracles). Companion docs:
`limit-orders-design.md` (superseded by this for the book), `kleros-study.json`.

## 1. Trading: hybrid CLOB, Polymarket architecture, decentralized where they weren't

Off-chain signed orders + on-chain non-custodial settlement + the subsidized LMSR routable
in the same fill. We adopt Polymarket's **V1 order model, not their V2**: their 2026 V2
went *more* operator-centric (single `matchOrders` entrypoint, operator-supplied fee
amounts, nonces/expiration removed — Quantstamp: correctness is "a high-trust operational
assumption, not a low-trust on-chain guarantee"). We go the other way:

- **Order struct** (EIP-712, 12 fields, V1 shape): salt, maker, signer, taker(0=public),
  marketId (companyId·3+kind), makerAmount/takerAmount (price = the ratio; partial fills
  preserve it), expiration, nonce, feeRateBps, side, signatureType (EOA + EIP-1271 only —
  no proxy-wallet types; we have no proxy system and need none).
- **Permissionless fills.** Polymarket gates `fillOrder/matchOrders` to `onlyOperator`;
  we remove the gate. Anyone can take a resting order or submit a valid match. The relay
  becomes a convenience, not an authority.
- **Fully non-custodial resting orders — nothing escrowed at placement.** Buys: pUSD
  stays in the maker's wallet under ERC-20 allowance, pulled at fill (Polymarket's own
  trick). Sells: shares are internal balances already held by the contract — "allowance"
  is implicit; fill debits the maker's live position or skips. Placement and cancellation
  are free (sign; expire; nonce-bump for global cancel — kept from V1, plus per-order
  on-chain cancel).
- **Three crossing paths over internal balances**, preserving the called-off invariant:
  - COMPLEMENTARY (buy vs sell, same side-token): shares debit maker→credit taker;
    taker cost → `paidIn`; maker proceeds → **escrow** (exactly like an AMM sell).
  - MINT (two buys of L and S at complementary prices): collect `p + (1−p) = 1` pUSD per
    pair into the two makers' `paidIn`, credit L/S internal shares — fully backed.
  - MERGE (two sells): debit L+S pair, credit 1 pUSD split into the two sellers'
    **escrows**. Solvency invariant untouched: cash still never leaves before resolution.
- **AMM in the loop:** a taker fill is a bundle — book legs + an LMSR leg priced by the
  closed form `dq = b·Δlogit`; the contract enforces (a) every maker fills at its signed
  price or better, (b) the taker's blended execution respects the taker limit. Price
  improvement goes to the taker (Polymarket rule). The subsidized curve remains the
  always-on price floor; makers quote inside its spread.
- **Fees:** 0 on testnet (DUST only). If ever nonzero: `baseRate · min(p, 1−p) · size` —
  symmetry is forced by free mint/merge arbitrage, not a style choice.
- **Audit-derived test checklist** (ChainSecurity 2022: 2 critical, 1 high, 3 medium, all
  fixed pre-deploy; Quantstamp V2 2026): EOA signature must bind maker↔signer (critical
  #1 was any-maker orders); typehash must match the struct exactly; fee fields hashed;
  COMPLEMENTARY taker-fill accounting must decrement both sides (POL-EX-1); reentrancy
  guards on all fill paths; pause switch admin-gated and separate from operator role.
- **Off-chain layer, open-source, anyone-can-run:** a small relay (REST+WS store of
  signed orders, validates against chain state, serves the book) + an optional matcher
  bot. We run one of each on farol; the repo ships both with docker. Censorship has no
  teeth: self-submit your own fill on-chain, or trade the LMSR directly.

Also in V2 (per scope decision): the **fill-to-estimate slider** (Foresight-validated UX;
same `b·Δlogit` primitive) and **Robin's docket auction** (pay-to-propose liquidity:
~80% of fee → that market's `b`, baseline premium recorded at proposal, rewards
∝ payment × max(0, final time-averaged premium − baseline), reward capped relative to
`b` so sustaining a fake premium provably costs more than the reward).

## 2. Data plane: nothing self-run is load-bearing

Principle: put the data where any RPC can serve it.

**ceo.futarchy.fi (Sepolia):** The Graph's decentralized network does not meaningfully
serve Sepolia (studio-grade, rate-limited, single upgrade-indexer) — so the chain itself
becomes the indexer:
- V2 adds an **observations ring buffer per market** (Algebra-style: write-on-trade
  cumulative price observations) → any client reconstructs hourly/daily series from one
  `eth_call`. Chain-portable: works identically on Gnosis/mainnet later.
- **Fat indexed events** (Trade, OrderFilled, Listed, Resolved) → per-company history via
  bounded `eth_getLogs`; CLOB fills are on-chain events like everything else.
- The farol snapshot cron demotes to an optional cache/accelerator; the site must work
  with it dead.

**futarchy.fi (Gnosis):** two decentralized layers, both verified:
- **Price series with zero infrastructure, today:** Algebra pools carry an always-on
  65,536-slot timepoint oracle (verified live on the KIP-88 pools: ~29k timepoints, exact
  7-day daily TWAP series from a single `getTimepoints` call, no archive node; retention
  ~112 days at observed write rates — longer than any market lives).
- **Event history/candles/volumes:** a subgraph on **The Graph decentralized network**
  (Gnosis is first-class: multi-indexer, curation, rewards; Omen and Swapr are direct
  precedents). Costs: publish gas on Arbitrum + ~3,000 GRT self-signal + 100k free
  queries/mo then ~$2/100k. Retires the Checkpoint containers, 8 framework monkey-patches,
  reorg watchdog, and the charts API. Caveat managed: default gateway is Edge & Node —
  open-source, so run our own gateway or query indexers directly if it ever matters.

## 3. Build plan (V2)

1. Contracts: FireTheCEOv2 = V1 mechanism + exchange mixin (signatures, order status,
   three paths, AMM leg, permissionless fills) + observations buffer + docket auction.
   Audit-checklist test suite + extended solvency invariants (random signed-order fills
   interleaved with AMM trades and void resolutions).
2. Relay + matcher (open-source, docker, farol instances).
3. Site: book view + slider trade panel + scenario-grouped company pages (Kleros lessons)
   + charts from observations buffer.
4. Redeploy + relist + re-seed (idempotent scripts), repoint site, retire snapshot-as-source.
