# Canonical exchange spec (shared: ceo V2, relay, site, futarchy.fi PR)

Frozen 2026-07-17. All four implementations reference THIS file. Deviations require
editing this file first.

## Order (EIP-712) — Polymarket V1 shape, verbatim typehash

```
Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,
      uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,
      uint256 feeRateBps,uint8 side,uint8 signatureType)
```
- Domain: `name="FireTheCEO Exchange"` / `"Futarchy Exchange"`, `version="1"`, chainId,
  verifyingContract. SignatureType: `EOA=0`, `EIP1271=3` only (no proxy types).
- `side`: BUY=0 (maker gives collateral, receives tokenId), SELL=1 (inverse).
- Price = `makerAmount/takerAmount` ratio; partial fills must preserve the ratio
  (round in maker's favor). Per-order on-chain `OrderStatus {isFilledOrCancelled,
  remaining}` keyed by EIP-712 hash. `taker==0` ⇒ public order.
- Cancels: per-order `cancelOrder` (maker only) + `incrementNonce` global cancel +
  `expiration` timestamp. All placement/cancel-by-expiry is free/off-chain.
- Fees: `feeRateBps` is a signed MAXIMUM; charged fee ≤ max; testnet charge = 0.
  If ever nonzero: `baseRate · min(p, 1−p) · size` (mint/merge symmetry constraint).

## tokenId encoding

- **ceo (internal balances):** virtual id `tokenId = companyId·6 + kind·2 + (long?0:1)`,
  kind ∈ {OUT=0,STAY=1,EXIT=2}. Collateral = pUSD via ERC-20 allowance. Complement of
  tokenId flips the low bit. "Transfer" = internal Pos debit/credit.
- **futarchy.fi (wrapped ERC-20 outcome tokens):** a `Registry` maps
  `tokenId = uint256(uint160(tokenAddress))` and records its pair collateral token
  (e.g. YES_GNO ↔ YES_sDAI). Both legs move by ERC-20 `transferFrom` (allowances).

## Fill entrypoints — PERMISSIONLESS (no onlyOperator)

- `fillOrder(order, fillAmount)` — caller is taker, pays/receives directly.
- `matchOrders(takerOrder, makerOrders[], takerFillAmount, makerFillAmounts[])` —
  one-taker-vs-many-makers; price improvement accrues to the taker; every maker executes
  at its signed price or better; COMPLEMENTARY fill accounting must decrement BOTH sides
  (Quantstamp POL-EX-1).
- **ceo only — AMM leg:** `fillWithAmm(takerOrder-or-params, makerOrders[], ..., ammMaxShares)`:
  after book legs, route remainder to the LMSR (`dq = b·Δlogit` internal pricing);
  contract enforces blended execution ≤ taker limit. Trading gated by company horizon.
- Crossing paths (ceo): COMPLEMENTARY (shares maker↔taker; buyer cost→paidIn, seller
  proceeds→escrow), MINT (two BUYs: collect p+(1−p)=1 pUSD/pair→both paidIn, credit L/S),
  MERGE (two SELLs: debit L+S pair, credit 1 pUSD split→both escrows). Solvency: cash
  never leaves pre-resolution; escrow/void semantics identical to AMM trades.
- Crossing paths (futarchy.fi PR v1): COMPLEMENTARY ONLY (direct ERC-20 swap of the
  pool pair). MINT/MERGE deferred — futarchy proposals have dual collateral legs; noted
  as future work in the PR.

## Security checklist (from ChainSecurity 2022 + Quantstamp 2026 findings — tests required)

1. EOA path binds `maker == signer` (or signer explicitly authorized) — any-maker forgery
   was Critical #1. 2. Typehash string matches struct exactly. 3. `signature` excluded
   from hash. 4. Both-sides fill accounting on COMPLEMENTARY. 5. `nonReentrant` on all
   fill paths. 6. Pause switch (admin ≠ operator concept; no operator exists). 7. Fee ≤
   signed max, symmetric formula. 8. Partial-fill ratio rounding favors the resting maker.
   9. Fill after expiration/cancel/nonce-bump reverts. 10. ceo: fills respect horizon; no
   fill path can bypass share caps or Pos overflow checks.

## Relay protocol (informative)

REST: `POST /orders` (signed order; relay validates sig, balance/allowance, market open),
`GET /book?tokenId=`, `GET /orders?maker=`, `DELETE` is client-side (expiry/nonce).
WS: book deltas + fill events (mirrors on-chain OrderFilled). Relay is stateless w.r.t.
funds; anyone can run one; the contract is the only source of truth.
