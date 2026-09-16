<p align="center">
  <img src="apps/web/public/tanuki-icon.png" alt="Tanuki" width="128" height="128" />
</p>

# Tanuki

**Tanuki** (狸 — raccoon dog) helps you **place a lump of money** — inheritance, bonus, sale proceeds — across a household: home loan, offset, debt recycling, super (yours and a spouse’s), and taxable investing in either name.

Risu is “what we already own.” Tanuki is “what we do with new money.” Built for an **Australian resident** household. Everything stays **on your computer**. **Not financial advice.**

---

## What it compares

Given a lump (default $250k) plus your loan, offset, incomes, and super:

- Park in the **offset** vs **pay down** the home loan
- **Debt recycle** (offset + investment loan) in a growth or income sleeve
- Taxable **growth vs income**, in **your name (45%)** vs **spouse’s name (30%)**
- **Concessional** super (personal deductible) — yours vs spouse’s, so you can see that the 45% deduction usually wins
- **Non-concessional** super, including FY2026–27 bring-forward, one person or both
- Mixes: your concessional cap then spouse taxable / NCC / recycle
- Your own split of the lump

Each row is ranked by net household wealth at the horizon (held, and if you sold and paid CGT). Super stays preserved; “accessible” is everything else.

## What it is careful about

- **Contribution splitting** does not cut your 45% income tax. The 15% contributions tax is already paid. Use it to even balances, not to arbitrage 30% vs 45%.
- **Spouse contributions** (after-tax into her fund) are not a 30% vs 45% trick either — earnings inside super are 15% in either fund. The bracket split that works is **taxable assets in her name**.
- **1 Jul 2027 CGT:** 50% discount replaced with CPI indexation and a 30% minimum on the real gain. Super funds are not on this regime. At 47% you still pay 47% on the real gain.
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

Household JSON lives in `data/tanuki.db` (SQLite). **Save household** writes it; the ranking recalculates as you type.

```bash
pnpm test
```
