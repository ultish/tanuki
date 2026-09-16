import { concessionalRoom, nccRoom, remainingAfter } from "./caps.js";
import { pmt, stepHomeLoan } from "./loan.js";
import { buildPresets } from "./presets.js";
import {
  addMonthsIso,
  combinedMarginalRate,
  dividendTax,
  division293Tax,
  estimateHybridCgt,
  monthlyRate,
  round2,
} from "./tax.js";
import {
  DISCLAIMER,
  type Allocation,
  type AssetSleeve,
  type Assumptions,
  type BucketId,
  type Household,
  type Person,
  type RunReport,
  type ScenarioDef,
  type ScenarioResult,
  type YearRow,
} from "./types.js";

const BUCKETS: BucketId[] = [
  "offset",
  "extra_repay",
  "taxable_you_growth",
  "taxable_you_income",
  "taxable_spouse_growth",
  "taxable_spouse_income",
  "debt_recycle_you_growth",
  "debt_recycle_you_income",
  "super_cc_you",
  "super_cc_spouse",
  "super_ncc_you",
  "super_ncc_spouse",
];

type SleeveState = {
  value: number;
  cost: number;
  valueAtCutover: number | null;
  sleeve: AssetSleeve;
  person: Person;
};

type SimState = {
  homeLoan: number;
  offset: number;
  invLoan: number;
  superYou: number;
  superSpouse: number;
  sleeves: SleeveState[];
  cash: number;
};

export function allocationSum(a: Allocation): number {
  let s = 0;
  for (const id of BUCKETS) s += a[id] ?? 0;
  return s;
}

/**
 * Clamp super buckets to remaining caps and dump leftover into offset so the
 * lump is always fully placed.
 */
export function applyCaps(
  household: Household,
  allocation: Allocation,
): { applied: Allocation; warnings: string[] } {
  const warnings: string[] = [];
  const applied: Allocation = { ...allocation };
  let leftover = 0;

  const clampSuper = (
    bucket: BucketId,
    room: number,
    label: string,
  ) => {
    const want = applied[bucket] ?? 0;
    const { used, leftover: extra } = remainingAfter(want, room);
    if (extra > 0.5) {
      warnings.push(
        `${label} asked for $${Math.round(want).toLocaleString("en-AU")}. Room is $${Math.round(room).toLocaleString("en-AU")}. Extra parked in offset.`,
      );
      leftover += extra;
    }
    if (used > 0) applied[bucket] = used;
    else delete applied[bucket];
  };

  clampSuper(
    "super_cc_you",
    concessionalRoom(household.you, household.assumptions),
    "Your concessional",
  );
  clampSuper(
    "super_cc_spouse",
    concessionalRoom(household.spouse, household.assumptions),
    "Spouse concessional",
  );
  clampSuper(
    "super_ncc_you",
    nccRoom(
      household.you,
      household.assumptions,
      household.assumptions.useNccBringForward,
    ),
    "Your non-concessional",
  );
  clampSuper(
    "super_ncc_spouse",
    nccRoom(
      household.spouse,
      household.assumptions,
      household.assumptions.useNccBringForward,
    ),
    "Spouse non-concessional",
  );

  if (leftover > 0.5) {
    applied.offset = (applied.offset ?? 0) + leftover;
  }
  return { applied, warnings };
}

