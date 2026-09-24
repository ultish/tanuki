import { monthsBetweenIso } from "./tax.js";
import type { Person } from "./types.js";

/**
 * Taxable income and employer SG in force in a given plan month, once real
 * pay events are recorded. Growth follows the engine's own convention —
 * `incomeGrowthRate` steps on each plan-year anniversary — counted from the
 * plan start for the household's figure, and from the event's plan year for
 * a recorded rise. Returns null for a person with no events, so the engine
 * keeps its own yearly figures untouched.
 */
export type PaySchedule = {
  /** Annual taxable income in force in plan month `m` (0-based). */
  taxableAt: (m: number) => number;
  /** Annual employer SG in force in plan month `m`. */
  sgAt: (m: number) => number;
};

export function paySchedule(
  person: Person,
  planStart: string,
  growth: number,
): PaySchedule | null {
  const events = [...(person.payEvents ?? [])].sort((x, y) => x.from.localeCompare(y.from));
  if (!events.length) return null;

  const year = (m: number) => Math.floor(Math.max(0, m) / 12);
  const grow = (fromMonth: number, m: number) =>
    Math.pow(1 + growth, Math.max(0, year(m) - year(fromMonth)));

  type Anchor = { month: number; taxableIncome: number; sg: number };
  const anchors: Anchor[] = [
    {
      month: 0,
      taxableIncome: person.taxableIncome,
      sg: Math.max(0, person.employerSgThisFy),
    },
  ];
  for (const e of events) {
    const month = monthsBetweenIso(planStart, e.from);
    const prev = anchors[anchors.length - 1]!;
    const incomeBefore = prev.taxableIncome * grow(prev.month, month);
    const sgBefore = prev.sg * grow(prev.month, month);
    const sg =
      e.salary != null
        ? Math.max(0, e.salary) * (person.sgRatePercent / 100)
        : incomeBefore > 0
          ? sgBefore * (e.taxableIncome / incomeBefore)
          : sgBefore;
    // An event dated before the plan starts is simply the pay at the start.
    anchors.push({ month: Math.max(0, month), taxableIncome: e.taxableIncome, sg });
  }

  const anchorAt = (m: number): Anchor => {
    let a = anchors[0]!;
    for (const x of anchors) if (x.month <= m) a = x;
    return a;
  };

  return {
    taxableAt: (m) => {
      const a = anchorAt(m);
      return a.taxableIncome * grow(a.month, m);
    },
    sgAt: (m) => {
      const a = anchorAt(m);
      return a.sg * grow(a.month, m);
    },
  };
}
