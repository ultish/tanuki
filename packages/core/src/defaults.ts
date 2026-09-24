import { FY_2026_27 } from "./caps.js";
import { monthsBetweenIso, round2 } from "./tax.js";
import type { Assumptions, Household, PayEvent, Person, RateEvent } from "./types.js";

/** Legislated Super Guarantee rate default, FY2026-27. */
const DEFAULT_SG_RATE_PERCENT = 12;

/** `salary * sgRatePercent / 100` — the formula behind `Person.employerSgThisFy`. */
export function annualSg(salary: number, sgRatePercent: number): number {
  return round2(salary * (sgRatePercent / 100));
}

/** `fortnightly * 26` — the formula behind `Person.extraConcessionalThisFy`. */
export function annualFromFortnightly(fortnightly: number): number {
  return round2(fortnightly * 26);
}

/**
 * A novated lease is a pre-tax deduction with an end date, unlike super
 * salary sacrifice — `taxableIncome` already nets it out while it's
 * active, but once `novatedLeaseEndDate` passes, that fixed amount (it
 * doesn't grow — it's a fixed lease payment) reverts to taxable, prorated
 * for the plan-year it happens in. `startDate` is the plan's own start
 * (`Assumptions.startDate`) — "months remaining" is always measured from
 * there, not stored, so the end date never needs updating as time passes.
 * `yearIndex` is 0-based (0 = the plan's first year). A person with no
 * lease configured (`novatedLeaseFortnightly` is 0, the default) is
 * always unaffected.
 */
export function leaseAddback(
  person: Pick<Person, "novatedLeaseFortnightly" | "novatedLeaseEndDate">,
  startDate: string,
  yearIndex: number,
): number {
  if (person.novatedLeaseFortnightly <= 0 || !person.novatedLeaseEndDate) {
    return 0;
  }
  const monthsRemaining = monthsBetweenIso(startDate, person.novatedLeaseEndDate);
  const yearStartMonth = yearIndex * 12;
  const monthsActiveThisYear = Math.max(
    0,
    Math.min(12, monthsRemaining - yearStartMonth),
  );
  const annualLease = person.novatedLeaseFortnightly * 26;
  return round2(annualLease * (1 - monthsActiveThisYear / 12));
}

export function defaultPerson(id: Person["id"], overrides: Partial<Person> = {}): Person {
  if (id === "you") {
    return {
      id: "you",
      label: "You",
      marginalRate: 0.45,
      medicareLevy: 0.02,
      taxableIncome: 220_000,
      superBalance: 280_000,
      salary: 0,
      sgRatePercent: DEFAULT_SG_RATE_PERCENT,
      extraConcessionalFortnightly: 0,
      employerSgThisFy: 0,
      extraConcessionalThisFy: 0,
      unusedConcessionalCarryForward: 0,
      age: 38,
      novatedLeaseFortnightly: 0,
      novatedLeaseEndDate: "",
      ...overrides,
    };
  }
  return {
    id: "spouse",
    label: "Spouse",
    marginalRate: 0.3,
    medicareLevy: 0.02,
    taxableIncome: 90_000,
    superBalance: 160_000,
    salary: 0,
    sgRatePercent: DEFAULT_SG_RATE_PERCENT,
    extraConcessionalFortnightly: 0,
    employerSgThisFy: 0,
    extraConcessionalThisFy: 0,
    unusedConcessionalCarryForward: 0,
    age: 36,
    novatedLeaseFortnightly: 0,
    novatedLeaseEndDate: "",
    ...overrides,
  };
}

export function defaultAssumptions(overrides: Partial<Assumptions> = {}): Assumptions {
  // Start at a calendar-year boundary so every annual step — income growth,
  // the holiday fund, the plan-year rows — lands on 1 January instead of on
  // the anniversary of whatever day the household was first set up.
  const nextNewYear = `${new Date().getUTCFullYear() + 1}-01-01`;
  return {
    horizonYears: 10,
    startDate: nextNewYear,
    inflationRate: 0.025,
    incomeGrowthRate: 0,
    growthAsset: {
      label: "Growth (global + AU)",
      growthRate: 0.08,
      yieldRate: 0.015,
      mer: 0.0016,
      frankingPercent: 20,
      reinvestDividends: true,
      distributionsPerYear: 4,
    },
    incomeAsset: {
      label: "Income (high-yield AU)",
      growthRate: 0.03,
      yieldRate: 0.055,
      mer: 0.0025,
      frankingPercent: 80,
      reinvestDividends: false,
      distributionsPerYear: 4,
    },
    superReturnRate: 0.075,
    superEarningsTax: 0.15,
    concessionalContributionsTax: 0.15,
    div293Threshold: FY_2026_27.div293Threshold,
    concessionalCap: FY_2026_27.concessionalCap,
    nonConcessionalCap: FY_2026_27.nonConcessionalCap,
    nccBringForwardCap: FY_2026_27.nccBringForwardCap,
    tsbNccLimit: FY_2026_27.tsbNccLimit,
    tsbBringForward3y: FY_2026_27.tsbBringForward3y,
    tsbBringForward2y: FY_2026_27.tsbBringForward2y,
    investmentLoanRate: null,
    refundsToOffset: true,
    useNccBringForward: true,
    sweepIdleOffset: true,
    minimumCash: 0,
    monthlyExpenses: 0,
    annualHolidaySpend: 0,
    holidayMonth: 1,
    holidayFundOnTop: true,
    pooledIncome: true,
    ...overrides,
  };
}

