# ceo.futarchy.fi — Design Direction: "The Exhibit"

The site is styled as a **live exhibit in a corporate-governance proceeding**: EDGAR-filing
typography meets market-terminal data density, printed on paper-white, with one aesthetic
risk — **rubber-stamp verdicts**. The product's single job: make the fire premium legible,
credible, and dramatic for 100 companies at once. The hero is the board itself; nothing
stands between the visitor and the table.

## Tokens

Color (light):
- `--paper: #FBFAF7` — barely-warm paper white (not cream)
- `--ink: #14120E` — warm near-black ink
- `--rule: #D8D4C9` — hairline rules (real table delimiters, never decoration)
- `--dim: #6E6A5E` — secondary text
- `--fire: #B3261E` — oxide stamp red (data semantic only, never accent chrome)
- `--keep: #2456A6` — registry blue: the blue ballpoint of board approvals (data semantic only;
  chosen over ledger green — red/blue passes all six dataviz checks incl. protan CVD, where
  red/green failed at ΔE 4.5)
- `--watch: #946B00` — amber ink for WATCH / no-signal / pending states

Dark ("after-hours registry"): paper `#141310`, ink `#EDEAE2`, rules `#2E2C26`,
fire `#DC5245`, keep `#5E8EDC`, watch `#B98A26`. Never acid-green-on-black.
Both palettes validated with the dataviz `validate_palette.js` (ALL CHECKS PASS, light+dark).
Verdicts additionally always carry the word (FIRE/KEEP/WATCH) — never color alone.

Type:
- **Display:** Libre Caslon (Display/Condensed — whichever fontsource ships with needed
  weights; verify at build). Used with restraint: site title, filing captions, big premium
  figures on company pages.
- **Data/utility:** IBM Plex Mono — ALL numerals everywhere (tabular alignment = terminal
  credibility), eyebrow metadata lines, column headers (uppercase, letterspaced), stamps.
- **Body:** Source Serif 4 — prose (About, explainers, resolution criteria).

## Structure

- **Filing captions as headers.** Board page opens with a mono eyebrow
  (`FORM FTC-100 · SEPOLIA TESTNET · CONTINUOUS FILING`), Caslon "Fire the CEO", one-line
  thesis crediting Hanson (1996–), then a totals strip (subsidy outstanding · companies ·
  resolution date). Company pages: `IN RE: PEPSICO, INC. — R. LAGUARTA, CHIEF EXECUTIVE`.
- **The board** is a dense full-width table: rank, company+CEO (tenure), P(exit), E[P|OUT],
  E[P|STAY], **premium (largest type in row, signed, colored)**, verdict chip, 7-day
  sparkline, mcap. Hairlines only where a reader's eye needs a row boundary.
- **Signature element: the verdict stamp.** FIRE / KEEP / WATCH rendered as an ink rubber
  stamp (slight rotation, imperfect edge via SVG filter) on company pages; compact stamp
  chip in board rows. The stamp presses once on company-page load (scale 1.08→1, 150ms,
  reduced-motion: none) — the site's one orchestrated motion.
- **Trade panel as order ticket:** bordered slip, mono fields, buttons say exactly what
  happens: "Buy 100 OUT-LONG · ≈ 52.40 pUSD", "Escrow sale proceeds", "Refund voided
  trades".

## Copy register

Registrar's voice: plain verbs, sentence case, specific. Errors say what happened and the
next action. Empty states invite ("No position in PEP yet — get pUSD from the faucet").
Numbers never round away the sign. WATCH rows say "no signal — thin market" (Hanson: "if
there is no price, there is no signal").

## Anti-default checks

- Not cream+terracotta editorial: palette is paper/ink with **semantic-only** red/green;
  display face is Caslon (engraved-registry flavor), not Playfair/Fraunces.
- Not black+acid terminal: dark mode is muted after-hours registry.
- Not broadsheet-hairline decor: every rule delimits actual tabular data.
- Numbered markers only where order is real (the ranking — which is the entire point).

## Quality floor

Responsive to mobile (board collapses to card-per-company with premium + stamp dominant),
visible keyboard focus (2px ink outline), `prefers-reduced-motion` kills the stamp press
and row stagger, charts follow the dataviz skill (palette validator, light+dark).
