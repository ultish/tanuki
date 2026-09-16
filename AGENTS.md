# Agent guide — Tanuki

- **Product:** Tanuki (狸 — raccoon dog). Household lump-sum allocator for an Australian resident.
- **Stack:** TypeScript monorepo — `apps/web` (Vite/React), `apps/api` (Hono + better-sqlite3), `packages/core` (engine, tax, presets).
- **DB:** SQLite (`TANUKI_DB_PATH` or `data/tanuki.db`). One `kv` row for the household JSON.
- **Not goals:** Live broker feeds, ATO software, advice, multi-user SaaS.

## Rules

1. Domain logic lives in `@tanuki/core`. Keep the API thin.
2. Caps default to **FY2026–27**. If you bump a FY, update `caps.ts`, tests, README, and UI copy together.
3. CGT: hybrid around `2027-07-01` (pre-cutover 50% discount if 12 months held; post-cutover indexation + max(MTR, 30%)). Super is not on this regime.
4. Debt recycle: lump → offset, plus a separate interest-only investment loan, assets in the **borrower’s** name (you).
5. Do not “fix” the spouse-super intuition by making contribution splitting look like a 45%→30% tax cut. Explain it; model the real split (taxable in her name, concessional in the high earner’s name).
6. After material behaviour change: run `pnpm --filter @tanuki/core test`.
