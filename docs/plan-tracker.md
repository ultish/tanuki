# Plan execution tracker

Status: built 2026-09-24. Designed 2026-09-23, revised after review.

Tanuki answers "where should this lump go". The tracker adds the next
question: "am I actually doing it, and is it working out". You accept a
scenario as a plan, then log what really happened month by month against
what the plan said would happen.

Code: `packages/core/src/tracker.ts` (trackers, replay, re-plan),
`income.ts` (monthly income), `risu.ts` (risu mapping), the `simulate` core
in `engine.ts`; `apps/api/src/tracking.ts` (routes); `apps/web/src/Tracking.tsx`
(view). Risu side: `lotsAsOf` in `@risu/core`, `GET /api/lots`.

## Goals

- Accept a strategy as a **plan**, with its own start date.
- Log actuals month by month, without a 120-section form.
- See target vs reality, and a re-forecast from where you actually are.
- Compare more than one target at once — two competing strategies, or a
  strategy re-planned from a point in time — against the one life you
  actually lived.

## Design decisions

### One log, many targets

You only do one set of things. The log of what happened is stored **once**
(the `actuals` kv key). A tracker is only a frozen target: the allocation,
the month series, the start date. Each view joins the shared log to one
target. Adding a second tracker creates nothing you have to type again, and
the same month can never have two realities.

### After placement, strategies do not differ

The allocation is applied once, at the start. Every month after that — loan
amortisation, SG, salary sacrifice, returns, the idle-offset sweep — runs
the same code for every scenario. The sweep is a household setting and
always buys the spouse's growth sleeve.

So from the same actual position, a re-forecast of strategy A and strategy B
is **the same line**, and "from here, run a different strategy" only means
something if the new strategy is **placed** — applied to money that is still
deployable, the offset above the restricted floor. Placing nothing is the
re-baseline case ("Carry on from here").

### Flows change lots, balances change market value

Exit CGT is computed per lot (owner, sleeve, cost, acquisition date, value
at 1 July 2027). A single `invested` number can't be turned back into lots,
so a month's inputs are applied in a fixed order:

1. **Flows** are keyed by the same buckets as the allocation, sparse, plus
   `sweep`. Month one's flows override the lump placement bucket by bucket;
   whatever of the lump isn't placed stays in the offset. Later months' flows
   move money out of (or, for a sell, back into) the offset at the start of
   the month. A negative flow is a sell: pro rata across the sleeve, and for
   a debt-recycle bucket the proceeds repay the investment loan first.
2. **Balances** are applied at the end of the month. A share balance only
   **scales the market value** of the lots already there, within that
   person and sleeve; cost, date and cutover value stay. Offset, loans and
   your super are set outright.
3. A month you never opened **uses the plan's own flows**. It stays in the
   "to confirm" queue; the re-forecast still has a continuous position.

A typed super balance corrects the fund return only. Cap room, Division 293
and contributions tax come from a concessional contribution **flow**
(`super_cc_you`), which is taxed like the lump's: refund at the marginal
rate, plus any extra Division 293 it adds on top of the year's.

### What is tracked

- **You:** super balance, concessional contributions, shares per sleeve.
- **Spouse:** shares per sleeve. Spouse super stays projected.
- **Loans and offset:** default to the projection, overridable.

Every field is pre-filled with the re-forecast's value, with the frozen
plan's value shown under it. Only fields you change are stored; confirming a
month as-is stores the confirmation and nothing else.

### Logging is a queue, not a calendar

The view opens on **Up next**: the oldest month that has started and isn't
confirmed. Confirming moves on to the next one; "Nothing else changed?"
confirms the rest of the overdue months as projected in one go. ‹ › step to
neighbouring months, the **Logged** list (newest first, gap to plan per
month) opens any month you've touched, and clicking the chart opens the
month under the pointer. Months that haven't started aren't shown anywhere —
there's nothing to do with them.

### Shares from risu, per plan

Risu holds the real ledger: every parcel with its AUD cost base, acquisition
date and price history. Tanuki reads it **only through risu's HTTP API**
(`GET /api/lots`), at `RISU_URL`.

- **The link** (kv `risuLink`) says who owns each risu portfolio and whether
  it holds your own money or debt-recycled buys, and maps each ticker to
  growth or income. A pull refuses until every ticker is mapped.
- **A pull** stores every linked portfolio's parcels and trades for that
  month in the log, each tagged with its portfolio. Past months don't move
  when risu is down or its ledger is edited; re-pull on request.
- **Each plan chooses which portfolios feed it** (optional; none by
  default). Risu replaces the projection only for the people who own a
  ticked portfolio: their lots become the real parcels, their share flows
  become buys minus sell proceeds. Everyone else's shares stay typed or
  projected. The sweep is spouse growth, so it is taken from risu only when
  a spouse portfolio is ticked.
- Parcels bought before the plan started (`planSince`) aren't the plan's
  money: they are left out, and sells of them don't count as flows.

Keeping debt-recycled buys in their own portfolio is also what keeps the
interest deduction traceable, so the portfolio split is worth having anyway.

### Rates and pay are dated events

- `Loan.rateEvents`: *the rate is X from Y*. When `monthlyRepayment` is unset
  the P&I repayment is recalculated over the remaining term at each change.
  The investment loan follows unless it has its own rate.
