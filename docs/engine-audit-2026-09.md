# Engine audit — 2026-09-20

Triggered by the investment-loan-interest bug found and fixed the same day
(interest was deducted for tax but never actually charged as a cost, so
raising the rate manufactured free money — see git history for that fix).
Given a real bug slipped through, this is a systematic pass over the rest of
`packages/core` looking for similar issues: places where money can appear or
vanish, or where a rate/date/cap boundary is handled inconsistently.

**Method:** TDD in reverse-engineering mode. For each suspected issue, a test
encoding the *financially correct* behavior was written first in
`packages/core/src/audit.test.ts`, then run against the current engine with
no implementation changes. A failing test is a confirmed finding, not a
guess. All 29 pre-existing tests in `engine.test.ts` still pass — nothing
below was previously covered.

**Result: 5 of 6 hypotheses confirmed as real bugs.** One (a dead-code
consistency check) passed clean.

**Status: all 5 findings fixed the same day**, plus #6 (dead code) removed.
`audit.test.ts` stays in the repo as a permanent regression suite — all
tests are green now.

---

## Findings

### 1. Division 293 is never assessed on ongoing super guarantee, only on the lump (High)

`packages/core/src/engine.ts`, `contributeCc` (~L242) correctly charges
Division 293 (extra 15% tax once income + concessional contributions exceed
$250k) — but only for the one-off lump contribution decision. The **ongoing**
employer SG / salary-sacrifice contribution that grows every year
(`yearWorkConcessional`, ~L347, credited at ~L431) never touches
`division293Tax` at all, in any year, including year one.

**Test:** `AUDIT: Division 293 on ongoing concessional contributions`
Two otherwise-identical households, one with $3,000/yr employer SG (under
the $250k Division 293 threshold with a $245k salary), one with $20,000/yr
(pushing $15k over the threshold). The extra $17k of SG should net into
super at 85% (after the 15% contributions tax) *minus* $2,250 of Division
293 on the excess — a net wealth gap of $12,200.

**Actual:** gap is $14,450 — the full amount, no Division 293 charged.
**Impact:** understates tax, overstates net wealth, for any household whose
*ongoing* (non-lump) concessional contributions cross $250k combined income —
which is exactly the population this app's super splitting/Division 293
messaging is built for.

**Fix:** `contributeCc` no longer bails out early when the lump `amount` is
zero — it now always assesses Division 293 on the ongoing committed amount
(plus the lump, if any), via a new shared `concessionalExtraTax` helper.

### 2. Super guarantee above the concessional cap silently vanishes in later years (High)

`yearWorkConcessional` (engine.ts ~L347) uncaps year zero on the theory that
"this year's SG is already within cap by construction," then for year two
onward does `Math.min(raw, concessionalCap)` — but the clamped-off excess is
**not** redirected anywhere. It isn't contributed to super (even though
employer SG is legally compulsory and must still be paid), isn't taxed as
excess concessional contributions, and isn't credited back as cash. It is
simply dropped.

**Test:** `AUDIT: concessional cap on ongoing SG contributions`
Two households, one earning exactly the $32,500 cap in SG every year, one
earning $36,000 (i.e. $3,500/yr over). Both get identical, uncapped SG in
year one (the special case above). In year two, the excess should show up
*somewhere* — more super (with excess-contributions tax), or more cash.

**Actual:** year-two super growth is **bit-for-bit identical** ($27,625 vs
$27,625) between the two households — the $3,500/yr difference has no effect
on the simulation at all once the cap bites.
**Impact:** for a household modeling several years of income growth (this
app's own `incomeGrowthRate` assumption exists specifically to grow SG over
time), any year where growth pushes SG past the cap silently understates
wealth by the full uncredited amount, compounding for every later year too.
Same root cause as #1: the excess-concessional-contribution tax machinery
that `contributeCc` implements correctly for the lump was never extended to
the recurring contribution path.

**Fix:** `yearWorkConcessional` no longer caps the contribution itself — the
full (grown) SG/salary-sacrifice amount is always credited to super, since
SG is compulsory. The same `concessionalExtraTax` helper from #1 is now
called once per year (from year two on; year one is folded into
`contributeCc` alongside the lump) to charge excess-concessional-contributions
tax (marginal rate less a 15% offset) and Division 293 on the capped portion,
debited from cash/offset the same way the rest of the engine handles tax.

### 3. `addMonthsIso` doesn't clamp month-end dates — it rolls into the next month (Medium)

`packages/core/src/tax.ts` `addMonthsIso` (~L91) builds `Date.UTC(y, m-1+months, d)` directly. When `d` (29, 30, or 31) doesn't exist in the target month, JS's `Date` silently rolls forward instead of clamping — the conventional, expected behavior for "add N months" in every date library this app's peers would use (date-fns, moment, etc.).

**Test:** `AUDIT: addMonthsIso month-end handling`

```
addMonthsIso("2026-01-31", 1) → "2026-03-03"   (expected "2026-02-28")
```

**Impact:** `Assumptions.startDate` defaults to *today's date* — so any user
who opens the app on the 29th, 30th, or 31st of a month gets a subtly
irregular monthly date sequence for their entire projection. This feeds
`daysBetweenIso`-based CGT holding-period checks (the 365-day discount
threshold) and the 1 Jul 2027 cutover-crossing detection. The error is only
a few days per affected month, so it's unlikely to flip a scenario's ranking
on its own, but it's a real, easily-reproduced inaccuracy with zero relation
to the number of months requested — worth fixing given how central "days
held" is to this app's CGT modeling.

