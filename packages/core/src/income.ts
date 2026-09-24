import { addMonthsIso } from "./tax.js";
import type { Person } from "./types.js";

/** Australian financial year a date falls in, named by its starting year: 2026-09-01 → 2026. */
export function fyOf(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m >= 7 ? y : y - 1;
}

/** Annual rates in force on a given date. */
export type IncomeRates = {
  taxableIncome: number;
  /** Employer SG. */
  sg: number;
  /** Salary sacrifice / personal deductible, the household's planned amount. */
  sacrifice: number;
};

export type IncomeSchedule = {
  at: (iso: string) => IncomeRates;
  /** Sums over the twelve months of a financial year. */
  fy: (fy: number) => { taxableIncome: number; work: number };
};

/**
 * Income as a function of the month. `incomeGrowthRate` compounds each
 * 1 July — counted from the plan start for the household figure, and from
 * the event date for a recorded pay event. Months of the first FY before the
 * plan starts use the household figure, so an FY sum is a full year.
 */
export function incomeSchedule(
  person: Person,
  planStart: string,
  growth: number,
): IncomeSchedule {
  const grow = (from: string, to: string) =>
    Math.pow(1 + growth, Math.max(0, fyOf(to) - fyOf(from)));

  type Anchor = { from: string; taxableIncome: number; sg: number };
  const base: Anchor = {
    from: planStart,
    taxableIncome: person.taxableIncome,
    sg: Math.max(0, person.employerSgThisFy),
  };
  const anchors: Anchor[] = [];
  let prev = base;
  const events = [...(person.payEvents ?? [])].sort((a, b) =>
    a.from.localeCompare(b.from),
  );
  for (const e of events) {
    const incomeBefore = prev.taxableIncome * grow(prev.from, e.from);
    const sgBefore = prev.sg * grow(prev.from, e.from);
    const sg =
      e.salary != null
        ? Math.max(0, e.salary) * (person.sgRatePercent / 100)
        : incomeBefore > 0
          ? sgBefore * (e.taxableIncome / incomeBefore)
          : sgBefore;
    prev = { from: e.from, taxableIncome: e.taxableIncome, sg };
    anchors.push(prev);
  }

  const at = (iso: string): IncomeRates => {
    let a = base;
    for (const x of anchors) if (x.from <= iso) a = x;
    const g = grow(a.from, iso);
    return {
      taxableIncome: a.taxableIncome * g,
      sg: a.sg * g,
      sacrifice:
        Math.max(0, person.extraConcessionalThisFy) * grow(planStart, iso),
    };
  };

  const cache = new Map<number, { taxableIncome: number; work: number }>();
  const fy = (year: number) => {
    const hit = cache.get(year);
    if (hit) return hit;
    let taxableIncome = 0;
    let work = 0;
    for (let i = 0; i < 12; i++) {
      const r = at(addMonthsIso(`${year}-07-01`, i));
      taxableIncome += r.taxableIncome / 12;
      work += (r.sg + r.sacrifice) / 12;
    }
    const out = { taxableIncome, work };
    cache.set(year, out);
    return out;
  };

  return { at, fy };
}
