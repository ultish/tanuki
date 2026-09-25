import { CGT_REGIME_CUTOVER_ISO, type Person } from "./types.js";

export const COMPANY_TAX_RATE = 0.3;
export const POST_2027_CGT_MIN_RATE = 0.3;
export const DEFAULT_CGT_INFLATION_RATE = 0.025;

/** Resident PIT thresholds for FY2026-27. Last rate applies above 190k. */
export const RESIDENT_BRACKETS_FY2026_27: readonly {
  upTo: number;
  rate: number;
}[] = [
  { upTo: 18_200, rate: 0 },
  { upTo: 45_000, rate: 0.15 },
  { upTo: 135_000, rate: 0.3 },
  { upTo: 190_000, rate: 0.37 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.45 },
];

export function combinedMarginalRate(person: {
  marginalRate: number;
  medicareLevy: number;
}): number {
  return person.marginalRate + person.medicareLevy;
}

export function lastDollarPit(taxableIncome: number): number {
  const y = Math.max(0, taxableIncome);
  for (const b of RESIDENT_BRACKETS_FY2026_27) {
    if (y <= b.upTo) return b.rate;
  }
  return 0.45;
}

export function lastDollarCombined(person: {
  taxableIncome: number;
  medicareLevy: number;
}): number {
  return lastDollarPit(person.taxableIncome) + Math.max(0, person.medicareLevy);
}

export function bracketTax(income: number): number {
  if (income <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of RESIDENT_BRACKETS_FY2026_27) {
    const slice = Math.min(income, b.upTo) - prev;
    if (slice > 0) tax += slice * b.rate;
    prev = b.upTo;
    if (income <= b.upTo) break;
  }
  return tax;
}

export function incomeTax(taxableIncome: number, medicareLevy: number): number {
  const y = Math.max(0, taxableIncome);
  return bracketTax(y) + y * Math.max(0, medicareLevy);
}

export function taxDelta(
  base: number,
  extra: number,
  medicareLevy: number,
): number {
  return incomeTax(base + extra, medicareLevy) - incomeTax(base, medicareLevy);
}

export function post2027CgtRateOnGain(person: {
  taxableIncome: number;
  medicareLevy: number;
}): number {
  return Math.max(lastDollarCombined(person), POST_2027_CGT_MIN_RATE);
}

