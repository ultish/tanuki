import { monthKey, runHousehold, simulate } from "./engine.js";
import type { RisuLink } from "./risu.js";
import { addMonthsIso } from "./tax.js";
import type {
  ActualMonth,
  Allocation,
  Household,
  MonthRow,
  PersonId,
  OpeningPosition,
  RunReport,
  ScenarioDef,
  ScenarioResult,
} from "./types.js";

/**
 * A frozen target: the scenario you accepted, as it was projected on the day
 * you accepted it. What actually happened lives once, in the household log,
 * and is joined to whichever tracker you look at.
 */
export type Tracker = {
  id: string;
  label: string;
  createdAt: string;
  /** Display only. Stack ids are generated; the frozen allocation is the plan. */
  scenarioLabel: string;
  /** First of a month. */
  startDate: string;
  baseline: {
    /** Full snapshot, with `assumptions.startDate` set to the tracker's. */
    household: Household;
    /** After caps — exactly what month one places. */
    allocation: Allocation;
    months: MonthRow[];
  };
  /** Set on a re-plan: the tracker it succeeds. */
  parentId?: string;
  /** Set on a re-plan: the immutable position it started from. */
  opening?: OpeningPosition;
  /**
   * Start of the original plan in this succession. Risu parcels bought
   * before it are not the plan's money.
   */
  planSince: string;
  /**
   * Risu portfolios whose parcels stand in for this plan's shares. Empty:
   * this plan ignores risu and uses typed or projected share figures.
   */
  risuPortfolios: number[];
};

export type TrackerMonth = {
  /** "yyyy-mm" */
  date: string;
  /** The frozen target. */
  plan: MonthRow;
  /** Replayed from the log through `lastLogged`, projected after. */
  reforecast: MonthRow;
  /** The original plan re-run with the rate and pay changes recorded since. */
  todaysRates: MonthRow;
  actual?: ActualMonth;
};

export type TrackerOutcome = {
  netWealth: number;
  netIfLiquidated: number;
};

export type TrackerView = {
  tracker: Omit<Tracker, "baseline"> & {
    allocation: Allocation;
    horizonYears: number;
  };
  months: TrackerMonth[];
  /** Last month in range with anything logged, or null. */
  lastLogged: string | null;
  end: {
    plan: TrackerOutcome;
    reforecast: TrackerOutcome;
    todaysRates: TrackerOutcome;
  };
};

/** "2029-03" or "2029-03-17" → "2029-03-01". */
export function firstOfMonth(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`Not a date: ${iso}`);
  return `${m[1]}-${m[2]}-01`;
}

/** Whole months from one first-of-month to another. */
export function monthsBetween(from: string, to: string): number {
  const f = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7));
  const t = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  return t - f;
}

function withStart(h: Household, startDate: string): Household {
  return { ...h, assumptions: { ...h.assumptions, startDate } };
}

/**
 * Recorded pay and rate changes are facts, so they apply to every tracker.
 * Everything else in the frozen household stays as accepted.
 */
function withRecordedEvents(frozen: Household, current: Household): Household {
  return {
    ...frozen,
    you: { ...frozen.you, payEvents: current.you.payEvents },
    spouse: { ...frozen.spouse, payEvents: current.spouse.payEvents },
    loan: { ...frozen.loan, rateEvents: current.loan.rateEvents },
  };
}

function planDef(t: Tracker): ScenarioDef {
  return {
    id: t.id,
    label: t.scenarioLabel,
    summary: "",
    group: "custom",
    allocation: t.baseline.allocation,
  };
}

const NO_LINK: RisuLink = { portfolios: [], tickers: {} };

/**
 * The log as this plan sees it: risu data narrowed to the portfolios it
 * tracks, covering only the people who own them. A plan tracking none
 * doesn't see risu at all.
 */
