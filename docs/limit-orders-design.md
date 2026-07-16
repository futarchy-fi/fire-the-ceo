# Limit orders for FireTheCEO — research synthesis & recommendation

**Status: proposal for discussion — not implemented.** Sources: platform survey (Manifold,
Polymarket CTF Exchange, Augur v2, Kalshi, Omen/Seer, Uniswap v3 range orders, Gelato/1inch),
LMSR mechanics analysis against our contracts, keeper-ops survey. Key claims adversarially
verified (fill-to-price math confirmed against `LMSR.sol` + our invariant suite; Manifold
mechanism confirmed against their source).

## Recommendation: resting orders inside the contract, filled permissionlessly against the LMSR

Manifold — the only production system layering limit orders on an AMM with internal
balances, exactly our shape — fills incoming trades against the book first, then the AMM.
We invert it into pure on-chain form: **orders rest in the contract; anyone may crank
`fill(orderId)` whenever the LMSR price crosses the limit.**

Mechanics (all closed-form, verified):
- Two-outcome LMSR price is `sigmoid((qL−qS)/b)`, so the exact size that moves the price
  to a limit `p*` is `dq = b·(logit(p*) − logit(p_now))`, and cost-to-limit is
  `b·ln((1−p_now)/(1−p*))` (buy-L). **Partial fills are natural**: each fill takes
  `min(remaining, b·|Δlogit|, escrow-affordable)`, contract-computed — the keeper never
  chooses amounts, so execution can never beat or breach the limit.
- **Buy orders escrow pUSD at placement** (`shares × limitPrice` upper bound, surplus
  refunded): safe — escrow is relabeled into `paidIn` atomically at fill, identical to a
  direct `buy()`; the called-off solvency invariant is untouched.
- **Sell orders are intents, not escrows.** `claim()` reads `Pos` only; shares parked in an
  order struct would be forfeited at resolution. Fill checks the seller's live balance;
  if the shares are gone the order is dead. (Race cost: a skipped fill. Acceptable.)
- **No order-vs-order matching engine needed**: LMSR path independence makes the AMM a
  free matching engine — numerically verified that crossed resting orders (buy@0.60,
  sell@0.55) ping-pong-fill through the AMM with **exactly zero AMM take**, both sides
  converging to the logit-average cross price. A CLOB would add hundreds of lines for ~0.
- **Post-horizon sweep is mandatory**: permissionless `expireOrders()` refunds buy escrows
  after trading closes (claim() doesn't know about orders).
- Keeper: our existing systemd/viem stack polling a `getExecutableOrders()` view (~40
  lines). Chainlink Automation sunset Sepolia support 2026-06-24; Gelato works free on
  testnet but adds an external dependency for nothing. Fills are permissionless, so the
  keeper is an executor, not a trust assumption. Keeper tip: bps of fill notional (flat
  tips are grindable).
- MEV: structurally immaterial here — execution is limit-bounded on-chain and an
  attacker's push-and-revert round trip nets exactly `−2·DUST − gas` by path independence.

## Rejected alternatives (and why)

| Option | Why not |
|---|---|
| Off-chain EIP-712 book + on-chain settle (Polymarket/Augur/1inch) | Buys gas-free placement + MEV-proofing — problems Sepolia doesn't have — at the cost of an operator server, nonce registry, and signature domain |
| Batch auctions | Clearing price is tractable (nice!) but epoch scheduling across 303 markets delays fills for benefits already delivered by limit-bounded fills |
| Uniswap-v3-style range orders | Need reversal-proof withdrawal keepers; our positions aren't LP-able anyway |
| UI-only "alerts" pseudo-limit orders | Requires the user online to execute; not a real resting order |

## Cost & the one open decision

~200 contract lines (orders array + place/cancel/fill/fillMany/expire + views), reusing
`_quoteBuy/_quoteSell/_checkedQ` so DUST/caps/overflow checks carry over; Foundry tests
(fill-at-limit exactness, partial-fill accounting, escrow refund on cancel/void/expiry,
solvency invariant extended with random resting orders); one UI card + keeper script.

**Positions are internal and there is no proxy — a periphery contract cannot do this.
Adding limit orders means redeploying FireTheCEO (V2) and relisting.** Cheap today
(~0.15 sepETH, scripts are idempotent; only operator + seed positions exist), painful
later in the quarter once real traders hold positions. If we want limit orders this
cycle, the redeploy should happen soon; the alternative is shipping V2 at the next
quarterly listing (Jan 2027 cycle) with V1 running out the current quarter.
