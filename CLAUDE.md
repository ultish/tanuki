# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for the condensed agent rules (product framing, stack, domain "not goals," and the core invariants — CGT cutover, debt-recycle mechanics, super-splitting intuition). Read it too; this file adds commands and architecture detail.

## Commands

```bash
pnpm install
pnpm --filter @tanuki/core build   # must run before first `pnpm dev` — api/web import core's dist output
pnpm dev                           # builds core, then runs core/api/web dev servers in parallel
pnpm dev:api                       # apps/api only (tsx watch), port 8790
pnpm dev:web                       # apps/web only (vite), port 5174
pnpm build                         # build all workspaces
pnpm typecheck                     # typecheck all workspaces
pnpm test                          # test all workspaces (currently only @tanuki/core has tests)
```

Single test file / watch mode (core is vitest):

```bash
pnpm --filter @tanuki/core test              # vitest run
pnpm --filter @tanuki/core test:watch        # vitest watch
pnpm --filter @tanuki/core exec vitest run engine.test.ts -t "debt recycle"
```

After any change to engine/tax/caps behavior, run `pnpm --filter @tanuki/core test` (per AGENTS.md rule 6) — `engine.test.ts` is the main behavior spec (627 lines) and is the fastest way to check a change didn't shift scenario rankings.

There is no lint script configured.

## Architecture

Pnpm workspace monorepo: `packages/core` (pure TS engine, no I/O) → `apps/api` (Hono server, wraps core) → `apps/web` (React/Vite UI, calls api). `apps/web` and `apps/api` both depend on `@tanuki/core` via `workspace:*`; core must be built (`tsc`, emits to `dist/`) before the others can import it — this is why `pnpm dev` builds core first and why a stale `core/dist` after a core edit is the most common "why isn't my change showing up" bug (rerun `pnpm --filter @tanuki/core build`, or run `pnpm dev` which triggers a fresh build).

### `packages/core` — the domain engine

Everything financial lives here; the API layer is intentionally thin (AGENTS.md rule 1).

- **`types.ts`** — the shared vocabulary: `Household` (you, spouse, `Loan`, `Assumptions`), `BucketId` (the 12 places a dollar of the lump can go — offset, extra_repay, taxable ×2 people ×2 sleeves, debt_recycle ×2 sleeves, super_cc/ncc ×2 people), `ScenarioDef`/`ScenarioResult`/`YearRow`. Read the doc comments here first — they carry non-obvious domain rules (e.g. why `investmentLoanRate` is `number | null` and not optional, what `restrictedOffset` excludes from net wealth).
- **`engine.ts`** — `runScenario` simulates one allocation month-by-month over the horizon (loan amortization, super growth, sleeve growth/yield/CGT, income tax) and returns a `ScenarioResult`; `runHousehold` runs every candidate scenario, ranks by `netIfLiquidated`, and calls `pickDisplayedResults` to trim the stack explosion down to a presentable list. `applyCaps` clamps a requested allocation to actual super-cap room and dumps any overflow into the offset — every scenario is guaranteed to fully place the lump. CGT lots are tracked per-parcel (`Lot`) so DRP reinvestments and mid-run idle-offset sweeps get their own acquisition date for exit-CGT purposes, rather than inheriting the sleeve's original date.
- **`stacks.ts`** — generates the combinatorial "fill super in this order, dump the rest here" scenarios (`buildStacks`): every `SuperFill` (none/you/spouse/you_then_spouse) × cc × ncc × rest-bucket combination, deduped by allocation fingerprint (`allocationKey`), then `pickDisplayedResults` keeps only the top-ranked stacks plus one per distinct rest-bucket so the UI isn't flooded with near-duplicates.
- **`presets.ts`** — the fixed, hand-labeled scenarios (offset-only, debt-recycle, etc.) that always appear regardless of ranking.
- **`caps.ts`** — FY2026-27 contribution caps and room calculations (concessional/NCC, Division 293, bring-forward TSB tiers). Bumping a financial year touches this file plus tests, README, and UI copy together (AGENTS.md rule 2).
- **`tax.ts`** — income tax brackets/`bracketTax`, franking credits, Division 293, and `estimateHybridCgt` (the pre/post 1-Jul-2027 CGT regime hybrid — 50% discount vs CPI-indexed cost base with a 30%-of-real-gain floor).
- **`loan.ts`** — `pmt` (repayment calc) and `stepHomeLoan` (one month of amortization against an offset balance).
- **`defaults.ts`** — `defaultHousehold`/`defaultPerson`/`defaultAssumptions` and `mergeHousehold` (shallow+nested merge used to apply a partial PUT onto the stored household without dropping unset fields).
- **`explainers.ts`** — plain-language copy served to the UI via `/api/meta`, keyed to concepts (offset, debt recycling, etc.), separate from the per-scenario `notes` generated in `engine.ts`'s `scenarioNotes`.

### `apps/api`

Single-file Hono app (`src/index.ts`). Household state is one JSON blob in a SQLite `kv` table (key `"household"`), read/written via `db.ts`'s `getJson`/`setJson`; `mergeHousehold` (from core) reconciles a stored partial household against `defaultHousehold()` so schema additions don't break old saved data. Routes: `GET/PUT /api/household`, `GET /api/meta` (caps + explainers + disclaimer), `POST /api/run` (accepts optional `household` overrides and a `custom` allocation, returns a full `RunReport`). In production (`SERVE_WEB=1`, the Docker default) the same process also serves the built `apps/web/dist` as static files and falls back to `index.html` for client-side routing.

DB path resolution: `TANUKI_DB_PATH` env var, else `data/tanuki.db` relative to repo root (see `db.ts`). `env.ts` loads a repo-root `.env` if present before anything else runs.

### `apps/web`

Single-page React app; nearly all UI logic is in `App.tsx` (~1600 lines — household form, scenario table, chart). Talks to the API through `api.ts`. No router, no state library — local component state plus the API round-trip on save/run.

### Deployment

`docs/hana-server.md` and `scripts/deploy-hana.sh`/`hana-backup.sh` cover deploying this app to the user's home server (`hana-server`) via Quadlet/Caddy — see the `hana-deploy` skill rather than re-deriving these steps. The `Dockerfile` builds all three workspaces into one image and runs the API (which serves the web build) against a `/data` volume.