export function narrowLog(
  log: readonly ActualMonth[],
  portfolios: readonly number[],
  link: RisuLink,
): ActualMonth[] {
  // A portfolio unlinked since the plan chose it no longer counts.
  const chosen = link.portfolios.filter((p) => portfolios.includes(p.id));
  const ids = chosen.map((p) => p.id);
  const covers = [...new Set(chosen.map((p) => p.personId))] as PersonId[];
  const out: ActualMonth[] = [];
  for (const a of log) {
    if (!a.risu) {
      out.push(a);
    } else if (covers.length) {
      out.push({
        ...a,
        risu: {
          ...a.risu,
          covers,
          lots: a.risu.lots.filter((l) => ids.includes(l.portfolioId)),
          trades: a.risu.trades.filter((t) => ids.includes(t.portfolioId)),
        },
      });
    } else {
      const { risu: _risu, ...rest } = a;
      const blank =
        !rest.confirmed &&
        !rest.note &&
        !Object.keys(rest.flows ?? {}).length &&
        !Object.keys(rest.balances ?? {}).length;
      if (!blank) out.push(rest);
    }
  }
  return out;
}

function logMap(log: readonly ActualMonth[]): Map<string, ActualMonth> {
  return new Map(log.map((a) => [a.date, a]));
}

function outcome(r: ScenarioResult): TrackerOutcome {
  return { netWealth: r.netWealth, netIfLiquidated: r.netIfLiquidated };
}

export function createTracker(input: {
  id: string;
  createdAt: string;
  label: string;
  scenarioLabel: string;
  allocation: Allocation;
  startDate: string;
  household: Household;
  risuPortfolios?: number[];
}): Tracker {
  const startDate = firstOfMonth(input.startDate);
  // The tracker's start overrides the household's, or the engine would
  // project from the household's date and ignore the one you picked.
  const household = withStart(input.household, startDate);
  const { result } = simulate(household, {
    id: input.id,
    label: input.scenarioLabel,
    summary: "",
    group: "custom",
    allocation: input.allocation,
  });
  return {
    id: input.id,
    label: input.label,
    createdAt: input.createdAt,
    scenarioLabel: input.scenarioLabel,
    startDate,
    baseline: {
      household,
      allocation: result.appliedAllocation,
      months: result.months,
    },
    planSince: startDate,
    risuPortfolios: input.risuPortfolios ?? [],
  };
}

export function viewTracker(
  t: Tracker,
  current: Household,
  fullLog: readonly ActualMonth[],
  link: RisuLink = NO_LINK,
): TrackerView {
  const log = narrowLog(fullLog, t.risuPortfolios ?? [], link);
  const recorded = withRecordedEvents(t.baseline.household, current);
  const def = planDef(t);
  const actuals = logMap(log);
  const reforecast = simulate(recorded, def, {
    opening: t.opening,
    actuals,
    planSince: t.planSince,
  }).result;
  const todaysRates = simulate(recorded, def, { opening: t.opening }).result;

  const first = monthKey(t.startDate);
  const last = t.baseline.months.at(-1)?.date ?? first;
  let lastLogged: string | null = null;
  for (const a of log) {
    if (a.date >= first && a.date <= last && (!lastLogged || a.date > lastLogged)) {
      lastLogged = a.date;
    }
  }

  const planEnd = simulate(t.baseline.household, def, { opening: t.opening }).result;
  const { baseline, ...rest } = t;
  return {
    tracker: {
      ...rest,
      risuPortfolios: t.risuPortfolios ?? [],
      allocation: baseline.allocation,
      horizonYears: baseline.household.assumptions.horizonYears,
    },
    months: t.baseline.months.map((plan, i) => ({
      date: plan.date,
      plan,
      reforecast: reforecast.months[i]!,
      todaysRates: todaysRates.months[i]!,
      actual: actuals.get(plan.date),
    })),
    lastLogged,
    end: {
      plan: outcome(planEnd),
      reforecast: outcome(reforecast),
      todaysRates: outcome(todaysRates),
    },
  };
}

/**
 * Where the log says you are at the start of month `at` ("yyyy-mm"):
 * replay this tracker through the month before it.
 */