export function monthlyRate(annual: number): number {
  if (annual <= -1) return 0;
  return Math.pow(1 + annual, 1 / 12) - 1;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Inclusive day count between ISO dates. */
export function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/** Whole calendar months between two ISO dates (year/month only, day ignored). */
export function monthsBetweenIso(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  if (!fy || !fm || !ty || !tm) return 0;
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * Add calendar months, clamping the day to the end of a shorter target
 * month (e.g. Jan 31 + 1 month = Feb 28, not a rollover into March).
 */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const totalMonths = y * 12 + (m - 1) + months;
  const ty = Math.floor(totalMonths / 12);
  const tm = totalMonths - ty * 12;
  const daysInTargetMonth = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const td = Math.min(d, daysInTargetMonth);
  const mm = String(tm + 1).padStart(2, "0");
  const dd = String(td).padStart(2, "0");
  return `${ty}-${mm}-${dd}`;
}

export function frankingCredits(cashAud: number, frankingPercent: number): number {
  const f = Math.max(0, Math.min(100, frankingPercent)) / 100;
  if (cashAud <= 0 || f <= 0) return 0;
  return cashAud * f * (COMPANY_TAX_RATE / (1 - COMPANY_TAX_RATE));
}

export type HybridCgtInput = {
  proceeds: number;
  /** Nominal cost at purchase */
  cost: number;
  acquiredDate: string;
  disposedDate: string;
  /** Portfolio value on 1 Jul 2027; if omitted, interpolate by time */
  valueAtCutover?: number;
  inflationRate: number;
  person: Pick<Person, "taxableIncome" | "medicareLevy">;
};

export type HybridCgtResult = {
  tax: number;
  taxIfLegacyDiscount: number;
  preGain: number;
  postGain: number;
  notes: string[];
};

/**
 * CGT on a disposal that may straddle 1 Jul 2027.
 *
 * - Disposal before cutover: 50% discount if held ≥ 12 months, else full MTR.
 * - Acquisition on/after cutover: CPI-index cost; tax = indexed gain × max(MTR, 30%).
 * - Straddle: pre-cutover gain uses old discount (if held 12 months by the
 *   actual sale — s 112-160(3)(c) tests the deemed 30 June 2027 sale as if it
 *   happened on the day of the real one); post-cutover gain uses indexation
 *   from the cutover value + 30% floor.
 */
export function estimateHybridCgt(input: HybridCgtInput): HybridCgtResult {
  const notes: string[] = [];
  const med = input.person.medicareLevy;
  const base = input.person.taxableIncome;
  const gainNominal = input.proceeds - input.cost;
  const longTerm =
    daysBetweenIso(input.acquiredDate, input.disposedDate) >= 365;
  const legacyTax =
    gainNominal <= 0
      ? 0
      : longTerm
        ? taxDelta(base, gainNominal * 0.5, med)
        : taxDelta(base, gainNominal, med);

  if (input.proceeds <= 0) {
    return { tax: 0, taxIfLegacyDiscount: 0, preGain: 0, postGain: 0, notes };
  }

  if (input.disposedDate < CGT_REGIME_CUTOVER_ISO) {
    const longTerm = daysBetweenIso(input.acquiredDate, input.disposedDate) >= 365;
    notes.push(
      longTerm
        ? "Sold before 1 Jul 2027. 50% CGT discount."
        : "Sold before 1 Jul 2027 and held under 12 months. Full marginal rate.",
    );
    const tax =
      gainNominal <= 0
        ? 0
        : longTerm
          ? taxDelta(base, gainNominal * 0.5, med)
          : taxDelta(base, gainNominal, med);
    return {
      tax: round2(tax),
      taxIfLegacyDiscount: round2(legacyTax),
      preGain: round2(gainNominal),
      postGain: 0,
      notes,
    };
  }

  if (input.acquiredDate >= CGT_REGIME_CUTOVER_ISO) {
    const years = daysBetweenIso(input.acquiredDate, input.disposedDate) / 365.25;
    const indexed = input.cost * Math.pow(1 + input.inflationRate, Math.max(0, years));
    const postGain = input.proceeds - indexed;
    const taxable = Math.max(0, postGain);
    const scaleTax = taxDelta(base, taxable, med);
    const floor = taxable * POST_2027_CGT_MIN_RATE;
    const tax = Math.max(scaleTax, floor);
    notes.push(
      "Acquired after 1 Jul 2027. CPI indexation. Taxed on the real gain at the FY2026-27 scale, with a 30% minimum.",
    );
    return {
      tax: round2(tax),
      taxIfLegacyDiscount: round2(legacyTax),
      preGain: 0,
      postGain: round2(postGain),
      notes,
    };
  }

  const cutoverValue =
    input.valueAtCutover ??
    interpolateCutoverValue(
      input.cost,
      input.proceeds,
      input.acquiredDate,
      input.disposedDate,
    );
  const preGain = cutoverValue - input.cost;
  // The 12 months runs from purchase to the actual sale, not to the cutover.
  const preTaxable = preGain <= 0 ? 0 : longTerm ? preGain * 0.5 : preGain;
  const preTax = preTaxable <= 0 ? 0 : taxDelta(base, preTaxable, med);
  notes.push(
    longTerm
      ? "Gain before 1 Jul 2027 keeps the 50% discount."
      : "Sold within 12 months of buying. Gain up to 1 Jul 2027 is at full marginal rate, no discount.",
  );

  const yearsAfter =
    daysBetweenIso(CGT_REGIME_CUTOVER_ISO, input.disposedDate) / 365.25;
  const indexedPost =
    cutoverValue * Math.pow(1 + input.inflationRate, Math.max(0, yearsAfter));
  const postGain = input.proceeds - indexedPost;
  const postTaxable = Math.max(0, postGain);
  const postScale = taxDelta(base + preTaxable, postTaxable, med);
  const postTax = Math.max(postScale, postTaxable * POST_2027_CGT_MIN_RATE);
  notes.push(
    "Gain after 1 Jul 2027. Cost resets to value at cutover, then CPI-indexed. Taxed on the real gain at the scale, with a 30% minimum.",
  );

  return {
    tax: round2(Math.max(0, preTax) + postTax),
    taxIfLegacyDiscount: round2(legacyTax),
    preGain: round2(preGain),
    postGain: round2(postGain),
    notes,
  };
}

function interpolateCutoverValue(
  cost: number,
  proceeds: number,
  acquired: string,
  disposed: string,
): number {
  const total = daysBetweenIso(acquired, disposed);
  const toCut = daysBetweenIso(acquired, CGT_REGIME_CUTOVER_ISO);
  if (total <= 0) return cost;
  const t = Math.max(0, Math.min(1, toCut / total));
  return cost + (proceeds - cost) * t;
}

/**
 * Division 293: extra 15% on concessional contributions once taxable income
 * + concessional contributions exceed $250k. Levied on the individual, not
 * taken out of the fund (fund still withholds 15%).
 */
export function division293Tax(
  taxableIncome: number,
  concessionalThisFy: number,
  threshold: number,
): number {
  const over = taxableIncome + concessionalThisFy - threshold;
  if (over <= 0 || concessionalThisFy <= 0) return 0;
  return Math.min(concessionalThisFy, over) * 0.15;
}
