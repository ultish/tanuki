import { CGT_REGIME_CUTOVER_ISO, type Person } from "./types.js";

export const COMPANY_TAX_RATE = 0.3;
export const POST_2027_CGT_MIN_RATE = 0.3;
export const DEFAULT_CGT_INFLATION_RATE = 0.025;

export function combinedMarginalRate(person: {
  marginalRate: number;
  medicareLevy: number;
}): number {
  return person.marginalRate + person.medicareLevy;
}

export function post2027CgtRateOnGain(person: {
  marginalRate: number;
  medicareLevy: number;
}): number {
  return Math.max(combinedMarginalRate(person), POST_2027_CGT_MIN_RATE);
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

export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function frankingCredits(cashAud: number, frankingPercent: number): number {
  const f = Math.max(0, Math.min(100, frankingPercent)) / 100;
  if (cashAud <= 0 || f <= 0) return 0;
  return cashAud * f * (COMPANY_TAX_RATE / (1 - COMPANY_TAX_RATE));
}

/**
 * Net tax on a cash dividend after franking offset (refundable if negative).
 */
export function dividendTax(
  cashAud: number,
  frankingPercent: number,
  person: Pick<Person, "marginalRate" | "medicareLevy">,
): number {
  if (cashAud <= 0) return 0;
  const credits = frankingCredits(cashAud, frankingPercent);
  const assessable = cashAud + credits;
  const gross = assessable * combinedMarginalRate(person);
  return gross - credits;
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
  person: Pick<Person, "marginalRate" | "medicareLevy">;
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
 * - Straddle: pre-cutover gain uses old discount (if 12 months held at cutover);
 *   post-cutover gain uses indexation from the cutover value + 30% floor.
 */
export function estimateHybridCgt(input: HybridCgtInput): HybridCgtResult {
  const notes: string[] = [];
  const mtr = combinedMarginalRate(input.person);
  const gainNominal = input.proceeds - input.cost;
  const legacyTax =
    gainNominal <= 0
      ? 0
      : daysBetweenIso(input.acquiredDate, input.disposedDate) >= 365
        ? gainNominal * 0.5 * mtr
        : gainNominal * mtr;

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
    const tax = gainNominal <= 0 ? 0 : longTerm ? gainNominal * 0.5 * mtr : gainNominal * mtr;
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
    const rate = post2027CgtRateOnGain(input.person);
    notes.push(
      `Acquired after 1 Jul 2027. CPI indexation, ${(rate * 100).toFixed(0)}% on the real gain, the higher of your rate and 30%.`,
    );
    return {
      tax: round2(Math.max(0, postGain) * rate),
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
  const held12AtCutover =
    daysBetweenIso(input.acquiredDate, CGT_REGIME_CUTOVER_ISO) >= 365;
  const preTax =
    preGain <= 0
      ? 0
      : held12AtCutover
        ? preGain * 0.5 * mtr
        : preGain * mtr;
  notes.push(
    held12AtCutover
      ? "Gain before 1 Jul 2027 keeps the 50% discount."
      : "Bought less than 12 months before 1 Jul 2027. Gain up to that day is modelled at full marginal rate, no discount.",
  );

  const yearsAfter =
    daysBetweenIso(CGT_REGIME_CUTOVER_ISO, input.disposedDate) / 365.25;
  const indexedPost =
    cutoverValue * Math.pow(1 + input.inflationRate, Math.max(0, yearsAfter));
  const postGain = input.proceeds - indexedPost;
  const postRate = post2027CgtRateOnGain(input.person);
  const postTax = Math.max(0, postGain) * postRate;
  notes.push(
    `Gain after 1 Jul 2027. Cost resets to value at cutover, then CPI-indexed. ${(postRate * 100).toFixed(0)}% on the real gain.`,
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