export function openingAt(
  t: Tracker,
  current: Household,
  fullLog: readonly ActualMonth[],
  at: string,
  link: RisuLink = NO_LINK,
): OpeningPosition {
  const log = narrowLog(fullLog, t.risuPortfolios ?? [], link);
  const n = monthsBetween(t.startDate, firstOfMonth(at));
  if (n < 1 || n > t.baseline.months.length) {
    throw new Error(
      `${at} is outside this plan. Pick a month after ${monthKey(t.startDate)} and no later than its end.`,
    );
  }
  const recorded = withRecordedEvents(t.baseline.household, current);
  const h = { ...recorded, assumptions: { ...recorded.assumptions, horizonYears: n / 12 } };
  return simulate(h, planDef(t), {
    opening: t.opening,
    actuals: logMap(log),
    planSince: t.planSince,
  }).closing;
}

/** Offset you could still move: everything above the restricted floor. */
export function deployable(opening: OpeningPosition, h: Household): number {
  return Math.max(0, opening.offset - Math.max(0, h.loan.restrictedOffset ?? 0));
}

/**
 * The household a re-plan runs on: today's settings, starting where the log
 * says you are, with `deploy` of the offset as the lump to place.
 */
function replanSetup(
  current: Household,
  opening: OpeningPosition,
  deploy: number,
): { household: Household; opening: OpeningPosition } {
  const room = deployable(opening, current);
  if (!(deploy >= 0) || deploy > room + 0.5) {
    throw new Error(
      `Can only deploy up to $${Math.round(room).toLocaleString("en-AU")}, the offset above the restricted floor.`,
    );
  }
  return {
    household: {
      ...current,
      lumpSum: deploy,
      you: { ...current.you, superBalance: opening.superYou },
      spouse: { ...current.spouse, superBalance: opening.superSpouse },
      loan: {
        ...current.loan,
        balance: opening.homeLoan,
        offset: opening.offset - deploy,
      },
      assumptions: { ...current.assumptions, startDate: opening.date },
    },
    opening: { ...opening, offset: opening.offset - deploy },
  };
}

/** Every scenario for a re-plan, ranked the same way as the main view. */
export function replanPreview(
  parent: Tracker,
  current: Household,
  log: readonly ActualMonth[],
  at: string,
  deploy: number,
  link: RisuLink = NO_LINK,
): RunReport {
  const setup = replanSetup(current, openingAt(parent, current, log, at, link), deploy);
  // With nothing to place there's nothing to rank: the only plan is to
  // carry on from here, which is the re-baseline.
  const carryOn: ScenarioDef = {
    id: "carry-on",
    label: "Carry on from here",
    summary: "Nothing new placed. The same ongoing rules, from where the log says you are.",
    group: "custom",
    allocation: {},
  };
  return runHousehold(setup.household, deploy > 0.5 ? [] : [carryOn], {
    opening: setup.opening,
    planSince: parent.planSince,
  });
}

export function createReplan(input: {
  id: string;
  createdAt: string;
  label: string;
  scenarioLabel: string;
  allocation: Allocation;
  parent: Tracker;
  current: Household;
  log: readonly ActualMonth[];
  at: string;
  deploy: number;
  link?: RisuLink;
}): Tracker {
  const opening = openingAt(input.parent, input.current, input.log, input.at, input.link);
  const setup = replanSetup(input.current, opening, input.deploy);
  const { result } = simulate(
    setup.household,
    {
      id: input.id,
      label: input.scenarioLabel,
      summary: "",
      group: "custom",
      allocation: input.allocation,
    },
    { opening: setup.opening, planSince: input.parent.planSince },
  );
  return {
    id: input.id,
    label: input.label,
    createdAt: input.createdAt,
    scenarioLabel: input.scenarioLabel,
    startDate: setup.opening.date,
    baseline: {
      household: setup.household,
      allocation: result.appliedAllocation,
      months: result.months,
    },
    parentId: input.parent.id,
    opening: setup.opening,
    planSince: input.parent.planSince,
    risuPortfolios: input.parent.risuPortfolios ?? [],
  };
}

/** Insert or replace one month of the log, kept in date order. */
export function upsertActual(
  log: readonly ActualMonth[],
  entry: ActualMonth,
): ActualMonth[] {
  return [...log.filter((a) => a.date !== entry.date), entry].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

/** The first of the month after `iso`'s month — a sensible default tracker start. */
export function nextMonthStart(iso: string): string {
  return addMonthsIso(firstOfMonth(iso), 1);
}