export function defaultHousehold(overrides: Partial<Household> = {}): Household {
  const base: Household = {
    lumpSum: 250_000,
    you: defaultPerson("you"),
    spouse: defaultPerson("spouse"),
    loan: {
      balance: 650_000,
      offset: 80_000,
      annualRate: 0.058,
      remainingYears: 25,
      interestOnly: false,
    },
    assumptions: defaultAssumptions(),
  };
  return mergeHousehold(base, overrides);
}

/** Deep-ish merge so API PUTs can send a partial household. */
export function mergeHousehold(
  base: Household,
  patch: Partial<Household> | Record<string, unknown>,
): Household {
  const p = patch as Partial<Household>;
  return {
    lumpSum: num(p.lumpSum, base.lumpSum),
    you: mergePerson(base.you, p.you, "you"),
    spouse: mergePerson(base.spouse, p.spouse, "spouse"),
    loan: (() => {
      const loan = { ...base.loan, ...(p.loan ?? {}) };
      const rateEvents = cleanRateEvents(loan.rateEvents);
      if (rateEvents) loan.rateEvents = rateEvents;
      else delete loan.rateEvents;
      return loan;
    })(),
    assumptions: {
      ...base.assumptions,
      ...(p.assumptions ?? {}),
      growthAsset: {
        ...base.assumptions.growthAsset,
        ...(p.assumptions?.growthAsset ?? {}),
      },
      incomeAsset: {
        ...base.assumptions.incomeAsset,
        ...(p.assumptions?.incomeAsset ?? {}),
      },
    },
  };
}

function mergePerson(
  base: Person,
  patch: Partial<Person> | undefined,
  id: Person["id"],
): Person {
  const p = (patch ?? {}) as Partial<Person> & {
    concessionalUsedThisFy?: number;
  };
  const hasSplit =
    p.employerSgThisFy != null || p.extraConcessionalThisFy != null;

  const sgRatePercent = num(p.sgRatePercent, base.sgRatePercent);
  // Old saves only had the annual dollar amount. First time one of those
  // shows up without the new % fields, back it into a salary/fortnightly
  // figure so the UI has something sane to show instead of 0.
  const salary =
    p.salary != null
      ? num(p.salary, base.salary)
      : p.employerSgThisFy != null && sgRatePercent > 0
        ? round2((p.employerSgThisFy / sgRatePercent) * 100)
        : base.salary;
  const extraConcessionalFortnightly =
    p.extraConcessionalFortnightly != null
      ? num(p.extraConcessionalFortnightly, base.extraConcessionalFortnightly)
      : p.extraConcessionalThisFy != null
        ? round2(p.extraConcessionalThisFy / 26)
        : hasSplit
          ? base.extraConcessionalFortnightly
          : p.concessionalUsedThisFy != null
            ? round2(p.concessionalUsedThisFy / 26)
            : base.extraConcessionalFortnightly;

  const next: Person = {
    ...base,
    ...p,
    id,
    salary,
    sgRatePercent,
    extraConcessionalFortnightly,
    employerSgThisFy: annualSg(salary, sgRatePercent),
    extraConcessionalThisFy: annualFromFortnightly(extraConcessionalFortnightly),
  };
  delete (next as { concessionalUsedThisFy?: number }).concessionalUsedThisFy;
  const payEvents = cleanPayEvents(next.payEvents);
  if (payEvents) next.payEvents = payEvents;
  else delete next.payEvents;
  return next;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Drop malformed events and keep them in date order. Undefined when none are left. */
function cleanPayEvents(raw: unknown): PayEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PayEvent[] = [];
  for (const e of raw as Partial<PayEvent>[]) {
    if (typeof e?.from !== "string" || !ISO_DATE.test(e.from)) continue;
    if (typeof e.taxableIncome !== "number" || !Number.isFinite(e.taxableIncome)) continue;
    const ev: PayEvent = { from: e.from, taxableIncome: e.taxableIncome };
    if (typeof e.salary === "number" && Number.isFinite(e.salary)) ev.salary = e.salary;
    out.push(ev);
  }
  out.sort((a, b) => a.from.localeCompare(b.from));
  return out.length ? out : undefined;
}

function cleanRateEvents(raw: unknown): RateEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RateEvent[] = [];
  for (const e of raw as Partial<RateEvent>[]) {
    if (typeof e?.from !== "string" || !ISO_DATE.test(e.from)) continue;
    if (typeof e.annualRate !== "number" || !Number.isFinite(e.annualRate)) continue;
    out.push({ from: e.from, annualRate: e.annualRate });
  }
  out.sort((a, b) => a.from.localeCompare(b.from));
  return out.length ? out : undefined;
}