**Fix:** rewritten to do the month arithmetic with integer year/month math
(no `Date` object for the month roll) and clamp the day to
`daysInTargetMonth` via a `Date.UTC(ty, tm + 1, 0)` last-day-of-month trick.

### 4. Debt-recycle amounts beyond the home loan balance are silently redirected with no warning (Medium)

`placeDebtRecycle` (engine.ts ~L218) clamps the recycled amount to
`state.homeLoan` and dumps any excess into the offset — a reasonable
fallback — but pushes **no warning**, unlike every other clamp in the engine
(`applyCaps`'s super-cap and over-lump-scaling clamps both push a message
into `warnings[]`, which the UI surfaces to the user).

**Test:** `AUDIT: debt recycle beyond the home loan balance`
Recycling the full $250k lump against a $100k home loan balance produces
zero warnings.

**Impact:** low financial risk (money isn't lost, just re-routed), but a
real UX inconsistency — a user who asks to recycle more than their home loan
allows gets no indication that $150k of it silently became "park in offset"
instead. Every other silent clamp in this engine warns; this one doesn't.
Not reachable through the presets/stacks (which never over-request beyond a
sane split); only via a hand-typed "mix" allocation.

**Fix:** `placeDebtRecycle` now pushes a warning naming the shortfall,
matching the phrasing style of `applyCaps`'s existing cap warnings.

### 5. Negative allocation amounts aren't rejected or flagged (Low/Medium)

`applyCaps` (engine.ts ~L98) only rescales when
`allocationSum(allocation) > lump + 0.5`. A crafted allocation with a large
negative bucket offsetting a large positive one (e.g.
`{ offset: -1,000,000, taxable_you_growth: 1,200,000 }`, summing to a
plausible $200k) sails through unclamped and unflagged, and the negative
value is applied as-is.

**Test:** `AUDIT: allocation input validation`

**Impact:** not reachable through the preset/stack scenarios (which never
generate negative amounts), but reachable through the web UI's free-text
"mix" boxes (`apps/web/src/App.tsx`, `MIX_BUCKETS`) and directly through
`POST /api/run`'s `custom` field, since neither validates sign. This is a
missing-boundary-validation issue more than a core-engine bug — per the
project's own domain-lives-in-core / thin-API convention, the natural fix is
probably in `applyCaps` itself (reject or zero negative buckets) since that's
the one choke point both the UI and API already funnel through.

**Fix:** `applyCaps` now drops any negative bucket up front (before the
over-lump sum check) and pushes a warning when it does.

### 6. `dividendTax` (tax.ts) — dead code, but consistent (Informational, no test failure)

`dividendTax` is exported from `@tanuki/core` but never called anywhere in
`engine.ts`, `apps/api`, or `apps/web` — the engine computes yield tax itself
via an accumulated year-to-date bracket walk (`yearNet`/`yearYieldTax`) that
duplicates the same logic. **Good news:** the audit test comparing the two
on a clean single-sleeve, single-year scenario shows they agree exactly, so
this isn't presently a live bug. But it's an unused, parallel implementation
of the same formula with no caller — a future edit to one without the other
would silently create the exact kind of divergence this audit was looking
for. Worth either wiring it in (e.g. as the per-dividend-event note the UI
already shows) or removing it.

**Fix:** removed (`tax.ts`, and its export from `index.ts`) — nothing else
called it, and the engine's own `yearNet`/`yearYieldTax` accumulation is the
real, load-bearing implementation.

---

## Noted but not tested (lower priority / policy-ambiguous)

- **CGT losses aren't netted across the 1 Jul 2027 cutover boundary.**
  `estimateHybridCgt`'s straddle branch (tax.ts ~L208) treats a pre-cutover
  loss and a post-cutover gain (or vice versa) on the same lot independently
  — a loss on one side never offsets a gain on the other, unlike real CGT
  law within a single disposal. Likely rare in practice (most modeled assets
  have positive expected growth) but not verified either way here.
- **A custom "Yours" mix that exactly matches an existing preset/stack shows
  up as a duplicate row** (same numbers, two labels) — cosmetic, not a math
  bug, not tested.
- **Concessional cap and Division 293 threshold are held flat for the whole
  horizon** (not indexed year to year). This is already covered by the
  app's own disclaimer ("Caps are FY2026-27") and isn't a new finding — flagged
  here only because it's adjacent to findings #1 and #2.

---

## Verification

All 5 findings fixed, #6 removed, on 2026-09-20. Full suite
(`engine.test.ts` + `audit.test.ts`, 34 tests) passes; typecheck clean across
all three workspaces. Findings #1/#2 turned out to materially affect this
household's own numbers: the 2.5%/yr income-growth assumption compounds SG
past the $32,500 concessional cap by roughly year seven of the 10-year
horizon, and past the $250k Division 293 threshold by roughly year nine —
so the "Debt recycle, growth" scenario's net-if-liquidated figure moved from
$1,716,006 to $1,697,898 as a result of these two fixes alone (on top of the
~$150k already corrected by the investment-loan-interest fix earlier the
same day).