export function runScenario(
  household: Household,
  def: ScenarioDef,
): ScenarioResult {
  const { applied, warnings } = applyCaps(household, def.allocation);
  const a = household.assumptions;
  const months = Math.max(1, Math.round(a.horizonYears * 12));
  const start = a.startDate;
  const invRate = a.investmentLoanRate ?? household.loan.annualRate;
  const scheduled =
    household.loan.monthlyRepayment ??
    pmt(
      household.loan.balance,
      household.loan.annualRate,
      household.loan.remainingYears,
    );

  const state: SimState = {
    homeLoan: household.loan.balance,
    offset: household.loan.offset,
    invLoan: 0,
    superYou: household.you.superBalance,
    superSpouse: household.spouse.superBalance,
    sleeves: [],
    cash: 0,
  };

  const addSleeve = (amount: number, sleeve: AssetSleeve, person: Person) => {
    if (amount <= 0) return;
    state.sleeves.push({
      value: amount,
      cost: amount,
      valueAtCutover: null,
      sleeve,
      person,
    });
  };

  const placeDebtRecycle = (amount: number, sleeve: AssetSleeve) => {
    if (amount <= 0) return;
    state.offset += amount;
    state.invLoan += amount;
    addSleeve(amount, sleeve, household.you);
  };

  state.offset += applied.offset ?? 0;
  const repay = applied.extra_repay ?? 0;
  if (repay > 0) {
    const pay = Math.min(repay, state.homeLoan);
    state.homeLoan -= pay;
    if (repay > pay) state.offset += repay - pay;
  }

  addSleeve(applied.taxable_you_growth ?? 0, a.growthAsset, household.you);
  addSleeve(applied.taxable_you_income ?? 0, a.incomeAsset, household.you);
  addSleeve(applied.taxable_spouse_growth ?? 0, a.growthAsset, household.spouse);
  addSleeve(applied.taxable_spouse_income ?? 0, a.incomeAsset, household.spouse);
  placeDebtRecycle(applied.debt_recycle_you_growth ?? 0, a.growthAsset);
  placeDebtRecycle(applied.debt_recycle_you_income ?? 0, a.incomeAsset);

  const contributeCc = (person: Person, amount: number) => {
    if (amount <= 0) return 0;
    const intoFund = amount * (1 - a.concessionalContributionsTax);
    if (person.id === "you") state.superYou += intoFund;
    else state.superSpouse += intoFund;
    const saving = amount * combinedMarginalRate(person);
    const div293 = division293Tax(
      person.taxableIncome,
      person.concessionalUsedThisFy + amount,
      a.div293Threshold,
    );
    const netRefund = saving - div293;
    if (a.refundsToOffset) state.offset += netRefund;
    else state.cash += netRefund;
    return netRefund;
  };

  contributeCc(household.you, applied.super_cc_you ?? 0);
  contributeCc(household.spouse, applied.super_cc_spouse ?? 0);
  state.superYou += applied.super_ncc_you ?? 0;
  state.superSpouse += applied.super_ncc_spouse ?? 0;

  const superM = monthlyRate(a.superReturnRate) * (1 - a.superEarningsTax);

  let totalHomeInterest = 0;
  let totalInvInterest = 0;
  let totalIncomeTax = 0;
  const years: YearRow[] = [];

  const fillAccessible = () => {
    const taxableTotal = state.sleeves.reduce((s, x) => s + x.value, 0);
    const superTotal = state.superYou + state.superSpouse;
    const netWealth =
      taxableTotal + superTotal + state.offset + state.cash - state.homeLoan - state.invLoan;
    return {
      netWealth,
      accessible: netWealth - superTotal,
      superTotal,
      taxableTotal,
      netDebt: state.homeLoan + state.invLoan - state.offset,
    };
  };

  let yearHomeInterest = 0;
  let yearInvInterest = 0;
  let yearIncomeTax = 0;

  for (let m = 0; m < months; m++) {
    const date = addMonthsIso(start, m + 1);
    const prevDate = addMonthsIso(start, m);
    const crossedCutover =
      prevDate < "2027-07-01" && date >= "2027-07-01";

    const home = stepHomeLoan({
      balance: state.homeLoan,
      offset: state.offset,
      annualRate: household.loan.annualRate,
      scheduledPayment: scheduled,
      interestOnly: household.loan.interestOnly,
    });
    state.homeLoan = home.balance;
    totalHomeInterest += home.interest;
    yearHomeInterest += home.interest;
    // P&I is assumed paid from salary. If the loan does not need the full
    // scheduled amount (paid off, or last partial), the leftover still
    // exists as household cashflow — park it in the offset so extra-repay
    // gets credit for freeing the mortgage payment.
    if (!household.loan.interestOnly) {
      const surplus = Math.max(0, scheduled - home.payment);
      if (surplus > 0) state.offset += surplus;
    }

    const invInterest = state.invLoan * (invRate / 12);
    totalInvInterest += invInterest;
    yearInvInterest += invInterest;

    state.superYou *= 1 + superM;
    state.superSpouse *= 1 + superM;

    let monthYieldTax = 0;
    const interestDeductionThisMonth = invInterest;

    for (const sl of state.sleeves) {
      const g = monthlyRate(sl.sleeve.growthRate);
      const y = monthlyRate(sl.sleeve.yieldRate);
      const mer = monthlyRate(sl.sleeve.mer);
      sl.value *= 1 + g;
      const yieldCash = sl.value * y;
      sl.value *= 1 - mer;
      if (sl.sleeve.reinvestDividends) {
        sl.value += yieldCash;
        sl.cost += yieldCash;
      } else {
        state.cash += yieldCash;
      }
      monthYieldTax += dividendTax(
        yieldCash,
        sl.sleeve.frankingPercent,
        sl.person,
      );
      if (crossedCutover && sl.valueAtCutover == null) {
        sl.valueAtCutover = sl.value;
      }
    }

    // Deductible investment-loan interest, attributed to you (the borrower).
    const youMtr = combinedMarginalRate(household.you);
    const gearingRelief = interestDeductionThisMonth * youMtr;
    const netTax = monthYieldTax - gearingRelief;
    totalIncomeTax += netTax;
    yearIncomeTax += netTax;
    if (a.refundsToOffset) state.offset -= netTax;
    else state.cash -= netTax;

    if ((m + 1) % 12 === 0 || m === months - 1) {
      const year = Math.ceil((m + 1) / 12);
      const snap = fillAccessible();
      years.push({
        year,
        netWealth: round2(snap.netWealth),
        accessible: round2(snap.accessible),
        superTotal: round2(snap.superTotal),
        taxableTotal: round2(snap.taxableTotal),
        netDebt: round2(snap.netDebt),
        homeInterest: round2(yearHomeInterest),
        investmentInterest: round2(yearInvInterest),
        incomeTax: round2(yearIncomeTax),
        cgtTax: 0,
      });
      yearHomeInterest = 0;
      yearInvInterest = 0;
      yearIncomeTax = 0;
    }
  }

  const endDate = addMonthsIso(start, months);
  let exitCgt = 0;
  let exitCgtIfLegacy = 0;
  for (const sl of state.sleeves) {
    const r = estimateHybridCgt({
      proceeds: sl.value,
      cost: sl.cost,
      acquiredDate: start,
      disposedDate: endDate,
      valueAtCutover: sl.valueAtCutover ?? undefined,
      inflationRate: a.inflationRate,
      person: sl.person,
    });
    exitCgt += r.tax;
    exitCgtIfLegacy += r.taxIfLegacyDiscount;
  }

  const snap = fillAccessible();
  if (years.length) {
    years[years.length - 1]!.cgtTax = round2(exitCgt);
  }

  return {
    id: def.id,
    label: def.label,
    summary: def.summary,
    group: def.group,
    allocation: def.allocation,
    appliedAllocation: applied,
    warnings,
    notes: scenarioNotes(household, def, applied),
    netWealth: round2(snap.netWealth),
    accessible: round2(snap.accessible),
    superYou: round2(state.superYou),
    superSpouse: round2(state.superSpouse),
    taxableYou: round2(
      state.sleeves
        .filter((s) => s.person.id === "you")
        .reduce((s, x) => s + x.value, 0),
    ),
    taxableSpouse: round2(
      state.sleeves
        .filter((s) => s.person.id === "spouse")
        .reduce((s, x) => s + x.value, 0),
    ),
    homeLoan: round2(state.homeLoan),
    offset: round2(state.offset),
    investmentLoan: round2(state.invLoan),
    netDebt: round2(snap.netDebt),
    totalHomeInterest: round2(totalHomeInterest),
    totalInvestmentInterest: round2(totalInvInterest),
    totalIncomeTax: round2(totalIncomeTax),
    exitCgt: round2(exitCgt),
    netIfLiquidated: round2(snap.netWealth - exitCgt),
    exitCgtIfLegacyDiscount: round2(exitCgtIfLegacy),
    totalCapitalIn: round2(household.lumpSum),
    years,
  };
}