- `Person.payEvents`: *my taxable income is X from Y*, optionally with a new
  salary (else SG scales by the same ratio). An event resets the base;
  `incomeGrowthRate` keeps compounding from it on plan-year anniversaries.
  Pay lands in the month it changes; that year's tax base is the average of
  its twelve months.

Events are facts, so every tracker's re-forecast uses the household's
current events. Everything else in a tracker's frozen household stays as
accepted. The chart's third line, **the plan at today's rates**, is the
original plan re-run with the recorded events and nothing logged: the gap to
the plan is the world moving, the gap to the re-forecast is what you did.

### The engine is main's; the tracker only adds opt-in hooks

The projection engine is the verified one from `main` (cash pool, plan-year
tax with the July settlement, holiday fund, minimum cash, distribution
schedule, loan re-amortised after a split). The tracker adds hooks to it
without changing what it computes for an ordinary scenario:

- `RunOptions.opening` — start from a position instead of a standing start.
- `RunOptions.actuals` — replay the log: month one's flows override the
  placement, later months' flows move money out of the offset, balances win
  at month end.
- `RunOptions.midStream` — the run stops partway (building an opening), so
  the last month doesn't flush unsettled tax or undistributed yield; the
  closing position carries them.
- `Person.payEvents` and `Loan.rateEvents` — only people and loans that have
  events take the event-aware path; growth stays on plan-year anniversaries.

With none of these in play the output is identical to `main`'s engine:
checked field by field across every preset and stack (361 scenarios, seven
households covering pay and SG, holidays, a cash buffer, a novated lease,
interest-only with restricted offset, and monthly distributions), and
main's own 52 tests pass unchanged.

Known approximations when a new plan starts from an opening position: it
starts a fresh plan year (income growth and the yearly tax base count from
its own start), and its first year charges only the Division 293 / excess
tax its own lump adds — the ongoing contributions' charge for the year in
progress was made by the run that got there.

## Data model

See `types.ts` (`ActualMonth`, `OpeningPosition`, `RisuLot`, `RisuTrade`,
`PayEvent`, `RateEvent`) and `tracker.ts` (`Tracker`, `TrackerView`).

- The tracker's start is the first of its month and overwrites
  `baseline.household.assumptions.startDate`; `horizonYears` is kept.
- Rows carry main's `date` (the ISO first day of the month they cover); the
  log and the tracker view key months as `yyyy-mm`.
- Stack ids are generated, so `scenarioLabel` is display only; the frozen
  allocation (after caps) and frozen months are the plan.
- A re-plan stores its **immutable** `opening` and the root `planSince`, and
  inherits its parent's risu portfolios.

`simulate(household, def, { opening, actuals, planSince })` returns the
result and a `closing` position that can seed the next run. An opening
carries unsettled tax, undistributed yield, one-off concessional
contributions for cap room, the P&I payment in force and the remaining
term. Split on a plan-year boundary, carrying on from a closing position
gives the same month rows as one continuous run (tested).

## API

Keys in the existing `kv` table: `actuals`, `trackers`, `risuLink`.

```
GET    /api/actuals
PUT    /api/actuals/:month              flows, balances, confirmed, note (risu data is kept)
DELETE /api/actuals/:month
POST   /api/actuals/:month/risu         pull every linked portfolio for that month
GET    /api/trackers
POST   /api/trackers                    { household?, allocation, scenarioLabel, label, startDate, risuPortfolios? }
GET    /api/trackers/:id                → TrackerView
PUT    /api/trackers/:id/risu           { portfolios }
DELETE /api/trackers/:id                (the log is kept)
GET    /api/trackers/:id/opening?at=    position at the start of a month, and what's deployable
POST   /api/trackers/:id/replan/preview { at, deploy } → RunReport
POST   /api/trackers/:id/replan         { at, deploy, allocation, scenarioLabel, label }
GET    /api/risu/link, PUT /api/risu/link
GET    /api/risu/portfolios, GET /api/risu/tickers   (proxied from risu)
```

Risu: `GET /api/lots?portfolioId=&asOf=&since=` — open parcels on `asOf`
(AUD cost, market value, value at the cutover) plus buys and matched sells
within `[since, asOf]`. Values reuse risu's holdings valuation per
instrument, so they match its Holdings totals.

## Deployment

`scripts/deploy-hana.sh` sets `RISU_URL` in the Quadlet, default
`http://risu.hana-server` (override with `DEPLOY_RISU_URL`). Not yet verified
that the name resolves from inside the tanuki container; if it doesn't, point
it at risu's Tailscale address.

## Decided

1. Pay events live on the household only.
2. A re-plan asks how much to deploy every time, pre-filled with the offset
   above what has to stay liquid (restricted offset, minimum cash, holiday
   savings so far). Zero offers "Carry on from here".
3. Shares are tracked per person and per sleeve.
4. Tanuki reaches risu over HTTP only.
5. A sell is a negative flow: the month's figure is net dollars invested.
6. Which risu portfolios feed a plan is chosen per plan, and optional.

## Known gaps

- Tax on gains realised by a mid-plan sell is not counted in tanuki's
  wealth figures. Risu's Tax tab has it.
- Risu's API has no auth; the link assumes both apps stay LAN/Tailscale only.
- Re-forecasts use the **saved** household's events; unsaved edits in the
  Plans form don't reach Tracking.
