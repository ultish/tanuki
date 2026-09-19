import {
  concessionalCommittedThisFy,
  concessionalRoom,
  nccRoom,
  remainingAfter,
} from "./caps.js";
import { pmt, stepHomeLoan } from "./loan.js";
import { buildPresets } from "./presets.js";
import {
  allocationKey,
  buildStacks,
  pickDisplayedResults,
} from "./stacks.js";
import {
  addMonthsIso,
  division293Tax,
  estimateHybridCgt,
  frankingCredits,
  monthlyRate,
  round2,
  taxDelta,
} from "./tax.js";
import {
  DISCLAIMER,
  type Allocation,
  type AssetSleeve,
  type Assumptions,
  type BucketId,
  type Household,
  type Person,
  type PersonId,
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

/**
 * One parcel of a sleeve, dated when it actually arrived (initial lump,
 * a DRP reinvestment that month, or an idle-offset sweep mid-simulation).
 * Exit CGT is computed per lot so late-arriving money isn't back-dated to
 * the simulation's start.
 */
type Lot = {
  acquiredDate: string;
  cost: number;
  value: number;
  valueAtCutover: number | null;
};

type SleeveState = {
  lots: Lot[];
  sleeve: AssetSleeve;
  person: Person;
};

function sleeveValue(sl: SleeveState): number {
  let v = 0;
  for (const lot of sl.lots) v += lot.value;
  return v;
}

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
  const lump = household.lumpSum;
  const requested = allocationSum(allocation);
  let applied: Allocation = { ...allocation };
  if (requested > lump + 0.5) {
    const scale = lump / requested;
    applied = {};
    for (const id of BUCKETS) {
      const v = allocation[id];
      if (v) applied[id] = round2(v * scale);
    }
    warnings.push(
      `Allocated $${Math.round(requested).toLocaleString("en-AU")} but the lump is $${Math.round(lump).toLocaleString("en-AU")}. Every bucket scaled down to fit before caps.`,
    );
  }
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
  const restrictedOffset = Math.max(0, household.loan.restrictedOffset ?? 0);
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

  const addSleeve = (
    amount: number,
    sleeve: AssetSleeve,
    person: Person,
    acquiredDate: string,
  ) => {
    if (amount <= 0) return;
    state.sleeves.push({
      lots: [{ acquiredDate, cost: amount, value: amount, valueAtCutover: null }],
      sleeve,
      person,
    });
  };

  const addLot = (sl: SleeveState, amount: number, acquiredDate: string) => {
    if (amount <= 0) return;
    sl.lots.push({ acquiredDate, cost: amount, value: amount, valueAtCutover: null });
  };

  const placeDebtRecycle = (amount: number, sleeve: AssetSleeve) => {
    if (amount <= 0) return;
    const pay = Math.min(amount, state.homeLoan);
    state.homeLoan -= pay;
    state.invLoan += pay;
    addSleeve(pay, sleeve, household.you, start);
    if (amount > pay) state.offset += amount - pay;
  };

  state.offset += applied.offset ?? 0;
  const repay = applied.extra_repay ?? 0;
  if (repay > 0) {
    const pay = Math.min(repay, state.homeLoan);
    state.homeLoan -= pay;
    if (repay > pay) state.offset += repay - pay;
  }

  addSleeve(applied.taxable_you_growth ?? 0, a.growthAsset, household.you, start);
  addSleeve(applied.taxable_you_income ?? 0, a.incomeAsset, household.you, start);
  addSleeve(applied.taxable_spouse_growth ?? 0, a.growthAsset, household.spouse, start);
  addSleeve(applied.taxable_spouse_income ?? 0, a.incomeAsset, household.spouse, start);
  placeDebtRecycle(applied.debt_recycle_you_growth ?? 0, a.growthAsset);
  placeDebtRecycle(applied.debt_recycle_you_income ?? 0, a.incomeAsset);

  const contributeCc = (person: Person, amount: number) => {
    if (amount <= 0) return 0;
    const intoFund = amount * (1 - a.concessionalContributionsTax);
    if (person.id === "you") state.superYou += intoFund;
    else state.superSpouse += intoFund;
    const saving = -taxDelta(
      person.taxableIncome,
      -amount,
      person.medicareLevy,
    );
    const div293 = division293Tax(
      person.taxableIncome,
      concessionalCommittedThisFy(person) + amount,
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

  const sweepIdleOffset = (acquiredDate: string) => {
    if (!a.sweepIdleOffset) return;
    const idle = state.offset - state.homeLoan - restrictedOffset;
    if (idle <= 0.5) return;
    state.offset -= idle;
    const existing = state.sleeves.find(
      (s) => s.person.id === "spouse" && s.sleeve === a.growthAsset,
    );
    if (existing) {
      addLot(existing, idle, acquiredDate);
    } else {
      addSleeve(idle, a.growthAsset, household.spouse, acquiredDate);
    }
  };
  sweepIdleOffset(start);

  const superM = monthlyRate(a.superReturnRate) * (1 - a.superEarningsTax);

  let totalHomeInterest = 0;
  let totalInvInterest = 0;
  let totalIncomeTax = 0;
  let totalInvestmentIncomeTax = 0;
  const years: YearRow[] = [];

  const fillAccessible = () => {
    const taxableTotal = state.sleeves.reduce((s, x) => s + sleeveValue(x), 0);
    const superTotal = state.superYou + state.superSpouse;
    const netWealth =
      taxableTotal +
      superTotal +
      state.offset +
      state.cash -
      state.homeLoan -
      state.invLoan -
      restrictedOffset;
    return {
      netWealth,
      accessible: netWealth - superTotal,
      superTotal,
      taxableTotal,
      offsetAndCash: state.offset + state.cash,
      debt: state.homeLoan + state.invLoan + restrictedOffset,
      netDebt: state.homeLoan + state.invLoan + restrictedOffset - state.offset,
    };
  };

  let yearHomeInterest = 0;
  let yearInvInterest = 0;
  let yearIncomeTax = 0;

  const incomeGrowth = a.incomeGrowthRate ?? 0;
  const ccYou = applied.super_cc_you ?? 0;
  const ccSpouse = applied.super_cc_spouse ?? 0;

  const grownIncome = (person: Person, yearIndex: number): number =>
    person.taxableIncome * Math.pow(1 + incomeGrowth, yearIndex);

  const yearWorkConcessional = (person: Person, yearIndex: number): number => {
    const raw =
      (Math.max(0, person.employerSgThisFy) +
        Math.max(0, person.extraConcessionalThisFy)) *
      Math.pow(1 + incomeGrowth, yearIndex);
    if (yearIndex === 0) return raw;
    return Math.min(raw, a.concessionalCap);
  };
  type YearTax = { assessable: number; franking: number; deductions: number };
  const emptyTax = (): YearTax => ({
    assessable: 0,
    franking: 0,
    deductions: 0,
  });
  let youYear = emptyTax();
  let spouseYear = emptyTax();
  let prevYearNet = 0;
  let prevInvIncomeTax = 0;

  const personBase = (id: PersonId, yearIndex: number): number => {
    const p = id === "you" ? household.you : household.spouse;
    const cc = id === "you" ? ccYou : ccSpouse;
    const income = grownIncome(p, yearIndex);
    return yearIndex === 0 ? income - cc : income;
  };

  const yearNet = (id: PersonId, yearIndex: number, st: YearTax): number => {
    const p = id === "you" ? household.you : household.spouse;
    return (
      taxDelta(
        personBase(id, yearIndex),
        st.assessable - st.deductions,
        p.medicareLevy,
      ) - st.franking
    );
  };

  const yearYieldTax = (id: PersonId, yearIndex: number, st: YearTax): number => {
    const p = id === "you" ? household.you : household.spouse;
    return (
      taxDelta(personBase(id, yearIndex), st.assessable, p.medicareLevy) -
      st.franking
    );
  };

  for (let m = 0; m < months; m++) {
    const date = addMonthsIso(start, m + 1);
    const prevDate = addMonthsIso(start, m);
    const crossedCutover =
      prevDate < "2027-07-01" && date >= "2027-07-01";
    if (m > 0 && m % 12 === 0) {
      youYear = emptyTax();
      spouseYear = emptyTax();
      prevYearNet = 0;
      prevInvIncomeTax = 0;
    }
    const yearIndex = Math.floor(m / 12);

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
    const ccTax = 1 - a.concessionalContributionsTax;
    state.superYou +=
      (yearWorkConcessional(household.you, yearIndex) * ccTax) / 12;
    state.superSpouse +=
      (yearWorkConcessional(household.spouse, yearIndex) * ccTax) / 12;

    const interestDeductionThisMonth = invInterest;

    for (const sl of state.sleeves) {
      const g = monthlyRate(sl.sleeve.growthRate);
      const y = monthlyRate(sl.sleeve.yieldRate);
      const mer = monthlyRate(sl.sleeve.mer);
      let yieldCash = 0;
      for (const lot of sl.lots) {
        lot.value *= 1 + g;
        const lotYield = lot.value * y;
        lot.value *= 1 - mer;
        yieldCash += lotYield;
        if (crossedCutover && lot.valueAtCutover == null) {
          lot.valueAtCutover = lot.value;
        }
      }
      if (sl.sleeve.reinvestDividends) {
        // A new parcel bought via DRP this month — dated now, not backdated
        // to when the rest of the sleeve was acquired, so exit CGT sees its
        // real holding period.
        addLot(sl, yieldCash, date);
      } else {
        state.cash += yieldCash;
      }
      if (yieldCash > 0) {
        const credits = frankingCredits(yieldCash, sl.sleeve.frankingPercent);
        const bucket = sl.person.id === "you" ? youYear : spouseYear;
        bucket.assessable += yieldCash + credits;
        bucket.franking += credits;
      }
    }

    youYear.deductions += interestDeductionThisMonth;
    const netTaxYtd =
      yearNet("you", yearIndex, youYear) +
      yearNet("spouse", yearIndex, spouseYear);
    const netTax = netTaxYtd - prevYearNet;
    prevYearNet = netTaxYtd;
    totalIncomeTax += netTax;
    yearIncomeTax += netTax;
    const yieldTaxYtd =
      yearYieldTax("you", yearIndex, youYear) +
      yearYieldTax("spouse", yearIndex, spouseYear);
    totalInvestmentIncomeTax += yieldTaxYtd - prevInvIncomeTax;
    prevInvIncomeTax = yieldTaxYtd;
    if (a.refundsToOffset) state.offset -= netTax;
    else state.cash -= netTax;
    sweepIdleOffset(date);

    if ((m + 1) % 12 === 0 || m === months - 1) {
      const year = Math.ceil((m + 1) / 12);
      const snap = fillAccessible();
      years.push({
        year,
        netWealth: round2(snap.netWealth),
        accessible: round2(snap.accessible),
        superTotal: round2(snap.superTotal),
        taxableTotal: round2(snap.taxableTotal),
        offsetAndCash: round2(snap.offsetAndCash),
        debt: round2(snap.debt),
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
  const endYearIndex = Math.max(0, Math.floor((months - 1) / 12));
  let exitCgt = 0;
  let exitCgtIfLegacy = 0;
  for (const sl of state.sleeves) {
    const person = {
      ...sl.person,
      taxableIncome: personBase(sl.person.id, endYearIndex),
    };
    for (const lot of sl.lots) {
      const r = estimateHybridCgt({
        proceeds: lot.value,
        cost: lot.cost,
        acquiredDate: lot.acquiredDate,
        disposedDate: endDate,
        valueAtCutover: lot.valueAtCutover ?? undefined,
        inflationRate: a.inflationRate,
        person,
      });
      exitCgt += r.tax;
      exitCgtIfLegacy += r.taxIfLegacyDiscount;
    }
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
        .reduce((s, x) => s + sleeveValue(x), 0),
    ),
    taxableSpouse: round2(
      state.sleeves
        .filter((s) => s.person.id === "spouse")
        .reduce((s, x) => s + sleeveValue(x), 0),
    ),
    investmentOutsideSuper: round2(
      state.sleeves.reduce((s, x) => s + sleeveValue(x), 0),
    ),
    homeLoan: round2(state.homeLoan),
    offset: round2(state.offset),
    investmentLoan: round2(state.invLoan),
    netDebt: round2(snap.netDebt),
    totalHomeInterest: round2(totalHomeInterest),
    totalInvestmentInterest: round2(totalInvInterest),
    totalIncomeTax: round2(totalIncomeTax),
    investmentIncomeTax: round2(totalInvestmentIncomeTax),
    investmentTaxIfSold: round2(totalInvestmentIncomeTax + exitCgt),
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
  const presets = buildPresets(household);
  const presetKeys = new Set(presets.map((p) => allocationKey(p.allocation)));
  const stacks = buildStacks(household).filter(
    (s) => !presetKeys.has(allocationKey(s.allocation)),
  );
  const defs = [...presets, ...stacks, ...extra];
  const results = defs.map((d) => runScenario(household, d));
  results.sort((a, b) => b.netIfLiquidated - a.netIfLiquidated);
  const shown = pickDisplayedResults(
    results,
    [...presets, ...extra].map((d) => d.id),
  );
  return { household, disclaimer: DISCLAIMER, results: shown };
}

function scenarioNotes(
  household: Household,
  def: ScenarioDef,
  applied: Allocation,
): string[] {
  const notes: string[] = [];
  const ccYou = applied.super_cc_you ?? 0;
  const ccSp = applied.super_cc_spouse ?? 0;
  if (ccYou > 0) {
    const saving = -taxDelta(
      household.you.taxableIncome,
      -ccYou,
      household.you.medicareLevy,
    );
    const cents = ccYou > 0 ? Math.round((saving / ccYou) * 100) : 0;
    const div293 =
      household.you.taxableIncome +
        concessionalCommittedThisFy(household.you) +
        ccYou >
      household.assumptions.div293Threshold;
    notes.push(
      div293
        ? `The super tax-cut in your name saves about ${cents} cents in the dollar on salary tax under the FY2026-27 scale. Super then takes 15%. Because your income plus this contribution is over $250k, a bit of extra Division 293 tax applies on the slice over that line.`
        : `The super tax-cut in your name saves about ${cents} cents in the dollar on salary tax under the FY2026-27 scale. Super then takes 15% of what went in. Still cheaper than leaving it in your name outside.`,
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
      "Debt recycle pays the lump onto the home loan, then redraws that amount as an investment split and buys shares in your name. Offset is not used for the redraw. Investment-loan interest is treated as deductible. That still works for shares after 1 Jul 2027. It mostly does not for a rental house.",
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