export function runHousehold(
  household: Household,
  extra: ScenarioDef[] = [],
): RunReport {
  const defs = [...buildPresets(household), ...extra];
  const results = defs.map((d) => runScenario(household, d));
  results.sort((a, b) => b.netIfLiquidated - a.netIfLiquidated);
  return { household, disclaimer: DISCLAIMER, results };
}

function scenarioNotes(
  household: Household,
  def: ScenarioDef,
  applied: Allocation,
): string[] {
  const notes: string[] = [];
  const ccYou = applied.super_cc_you ?? 0;
  const ccSp = applied.super_cc_spouse ?? 0;
  const youRate = (combinedMarginalRate(household.you) * 100).toFixed(0);
  if (ccYou > 0) {
    const div293 =
      household.you.taxableIncome + ccYou > household.assumptions.div293Threshold;
    notes.push(
      div293
        ? `The super tax-cut in your name saves about ${youRate} cents in the dollar on salary tax. Super then takes 15%. Because your income plus this contribution is over $250k, a bit of extra Division 293 tax applies on the slice over that line.`
        : `The super tax-cut in your name saves about ${youRate} cents in the dollar on salary tax. Super then takes 15% of what went in. Still cheaper than leaving it in your name outside.`,
    );
  }
  if (ccSp > 0 && ccYou === 0) {
    notes.push(
      "Doing the super tax-cut in their name saves less than doing it in yours, because their tax rate is lower. The high earner usually goes first.",
    );
  }
  if ((applied.super_ncc_you ?? 0) > 0 || (applied.super_ncc_spouse ?? 0) > 0) {
    notes.push(
      "This is after-tax money going into super. No extra tax cut on the way in. Super then taxes the growth at 15%. Pick whose account based on whose limit you have left, not based on 30% vs 45%.",
    );
  }
  if ((applied.taxable_spouse_growth ?? 0) + (applied.taxable_spouse_income ?? 0) > 0) {
    notes.push(
      "Shares outside super in their name are how you actually use the 30% vs 45% gap. Moving super between you two does not do that.",
    );
  }
  if (
    (applied.debt_recycle_you_growth ?? 0) + (applied.debt_recycle_you_income ?? 0) >
    0
  ) {
    notes.push(
      "Debt recycle only works if the paperwork is clean. Money onto the offset or loan, then a separate investment loan, then shares. This model treats the investment-loan interest as tax-deductible. That still works for shares after 1 Jul 2027. It mostly does not for a rental house.",
    );
  }
  if ((applied.extra_repay ?? 0) > 0) {
    notes.push(
      "Paying the loan down and parking in the offset save the same interest. Offset is usually nicer because you can still touch the cash.",
    );
  }
  if (def.group === "taxable" || def.group === "recycle") {
    notes.push(
      "From 1 Jul 2027, the old 50% CGT discount is gone for new growth. You pay tax on the real gain after inflation at your rate, with a 30% floor. At about 47% you still pay about 47% on that real gain.",
    );
  }
  return notes;
}

export function customScenario(
  allocation: Allocation,
  label = "Yours",
): ScenarioDef {
  return {
    id: "custom",
    label,
    summary:
      "Your own split of the lump. Whatever you typed in the mix boxes.\n\nUnallocated dollars go to the offset. Super over the yearly limit also spills there.",
    group: "custom",
    allocation,
  };
}
