# Fire the CEO — ceo.futarchy.fi

Robin Hanson's fire-the-CEO decision markets, live on Sepolia testnet:
for each of the top-100 US public companies, a pair of **called-off conditional
markets** on company value (CEO out by quarter end vs CEO stays) plus a
departure-probability market — and the public ranking of every company by its
market-estimated **fire premium**.

**Live:** https://ceo.futarchy.fi

## Deployment (Sepolia, chain 11155111)

| Contract | Address |
|---|---|
| FireTheCEO | `0x267b838f5786b609b55481695d7d58220a8c2bb1` (verified) |
| PlayUSD (pUSD) | `0xa9f9d48363f4a1c5d25a962f42dc10326f21259f` (verified) |
| Operator / oracle | `0x693E3FB46Bb36eE43C702FE94f9463df0691b43d` |

First cycle: horizon **2026-09-30 23:59 UTC**, settlement read **2026-10-30 21:00 UTC**
(closing price, one month after the quarter, per Hanson's "measure value after the
decision settles"). 101 companies listed (company 0 is a resolved TEST used for the
on-chain lifecycle rehearsal — see `docs/rehearsal.md`).

## Mechanism (one contract, three LMSR markets per company)

- **OUT / STAY** — scalar markets on normalized value over a `[0.25×, 1.75×] spot`
  band; the market whose condition fails is **void** and refunds every trader's
  paid-in cash exactly. Sell proceeds are **escrowed** until resolution — that is
  what makes the bets genuinely callable-off (and the contract solvency-proof:
  cash never leaves between trade and resolution).
- **EXIT** — binary market on the departure condition itself.
- Every market is a **subsidized LMSR** market maker (Hanson's own design); the
  exact worst-case-loss subsidy `C(q₀) − min(q₀)` is computed and funded on-chain
  at listing (≈1.35M pUSD across the board).
- Fire premium `= (E[value|OUT] − E[value|STAY]) / spot`. The FIRE/KEEP signal
  implements Hanson's OldTek rule: premium positive in ≥90% of snapshots over the
  trailing week (WATCH below 20 observations — no price, no signal).
- Resolution: operator oracle with a 48 h dispute window; `oracle` is a swappable
  address (Reality.eth v3 exists on Sepolia at `0xaf33…49CA` for a future adapter).

Solvency is enforced by construction and tested: Foundry invariant suite
(`contracts/test/FireTheCEO.invariants.t.sol`) checks every resolution scenario ×
random trading; 43 tests total.

## Repo layout

- `contracts/` — Foundry: `FireTheCEO.sol`, `PlayUSD.sol`, `LMSR.sol`, tests,
  deploy/list/seed/resolve scripts
- `site/` — Vite + React + wagmi/RainbowKit static SPA (design: `docs/design-direction.md`)
- `ops/` — `snapshot.mjs` + systemd user units (30-min board snapshots → `/data/history.json`)
- `data/` — deployment addresses, verified company dataset (July 2026 CEOs,
  independently cross-checked), listing priors, seed-trade disclosure
- `docs/` — design spec, implementation plan, Hanson primary-source citations,
  rehearsal evidence

## Runbook (farol)

- Site: build `site/` with bun → rsync `site/dist/` → `/home/kelvin/fleet/apps/ceo/dist/`
  (Caddy site `ceo.futarchy.fi`, Cloudflare tunnel `colony-ops`, DNS in futarchy.fi zone).
- Snapshots: `systemctl --user status ceo-snapshot.timer` (writes
  `/home/kelvin/fleet/apps/ceo/data/`, served at `/data/*`).
- Resolve a company: `contracts/script/Resolve.s.sol` (oracle key), source URI in calldata.
- New listings: append to `data/listings.json` (plain JSON numbers — string values
  break `vm.parseJson` struct decoding) and run `ListCompanies.s.sol` (idempotent).

## Known limitations (deliberate, testnet)

- Positions are internal balances, not ERC-20s; all trading is against the LMSR.
- Subsidies and void-market surplus stay in the contract (no withdrawal path).
- Oracle is the operator key; measurement-window liquidity boosts (Hanson 2024
  refinement) are a documented follow-up, not yet implemented.
