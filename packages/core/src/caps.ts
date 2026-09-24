import type { Assumptions, Person } from "./types.js";

/** FY2026–27 ATO caps (indexed). Update when a new FY starts. */
export const FY_2026_27 = {
  concessionalCap: 32_500,
  nonConcessionalCap: 130_000,
  nccBringForwardCap: 390_000,
  tsbNccLimit: 2_100_000,
  tsbBringForward3y: 1_840_000,
  /** TSB for 2-year bring-forward ($260k) */
  tsbBringForward2y: 1_970_000,
  div293Threshold: 250_000,
  generalTransferBalanceCap: 2_100_000,
} as const;

export function concessionalCommittedThisFy(person: Person): number {
  return (
    Math.max(0, person.employerSgThisFy) +
    Math.max(0, person.extraConcessionalThisFy)
  );
}

export function concessionalRoom(
  person: Person,
  assumptions: Assumptions,
  committed = concessionalCommittedThisFy(person),
): number {
  const cap =
    assumptions.concessionalCap +
    Math.max(0, person.unusedConcessionalCarryForward) -
    committed;
  const againstIncome = Math.max(0, person.taxableIncome);
  return Math.max(0, Math.min(cap, againstIncome));
}

/**
 * NCC room this year. Bring-forward is all-or-nothing in this sketch
 * (we don't track which year of a bring-forward period you're in).
 */
export function nccRoom(
  person: Person,
  assumptions: Assumptions,
  useBringForward: boolean,
): number {
  if (person.age >= 75) return 0;
  if (person.superBalance >= assumptions.tsbNccLimit) return 0;
  if (!useBringForward) return assumptions.nonConcessionalCap;
  if (person.superBalance < assumptions.tsbBringForward3y) {
    return assumptions.nccBringForwardCap;
  }
  // 2-year band: TSB in [tsbBringForward3y, tsbBringForward2y)
  if (person.superBalance < assumptions.tsbBringForward2y) {
    return assumptions.nonConcessionalCap * 2;
  }
  return assumptions.nonConcessionalCap;
}

export function remainingAfter(
  allocated: number,
  room: number,
): { used: number; leftover: number } {
  const used = Math.max(0, Math.min(allocated, room));
  return { used, leftover: Math.max(0, allocated - used) };
}
