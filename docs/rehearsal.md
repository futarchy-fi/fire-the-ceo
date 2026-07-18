# Sepolia lifecycle rehearsal — 2026-07-16

Company 0 = TEST (Rehearsal Test Co., spot $100, floor $25, cap $175, b=200e18 all markets,
exit prior 0.50). Contract 0x267b838f5786b609b55481695d7d58220a8c2bb1, operator 0x693E…b43d.

| Step | Evidence |
|---|---|
| List (subsidy 415.888 pUSD = 3·200·ln2 + dust) | tx 0x2ffc132a…b078b8 |
| Buy 50 OUT-LONG, cost 26.558 pUSD (quote matched sigmoid math) | mid moved 0.5000→0.5374 = sigmoid(30/200) after partial sell |
| Buy 20 EXIT-LONG, cost 10.250 | pExit 0.5250 = sigmoid(20/200) ✓ |
| Sell 20 OUT-LONG | proceeds 10.996 pUSD ESCROWED (wallet balance unchanged) ✓ called-off-bet semantics |
| Resolve fired=true, 17600¢ (> cap → w=1) after settleTime | tx status 1; board state → 2 |
| claimableAmount | 60.996 pUSD = 10.996 escrow + 30·1 (OUT valid) + 0 (STAY void paidIn) + 20·1 (EXIT) — exact |
| claim during dispute window | reverts NotClaimable ✓ |

Claim after the 48h window stays open (TEST left unclaimed as a live example).

## V2 signed-order (CLOB) rehearsal — 2026-07-17 (Sepolia)

Contracts: core 0x6D7852DDB9019fcFD961A4cDfB854edc3563ee7F, exchange
0x366A8fF9788aaBF279dFf0b7f3196dFc6592b6f6 (both verified). 100 companies listed on V2.

- EIP-712 order hash agreement: relay TypeScript `hashOrder` == on-chain `hashOrder`
  byte-for-byte (0xa5861b…1138). Relay, contract, site share one order identity.
- Full fill: maker signed a SELL of 5 STAY-LONG shares (company 0) off-chain; a distinct
  taker key called `fillOrder` on-chain → tx 0x9c5d0028…f9a6f status success; shares moved
  maker→taker (taker now holds 5e18), order marked filledOrCancelled=true, remaining=0.
  Permissionless: taker ≠ operator, no operator gate. Called-off-bet settlement intact.
