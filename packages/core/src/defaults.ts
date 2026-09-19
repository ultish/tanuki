import { FY_2026_27 } from "./caps.js";
import type { Assumptions, Household, Person } from "./types.js";

export function defaultPerson(id: Person["id"], overrides: Partial<Person> = {}): Person {
  if (id === "you") {
    return {
      id: "you",
      label: "You",
      marginalRate: 0.45,
      medicareLevy: 0.02,
      taxableIncome: 220_000,
      superBalance: 280_000,
      employerSgThisFy: 0,
      extraConcessionalThisFy: 0,
      unusedConcessionalCarryForward: 0,
      age: 38,
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
    employerSgThisFy: 0,
    extraConcessionalThisFy: 0,
    unusedConcessionalCarryForward: 0,
    age: 36,
    ...overrides,
  };
}

export function defaultAssumptions(overrides: Partial<Assumptions> = {}): Assumptions {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  return {
    horizonYears: 10,
    startDate: iso,
    inflationRate: 0.025,
    incomeGrowthRate: 0,
    growthAsset: {
      label: "Growth (global + AU)",
      growthRate: 0.08,
      yieldRate: 0.015,
      mer: 0.0016,
      frankingPercent: 20,
      reinvestDividends: true,
    },
    incomeAsset: {
      label: "Income (high-yield AU)",
      growthRate: 0.03,
      yieldRate: 0.055,
      mer: 0.0025,
      frankingPercent: 80,
      reinvestDividends: false,
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
    refundsToOffset: true,
    useNccBringForward: true,
    sweepIdleOffset: true,
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
    loan: { ...base.loan, ...(p.loan ?? {}) },
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
  const next: Person = {
    ...base,
    ...p,
    id,
    employerSgThisFy: num(p.employerSgThisFy, base.employerSgThisFy),
    extraConcessionalThisFy: num(
      p.extraConcessionalThisFy,
      hasSplit
        ? base.extraConcessionalThisFy
        : num(p.concessionalUsedThisFy, base.extraConcessionalThisFy),
    ),
  };
  delete (next as { concessionalUsedThisFy?: number }).concessionalUsedThisFy;
  return next;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
