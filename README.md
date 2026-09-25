<p align="center">
  <img src="apps/web/public/tanuki-icon.png" alt="Tanuki" width="128" height="128" />
</p>

# Tanuki

**Tanuki** (狸 — raccoon dog) helps you **place a lump of money** — inheritance, bonus, sale proceeds — across a household: home loan, offset, debt recycling, super (yours and a spouse’s), and taxable investing in either name.

Risu is “what we already own.” Tanuki is “what we do with new money.” Built for an **Australian resident** household. Everything stays **on your computer**. **Not financial advice.**

---

## What it compares

Given a lump plus your loan, offset, incomes, and super:

- Park in the **offset** vs **pay down** the home loan
- **Debt recycle** — pay the lump onto the home loan, redraw it as an investment split in your name, buy a growth or income sleeve
- Taxable **growth vs income**, in your name or your spouse’s
- **Concessional** super (personal deductible) — yours vs your spouse’s. The deduction is worth more in the higher-rate name
- **Non-concessional** super, including FY2026–27 bring-forward, one person or both
- Mixes: one person’s concessional cap, then the rest in taxable, NCC, or recycle
- Your own split of the lump

Each row is ranked by net household wealth at the horizon (held, and if you sold and paid CGT). Super stays preserved; “accessible” is everything else.

Around the lump, the household's own cash flow runs every month: after-tax pay in; loan repayments, investment-loan interest, living expenses (optionally rising with **expense inflation**) and an annual **holiday fund** out; the rest settles into the offset. The idle-offset sweep invests only what's above the home loan balance, or above your **minimum cash** plus holiday savings if that's more. **Novated leases** — the current one ending, and any **next lease** you add — move taxable income as they start and stop. **Pay changes** and **rate changes** can be recorded as dated events.

Click a month in a scenario's plan table to see exactly where that month's money went.

## Track a plan

Accept a scenario as a plan (**Track this plan**) and Tanuki freezes its projection. The **Tracking** view then logs what really happened, month by month, against it:

- **Up next** opens the oldest month not yet confirmed, pre-filled with the projection — change only what differs (money invested per bucket, offset, loans, your super, shares) and confirm. Nothing changed? Confirm the backlog in one click.
- A **re-forecast** carries on from where the log says you are; the **plan at today's rates** re-runs the original with the rate and pay changes you've recorded, so you can tell the world moving from what you did differently.
- **Re-plan** from any month: choose how much of the offset to put to work and which strategy places it.
- Shares can come straight from **Risu**: link portfolios (owner, own money or debt-recycled) and map tickers to growth or income, then pull a month's real parcels. Each plan picks which portfolios feed it. Tanuki only reads Risu's HTTP API, at `RISU_URL`.

One log serves every plan. Design and rationale: [`docs/plan-tracker.md`](docs/plan-tracker.md).

## What it is careful about

- **Contribution splitting** moves money between super accounts. The 15% contributions tax is already paid, and the deduction stays with the person who claimed it. Use it to even balances.
- **Spouse contributions** are after-tax money into their fund. Earnings inside super are 15% in either fund. The bracket split that works is **taxable assets in the lower-rate name**.
- **1 Jul 2027 CGT:** 50% discount replaced with CPI indexation and a 30% minimum on the real gain. Shares held across the date have their gain split at the 30 June 2027 value — the part before keeps the discount if held 12 months by the sale. Super funds are not on this regime. At the top marginal rate, that 30% floor does not lower the tax on the real gain.
- **Debt recycling** assumes a clean paper trail. Geared shares still negatively gear after 2027; most residential investment property does not.

Estimates only. Caps are FY2026–27 ($32,500 concessional, $130,000 NCC / $390,000 bring-forward, Div 293 at $250k, TSB $2.1m).

## Run locally

Needs Node 20+ and pnpm 9.

```bash
cd tanuki
pnpm install
pnpm --filter @tanuki/core build
pnpm dev
```

- UI: http://localhost:5174
- API: http://localhost:8790

Household JSON lives in `data/tanuki.db` (SQLite), along with tracked plans and the monthly log. **Save household** writes it; the ranking recalculates as you type. Set `RISU_URL` (e.g. `http://localhost:8787`) to link Risu; on hana-server the deploy script points it at Risu on localhost.

```bash
pnpm test
```
