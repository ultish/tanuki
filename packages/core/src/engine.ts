import {
  concessionalCommittedThisFy,
  concessionalRoom,
  nccRoom,
  remainingAfter,
} from "./caps.js";
import { leaseAddback } from "./defaults.js";
import { paySchedule } from "./income.js";
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
  incomeTax,
  monthlyRate,
  round2,
  taxDelta,
} from "./tax.js";
import {
  DISCLAIMER,
  HOLDING_KEYS,
  type ActualMonth,
  type Allocation,
  type AssetSleeve,
  type Assumptions,
  type BucketId,
  type FlowKey,
  type Flows,
  type HoldingKey,
  type Household,
  type OpeningPosition,
  type Person,
  type PersonId,
  type RunReport,
  type ScenarioDef,
  type ScenarioResult,
  type SleeveKind,
  type MonthRow,
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
  /** Yield earned but not yet distributed — paid out on the fund's schedule. */
  accruedYield: number;
};

function sleeveValue(sl: SleeveState): number {
  let v = 0;
  for (const lot of sl.lots) v += lot.value;
  return v;
}

/** Where a taxable or debt-recycle bucket's shares land. */
const SHARE_BUCKETS: Partial<
  Record<BucketId, { personId: PersonId; kind: SleeveKind; recycle: boolean }>
> = {
  taxable_you_growth: { personId: "you", kind: "growth", recycle: false },
  taxable_you_income: { personId: "you", kind: "income", recycle: false },
  taxable_spouse_growth: { personId: "spouse", kind: "growth", recycle: false },
  taxable_spouse_income: { personId: "spouse", kind: "income", recycle: false },
  debt_recycle_you_growth: { personId: "you", kind: "growth", recycle: true },
  debt_recycle_you_income: { personId: "you", kind: "income", recycle: true },
};

/** "yyyy-mm" of an ISO date. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * The flows a logged month overrides. Risu, when present, is authoritative
 * for the share buckets of the people it covers (absent = none that month),
 * and for the sweep when it covers the spouse, since it can't tell a sweep
 * from a planned spouse growth buy. Sells of parcels bought before
 * `planSince` aren't the plan's money and are skipped.
 */
export function loggedFlows(act: ActualMonth, planSince: string): Flows | null {
  const out: Flows = {};
  for (const [k, v] of Object.entries(act.flows ?? {}) as [FlowKey, number][]) {
    if (k !== "offset" && Number.isFinite(v)) out[k] = v;
  }
  if (act.risu) {
    const covers = act.risu.covers ?? ["you", "spouse"];
    for (const [k, share] of Object.entries(SHARE_BUCKETS) as [BucketId, { personId: PersonId }][]) {
      if (covers.includes(share.personId)) out[k] = 0;
    }
    if (covers.includes("spouse")) out.sweep = 0;
    for (const t of act.risu.trades) {
      if (t.amount < 0 && t.acquiredDate != null && t.acquiredDate < planSince) {
        continue;
      }
      out[t.bucket] = (out[t.bucket] ?? 0) + t.amount;
    }
  }
  return Object.keys(out).length ? out : null;
}

export type RunOptions = {
  /** Carry on from here instead of a standing start. The lump is placed on top. */
  opening?: OpeningPosition;
  /** The household log, keyed "yyyy-mm". Logged months override the projection. */
  actuals?: ReadonlyMap<string, ActualMonth>;
  /**
   * Risu parcels bought before this ISO date predate the plan and are left
   * out. Defaults to the run's start date.
   */
  planSince?: string;
  /**
   * The run stops partway through a life rather than at its horizon: don't
   * flush the unsettled tax or undistributed yield in the last month — the
   * closing position carries them instead.
   */
  midStream?: boolean;
};

export type Simulation = {
  result: ScenarioResult;
  /** Position at the end of the run, ready to seed another. */
  closing: OpeningPosition;
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
  rawAllocation: Allocation,
  /**
   * Concessional contributions already counted against this year's cap,
   * when the household's own SG + salary-sacrifice figures aren't the whole
   * story (a run starting from an opening position).
   */
  committedCc?: Record<PersonId, number>,
): { applied: Allocation; warnings: string[] } {
  const warnings: string[] = [];
  const lump = household.lumpSum;

  // A negative bucket can offset a positive one and slip an over-lump
  // allocation past the scale-down check below, so it's dropped up front
  // rather than clamped later.
  let hadNegative = false;
  const allocation: Allocation = {};
  for (const id of BUCKETS) {
    const v = rawAllocation[id];
    if (v == null) continue;
    if (v < 0) {
      hadNegative = true;
      continue;
    }
    allocation[id] = v;
  }
  if (hadNegative) {
    warnings.push("Negative amounts aren't allowed in the mix. They were dropped.");
  }

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
    concessionalRoom(household.you, household.assumptions, committedCc?.you),
    "Your concessional",
  );
  clampSuper(
    "super_cc_spouse",
    concessionalRoom(household.spouse, household.assumptions, committedCc?.spouse),
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
  opts: RunOptions = {},
): ScenarioResult {
  return simulate(household, def, opts).result;
}

/**
 * The engine. `runScenario` is this without the closing position. The
 * RunOptions hooks (an opening position, a log of actual months) and dated
 * pay/rate events are all opt-in: without them this is exactly the plain
 * projection.
 */
export function simulate(
  household: Household,
  def: ScenarioDef,
  opts: RunOptions = {},
): Simulation {
  const opening = opts.opening;
  const actuals = opts.actuals;
  const { applied, warnings } = applyCaps(
    household,
    def.allocation,
    opening
      ? {
          you: concessionalCommittedThisFy(household.you) + opening.ccThisYear.you,
          spouse: concessionalCommittedThisFy(household.spouse) + opening.ccThisYear.spouse,
        }
      : undefined,
  );
  const a = household.assumptions;
  const months = Math.max(1, Math.round(a.horizonYears * 12));
  const start = a.startDate;
  const planSince = opts.planSince ?? start;

  // Dated rate changes. With none recorded this is the loan's own rate.
  const rateEvents = [...(household.loan.rateEvents ?? [])].sort((x, y) =>
    x.from.localeCompare(y.from),
  );
  const homeRateAt = (iso: string): number => {
    let r = household.loan.annualRate;
    for (const e of rateEvents) if (e.from <= iso) r = e.annualRate;
    return r;
  };
  const invRateAt = (iso: string): number => a.investmentLoanRate ?? homeRateAt(iso);

  const restrictedOffset = Math.max(0, household.loan.restrictedOffset ?? 0);
  const fullRepayment =
    household.loan.monthlyRepayment ??
    pmt(
      household.loan.balance,
      homeRateAt(start),
      household.loan.remainingYears,
    );

  const state: SimState = opening
    ? {
        homeLoan: opening.homeLoan,
        offset: opening.offset,
        invLoan: opening.invLoan,
        superYou: opening.superYou,
        superSpouse: opening.superSpouse,
        sleeves: [],
        cash: opening.cash,
      }
    : {
        homeLoan: household.loan.balance,
        offset: household.loan.offset,
        invLoan: 0,
        superYou: household.you.superBalance,
        superSpouse: household.spouse.superBalance,
        sleeves: [],
        cash: 0,
      };

  const personOf = (id: PersonId): Person => (id === "you" ? household.you : household.spouse);
  const kindOf = (sl: SleeveState): SleeveKind =>
    sl.sleeve === a.incomeAsset ? "income" : "growth";
  const assetOf = (kind: SleeveKind): AssetSleeve =>
    kind === "growth" ? a.growthAsset : a.incomeAsset;
  const sleeveFor = (personId: PersonId, kind: SleeveKind): SleeveState => {
    let sl = state.sleeves.find((x) => x.person.id === personId && kindOf(x) === kind);
    if (!sl) {
      sl = { lots: [], sleeve: assetOf(kind), person: personOf(personId), accruedYield: 0 };
      state.sleeves.push(sl);
    }
    return sl;
  };
  if (opening) {
    for (const l of opening.lots) {
      sleeveFor(l.personId, l.sleeve).lots.push({
        acquiredDate: l.acquiredDate,
        cost: l.cost,
        value: l.value,
        valueAtCutover: l.valueAtCutover,
      });
    }
    for (const key of HOLDING_KEYS) {
      const pending = opening.accruedYield[key] ?? 0;
      if (pending) {
        const [personId, kind] = key.split("_") as [PersonId, SleeveKind];
        sleeveFor(personId, kind).accruedYield += pending;
      }
    }
  }

  // Money moved this month, by bucket — what a logged month is compared to.
  let flows: Flows = {};
  const addFlow = (k: FlowKey, v: number) => {
    if (v) flows[k] = (flows[k] ?? 0) + v;
  };

  const minimumCash = Math.max(0, a.minimumCash);
  const holidayMonth = Math.min(12, Math.max(1, Math.round(a.holidayMonth)));

  // New cash actually moved into taxable investments since the last MonthRow
  // was pushed — the lump's initial placement, a debt-recycle redraw, or an
  // idle-offset sweep. Not DRP reinvestment, which is automatic.
  let periodInvested = 0;
  // The slice of periodInvested that came out of the offset (the idle sweep)
  // rather than straight from the lump — the offset's side of the ledger.
  let periodSweptFromOffset = 0;

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
      accruedYield: 0,
    });
  };

  const addLot = (sl: SleeveState, amount: number, acquiredDate: string) => {
    if (amount <= 0) return;
    sl.lots.push({ acquiredDate, cost: amount, value: amount, valueAtCutover: null });
  };

  const placeDebtRecycle = (amount: number, sleeve: AssetSleeve, acquiredDate = start) => {
    if (amount <= 0) return;
    const availableBalance = state.homeLoan;
    const pay = Math.min(amount, availableBalance);
    state.homeLoan -= pay;
    state.invLoan += pay;
    addSleeve(pay, sleeve, household.you, acquiredDate);
    periodInvested += pay;
    addFlow(sleeve === a.incomeAsset ? "debt_recycle_you_income" : "debt_recycle_you_growth", pay);
    if (amount > pay) {
      const shortfall = amount - pay;
      state.offset += shortfall;
      warnings.push(
        `Asked to debt-recycle $${Math.round(amount).toLocaleString("en-AU")} but the home loan balance is only $${Math.round(availableBalance).toLocaleString("en-AU")}. The extra $${Math.round(shortfall).toLocaleString("en-AU")} was parked in the offset instead.`,
      );
    }
  };

  // Month one: what you actually did with the lump, when it's logged.
  // Unlogged buckets follow the plan; whatever wasn't placed sits in the
  // offset. With no log this is exactly the plan's allocation.
  const act0 = actuals?.get(monthKey(start));
  const logged0 = act0 ? loggedFlows(act0, planSince) : null;
  let placement: Allocation = applied;
  if (logged0) {
    placement = { ...applied };
    for (const [k, v] of Object.entries(logged0) as [FlowKey, number][]) {
      if (k !== "sweep") placement[k] = Math.max(0, v);
    }
    delete placement.offset;
    placement.offset = household.lumpSum - allocationSum(placement);
  }

  state.offset += placement.offset ?? 0;
  addFlow("offset", placement.offset ?? 0);
  const repay = placement.extra_repay ?? 0;
  if (repay > 0) {
    const pay = Math.min(repay, state.homeLoan);
    state.homeLoan -= pay;
    if (repay > pay) state.offset += repay - pay;
    addFlow("extra_repay", pay);
  }

  addSleeve(placement.taxable_you_growth ?? 0, a.growthAsset, household.you, start);
  addSleeve(placement.taxable_you_income ?? 0, a.incomeAsset, household.you, start);
  addSleeve(placement.taxable_spouse_growth ?? 0, a.growthAsset, household.spouse, start);
  addSleeve(placement.taxable_spouse_income ?? 0, a.incomeAsset, household.spouse, start);
  periodInvested +=
    (placement.taxable_you_growth ?? 0) +
    (placement.taxable_you_income ?? 0) +
    (placement.taxable_spouse_growth ?? 0) +
    (placement.taxable_spouse_income ?? 0);
  for (const k of [
    "taxable_you_growth",
    "taxable_you_income",
    "taxable_spouse_growth",
    "taxable_spouse_income",
  ] as const) {
    addFlow(k, placement[k] ?? 0);
  }
  placeDebtRecycle(placement.debt_recycle_you_growth ?? 0, a.growthAsset);
  placeDebtRecycle(placement.debt_recycle_you_income ?? 0, a.incomeAsset);

  // Splitting the loan re-sizes the repayment: the bank sets up two
  // facilities, and the home one is re-amortised over the balance actually
  // left on it. Only the split does this — an extra repayment leaves the
  // payment alone and just finishes the loan early, which is what banks do
  // unless you specifically ask them to recast. pmt is linear in principal,
  // so scaling covers both a computed repayment and one entered by hand.
  const recycled = state.invLoan - (opening?.invLoan ?? 0);
  const baseBalance = opening ? opening.homeLoan : household.loan.balance;
  const basePayment = opening ? opening.scheduledPayment : fullRepayment;
  let scheduled =
    baseBalance > 0
      ? basePayment * (Math.max(0, baseBalance - recycled) / baseBalance)
      : basePayment;
  let remainingMonths = opening
    ? opening.remainingMonths
    : Math.round(household.loan.remainingYears * 12);
  let rateInForce = homeRateAt(start);

  const incomeGrowth = a.incomeGrowthRate ?? 0;

  const pay = {
    you: paySchedule(household.you, start, incomeGrowth),
    spouse: paySchedule(household.spouse, start, incomeGrowth),
  };
  const meanOverYear = (f: (m: number) => number, yearIndex: number): number => {
    let s = 0;
    for (let i = 0; i < 12; i++) s += f(yearIndex * 12 + i);
    return s / 12;
  };

  const grownIncome = (person: Person, yearIndex: number): number => {
    const sched = pay[person.id];
    const base = sched
      ? meanOverYear(sched.taxableAt, yearIndex)
      : person.taxableIncome * Math.pow(1 + incomeGrowth, yearIndex);
    return base + leaseAddback(person, start, yearIndex);
  };

  /** Taxable income in force this month, as an annual rate — for monthly pay. */
  const incomeThisMonth = (person: Person, m: number): number => {
    const sched = pay[person.id];
    const yearIndex = Math.floor(m / 12);
    if (!sched) return grownIncome(person, yearIndex);
    return sched.taxableAt(m) + leaseAddback(person, start, yearIndex);
  };

  // Concessional contributions logged after month one, by person and plan
  // year: they lower that year's tax base like the lump's contribution does.
  const loggedCc: Record<PersonId, Map<number, number>> = {
    you: new Map(),
    spouse: new Map(),
  };

  // Standard PAYG on salary alone — ignores deductions/offsets from other
  // income, same simplification as the "Spare cash" plan panel uses.
  const afterTaxIncome = (income: number, medicareLevy: number): number =>
    income - incomeTax(income, medicareLevy);

  /**
   * Extra tax on top of the fund's flat 15%, for a concessional contribution
   * arriving this year: Division 293 above the income threshold, and
   * excess-concessional-contributions tax above the cap (marginal rate,
   * less a 15% offset for the contributions tax the fund already withheld).
   * `raw` is the ongoing SG + salary-sacrifice for the year (uncapped —
   * employer SG is compulsory and is paid in full regardless of anyone's
   * personal cap); `lump` is an optional one-off addition on top (only ever
   * nonzero in year one, from the chosen super-cc allocation).
   */
  const concessionalExtraTax = (
    person: Person,
    taxableIncomeThisYear: number,
    raw: number,
    lump: number,
  ): number => {
    const excess = Math.max(0, raw - a.concessionalCap);
    const excessTax =
      excess <= 0
        ? 0
        : Math.max(
            0,
            taxDelta(taxableIncomeThisYear, excess, person.medicareLevy) -
              excess * a.concessionalContributionsTax,
          );
    const cappedRaw = Math.min(raw, a.concessionalCap);
    const div293 = division293Tax(
      taxableIncomeThisYear,
      cappedRaw + lump,
      a.div293Threshold,
    );
    return excessTax + div293;
  };

  // Net tax settlement accrued but not yet "received" — flushed to
  // offset/cash once a year, at the 1 Jul FY rollover (see the main loop),
  // rather than smoothed into every month. Matches how a real refund or
  // Division 293/excess-contributions bill actually arrives.
  let fyTaxAccrual = 0;

  const contributeCc = (person: Person, amount: number) => {
    const incomeNow = grownIncome(person, 0);
    // Carrying on from an opening position, the year's ongoing-contribution
    // tax was already charged by the run that got here; only what this
    // contribution adds on top is new.
    const extraTax =
      concessionalExtraTax(person, incomeNow, concessionalCommittedThisFy(person), amount) -
      (opening
        ? concessionalExtraTax(person, incomeNow, concessionalCommittedThisFy(person), 0)
        : 0);
    let netRefund = -extraTax;
    if (amount > 0) {
      const intoFund = amount * (1 - a.concessionalContributionsTax);
      if (person.id === "you") state.superYou += intoFund;
      else state.superSpouse += intoFund;
      netRefund += -taxDelta(incomeNow, -amount, person.medicareLevy);
    }
    fyTaxAccrual += netRefund;
    return netRefund;
  };

  if (opening) fyTaxAccrual += opening.taxAccrual;
  contributeCc(household.you, placement.super_cc_you ?? 0);
  contributeCc(household.spouse, placement.super_cc_spouse ?? 0);
  state.superYou += placement.super_ncc_you ?? 0;
  state.superSpouse += placement.super_ncc_spouse ?? 0;
  addFlow("super_cc_you", placement.super_cc_you ?? 0);
  addFlow("super_cc_spouse", placement.super_cc_spouse ?? 0);
  addFlow("super_ncc_you", placement.super_ncc_you ?? 0);
  addFlow("super_ncc_spouse", placement.super_ncc_spouse ?? 0);

  /**
   * Money already set aside for the next holiday — a sinking fund that
   * fills a twelfth at a time and empties when the trip is paid for. Held
   * on top of the cash buffer rather than out of it, so a holiday spends
   * what was saved for it instead of raiding the emergency money.
   */
  const holidayProvisionFor = (iso: string): number => {
    if (a.annualHolidaySpend <= 0) return 0;
    const monthsSaving = (Number(iso.slice(5, 7)) - holidayMonth + 12) % 12;
    return a.annualHolidaySpend * (monthsSaving / 12);
  };

  const sweepIdleOffset = (acquiredDate: string, holidayProvision = 0) => {
    if (!a.sweepIdleOffset) return;
    // Floor is whichever protects more right now: enough to fully offset
    // the home loan (so no home-loan interest is being paid), or the money
    // that has to stay liquid — restricted offset, the everyday cash
    // buffer, and whatever's saved toward the next holiday. Not the two
    // rules added together, since money sitting in the account already
    // counts toward offsetting the loan. Once the loan is smaller than what
    // must stay liquid (or paid off), that's the floor.
    const offsetTarget = Math.max(state.homeLoan, restrictedOffset + minimumCash);
    const floor = a.holidayFundOnTop
      ? offsetTarget + holidayProvision
      : Math.max(state.homeLoan, restrictedOffset + minimumCash + holidayProvision);
    const idle = state.offset - floor;
    if (idle <= 0.5) return;
    state.offset -= idle;
    periodInvested += idle;
    periodSweptFromOffset += idle;
    addFlow("sweep", idle);
    const existing = state.sleeves.find(
      (s) => s.person.id === "spouse" && s.sleeve === a.growthAsset,
    );
    if (existing) {
      addLot(existing, idle, acquiredDate);
    } else {
      addSleeve(idle, a.growthAsset, household.spouse, acquiredDate);
    }
  };
  /**
   * Money moved after the lump is placed — out of the offset, or back into
   * it for a sell (negative). Logged months only.
   */
  const applyFlow = (k: FlowKey, v: number, iso: string, m: number) => {
    if (!v || k === "offset") return;
    if (k === "sweep") {
      if (v > 0) {
        state.offset -= v;
        const sl = sleeveFor("spouse", "growth");
        addLot(sl, v, iso);
        periodInvested += v;
        periodSweptFromOffset += v;
      } else {
        const got = sell("spouse", "growth", -v);
        state.offset += got;
        periodInvested -= got;
      }
      addFlow(k, v);
      return;
    }
    const share = SHARE_BUCKETS[k];
    if (share) {
      if (v > 0) {
        state.offset -= v;
        if (share.recycle) {
          placeDebtRecycle(v, assetOf(share.kind), iso);
        } else {
          addLot(sleeveFor(share.personId, share.kind), v, iso);
          periodInvested += v;
          addFlow(k, v);
        }
      } else {
        const got = sell(share.personId, share.kind, -v);
        const repayInv = share.recycle ? Math.min(got, state.invLoan) : 0;
        state.invLoan -= repayInv;
        state.offset += got - repayInv;
        periodInvested -= got;
        addFlow(k, -got);
      }
      return;
    }
    if (v < 0) return;
    const yearIndex = Math.floor(m / 12);
    switch (k) {
      case "extra_repay": {
        const paid = Math.min(v, state.homeLoan);
        state.homeLoan -= paid;
        state.offset -= paid;
        addFlow(k, paid);
        return;
      }
      case "super_cc_you":
      case "super_cc_spouse": {
        const person = k === "super_cc_you" ? household.you : household.spouse;
        const income = grownIncome(person, yearIndex);
        const raw = yearWorkConcessional(person, yearIndex);
        const lumpCc = yearIndex === 0 ? (person.id === "you" ? ccYou : ccSpouse) : 0;
        const prior = lumpCc + (loggedCc[person.id].get(yearIndex) ?? 0);
        const extra =
          concessionalExtraTax(person, income, raw, prior + v) -
          concessionalExtraTax(person, income, raw, prior);
        const saving = -taxDelta(income - prior, -v, person.medicareLevy);
        loggedCc[person.id].set(yearIndex, (loggedCc[person.id].get(yearIndex) ?? 0) + v);
        state.offset -= v;
        const intoFund = v * (1 - a.concessionalContributionsTax);
        if (person.id === "you") state.superYou += intoFund;
        else state.superSpouse += intoFund;
        fyTaxAccrual += saving - extra;
        addFlow(k, v);
        return;
      }
      case "super_ncc_you":
        state.offset -= v;
        state.superYou += v;
        addFlow(k, v);
        return;
      case "super_ncc_spouse":
        state.offset -= v;
        state.superSpouse += v;
        addFlow(k, v);
        return;
    }
  };

  /** Sell pro rata across one owner's sleeve. Returns the proceeds raised. */
  const sell = (personId: PersonId, kind: SleeveKind, amount: number): number => {
    const sl = sleeveFor(personId, kind);
    const total = sleeveValue(sl);
    if (total <= 0 || amount <= 0) return 0;
    const keep = 1 - Math.min(1, amount / total);
    for (const lot of sl.lots) {
      lot.value *= keep;
      lot.cost *= keep;
      if (lot.valueAtCutover != null) lot.valueAtCutover *= keep;
    }
    return Math.min(amount, total);
  };

  /** End-of-month balances you typed, or pulled from risu, win over the projection. */
  const applyBalances = (act: ActualMonth, iso: string) => {
    const covered: PersonId[] = act.risu ? (act.risu.covers ?? ["you", "spouse"]) : [];
    if (act.risu) {
      // Risu's parcels replace the covered people's shares; the rest stay.
      const keptYield = new Map<string, number>();
      for (const sl of state.sleeves) {
        if (covered.includes(sl.person.id)) {
          const key = `${sl.person.id}_${kindOf(sl)}`;
          keptYield.set(key, (keptYield.get(key) ?? 0) + sl.accruedYield);
        }
      }
      state.sleeves = state.sleeves.filter((sl) => !covered.includes(sl.person.id));
      for (const l of act.risu.lots) {
        if (l.acquiredDate < planSince || !covered.includes(l.personId)) continue;
        sleeveFor(l.personId, l.sleeve).lots.push({
          acquiredDate: l.acquiredDate,
          cost: l.cost,
          value: l.value,
          valueAtCutover: l.valueAtCutover,
        });
      }
      for (const [key, y] of keptYield) {
        const [personId, kind] = key.split("_") as [PersonId, SleeveKind];
        sleeveFor(personId, kind).accruedYield += y;
      }
    }
    for (const [key, target] of Object.entries(act.balances?.shares ?? {}) as [
      HoldingKey,
      number,
    ][]) {
      if (!Number.isFinite(target)) continue;
      const [personId, kind] = key.split("_") as [PersonId, SleeveKind];
      if (covered.includes(personId)) continue;
      const matching = state.sleeves.filter(
        (x) => x.person.id === personId && kindOf(x) === kind,
      );
      const now = matching.reduce((t, x) => t + sleeveValue(x), 0);
      if (now > 0) {
        // The market moved: cost, date and cutover value stay.
        const f = Math.max(0, target) / now;
        for (const sl of matching) for (const lot of sl.lots) lot.value *= f;
      } else if (target > 0) {
        addLot(sleeveFor(personId, kind), target, iso);
      }
    }
    const b = act.balances;
    if (b?.offset != null) state.offset = b.offset;
    if (b?.homeLoan != null) state.homeLoan = b.homeLoan;
    if (b?.investmentLoan != null) state.invLoan = b.investmentLoan;
    if (b?.superYou != null) state.superYou = b.superYou;
  };

  if (logged0?.sweep != null) applyFlow("sweep", logged0.sweep, start, 0);
  else sweepIdleOffset(start, holidayProvisionFor(start));

  const superM = monthlyRate(a.superReturnRate) * (1 - a.superEarningsTax);

  let totalHomeInterest = 0;
  let totalInvInterest = 0;
  let totalIncomeTax = 0;
  let totalInvestmentIncomeTax = 0;
  const years: YearRow[] = [];
  const monthRows: MonthRow[] = [];

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
      homeLoan: state.homeLoan,
      investmentLoan: state.invLoan,
      offset: state.offset,
      cash: state.cash,
      restrictedOffset,
      netDebt: state.homeLoan + state.invLoan + restrictedOffset - state.offset,
    };
  };

  const sharesByHolding = (): Record<HoldingKey, number> => {
    const out: Record<HoldingKey, number> = {
      you_growth: 0,
      you_income: 0,
      spouse_growth: 0,
      spouse_income: 0,
    };
    for (const sl of state.sleeves) out[`${sl.person.id}_${kindOf(sl)}`] += sleeveValue(sl);
    for (const k of HOLDING_KEYS) out[k] = round2(out[k]);
    return out;
  };

  const day0 = fillAccessible();
  years.push({
    year: 0,
    netWealth: round2(day0.netWealth),
    accessible: round2(day0.accessible),
    superTotal: round2(day0.superTotal),
    taxableTotal: round2(day0.taxableTotal),
    homeLoan: round2(day0.homeLoan),
    investmentLoan: round2(day0.investmentLoan),
    offset: round2(day0.offset),
    cash: round2(day0.cash),
    restrictedOffset: round2(day0.restrictedOffset),
    netDebt: round2(day0.netDebt),
    homeInterest: 0,
    homeLoanPayment: 0,
    investmentInterest: 0,
    incomeTax: 0,
    cgtTax: 0,
    offsetContribution: 0,
    holidaySpend: 0,
    spareCash: 0,
    afterTaxPay: 0,
  });

  let yearHomeInterest = 0;
  let yearHomePayment = 0;
  let yearInvInterest = 0;
  let yearIncomeTax = 0;
  let yearOffsetContribution = 0;
  let yearHolidaySpend = 0;
  let yearSpareCash = 0;
  let yearAfterTaxPay = 0;

  const ccYou = placement.super_cc_you ?? 0;
  const ccSpouse = placement.super_cc_spouse ?? 0;

  // Ongoing SG + salary-sacrifice for the year, uncapped — it's compulsory
  // and is paid into the fund in full even past anyone's personal cap. The
  // excess-over-cap and Division 293 consequences are handled separately by
  // concessionalExtraTax, once per year (see the main loop).
  const sacrifice = (person: Person, yearIndex: number): number =>
    Math.max(0, person.extraConcessionalThisFy) * Math.pow(1 + incomeGrowth, yearIndex);
  const yearWorkConcessional = (person: Person, yearIndex: number): number => {
    const sched = pay[person.id];
    if (!sched) {
      return (
        (Math.max(0, person.employerSgThisFy) + Math.max(0, person.extraConcessionalThisFy)) *
        Math.pow(1 + incomeGrowth, yearIndex)
      );
    }
    return meanOverYear(sched.sgAt, yearIndex) + sacrifice(person, yearIndex);
  };
  /** SG + salary sacrifice in force this month, as an annual rate. */
  const workConcessionalThisMonth = (person: Person, m: number): number => {
    const sched = pay[person.id];
    const yearIndex = Math.floor(m / 12);
    if (!sched) return yearWorkConcessional(person, yearIndex);
    return sched.sgAt(m) + sacrifice(person, yearIndex);
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
    const income = grownIncome(p, yearIndex) - (loggedCc[id].get(yearIndex) ?? 0);
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
    const act = m === 0 ? act0 : actuals?.get(monthKey(prevDate));
    const logged = m === 0 ? logged0 : act ? loggedFlows(act, planSince) : null;
    if (m > 0) flows = {};
    const crossedCutover =
      prevDate < "2027-07-01" && date >= "2027-07-01";
    if (m > 0 && m % 12 === 0) {
      youYear = emptyTax();
      spouseYear = emptyTax();
      prevYearNet = 0;
      prevInvIncomeTax = 0;
    }
    const yearIndex = Math.floor(m / 12);

    // Year one's ongoing-contribution tax is already folded into
    // contributeCc (combined with the lump, if any). From year two on there
    // is no lump to combine with, so assess it directly, once per year.
    if (m % 12 === 0 && yearIndex >= 1) {
      const extraYou = concessionalExtraTax(
        household.you,
        grownIncome(household.you, yearIndex),
        yearWorkConcessional(household.you, yearIndex),
        0,
      );
      const extraSpouse = concessionalExtraTax(
        household.spouse,
        grownIncome(household.spouse, yearIndex),
        yearWorkConcessional(household.spouse, yearIndex),
        0,
      );
      fyTaxAccrual -= extraYou + extraSpouse;
    }

    // Logged flows land at the start of the month. Month one's went into
    // the placement above.
    if (m > 0 && logged) {
      for (const [k, v] of Object.entries(logged) as [FlowKey, number][]) {
        if (k !== "sweep") applyFlow(k, v, prevDate, m);
      }
    }

    // A recorded rate change: the bank re-sizes P&I over the term left.
    const homeRate = homeRateAt(prevDate);
    if (homeRate !== rateInForce) {
      rateInForce = homeRate;
      if (household.loan.monthlyRepayment == null && !household.loan.interestOnly) {
        scheduled = pmt(state.homeLoan, homeRate, Math.max(1, remainingMonths) / 12);
      }
    }
    const home = stepHomeLoan({
      balance: state.homeLoan,
      offset: state.offset,
      annualRate: homeRate,
      scheduledPayment: scheduled,
      interestOnly: household.loan.interestOnly,
    });
    remainingMonths = Math.max(0, remainingMonths - 1);
    state.homeLoan = home.balance;
    totalHomeInterest += home.interest;
    yearHomeInterest += home.interest;
    yearHomePayment += home.payment;

    const invInterest = state.invLoan * (invRateAt(prevDate) / 12);
    totalInvInterest += invInterest;
    yearInvInterest += invInterest;

    // After-tax pay into the pool. Spouse's pay only counts in if the
    // household actually pools income for joint expenses/saving
    // (pooledIncome) — some households pool the lump but not day-to-day pay.
    const payThisYear =
      afterTaxIncome(incomeThisMonth(household.you, m), household.you.medicareLevy) +
      (a.pooledIncome
        ? afterTaxIncome(
            incomeThisMonth(household.spouse, m),
            household.spouse.medicareLevy,
          )
        : 0);
    const payThisMonth = payThisYear / 12;
    yearAfterTaxPay += payThisMonth;

    // A holiday (or similar lump discretionary cost) once a year, pinned to
    // a calendar month rather than to the anniversary of whenever the plan
    // happened to start.
    const holidaySpendThisMonth =
      Number(prevDate.slice(5, 7)) === holidayMonth ? a.annualHolidaySpend : 0;

    // Everything the household earns and spends runs through the pool. The
    // investment-loan interest has to actually be paid, not just deducted —
    // otherwise a higher rate would manufacture a refund with no cost, and
    // debt recycling would never stop looking better as rates rise.
    const monthSpareCash =
      payThisMonth -
      home.payment -
      invInterest -
      a.monthlyExpenses -
      holidaySpendThisMonth;
    state.cash += monthSpareCash;
    // Snapshot for the month's cash-flow breakdown: where the offset stood
    // before anything this month touched it.
    const offsetOpening = state.offset;
    let dividendCash = 0;

    state.superYou *= 1 + superM;
    state.superSpouse *= 1 + superM;
    const ccTax = 1 - a.concessionalContributionsTax;
    state.superYou += (workConcessionalThisMonth(household.you, m) * ccTax) / 12;
    state.superSpouse += (workConcessionalThisMonth(household.spouse, m) * ccTax) / 12;

    const interestDeductionThisMonth = invInterest;

    for (const sl of state.sleeves) {
      const g = monthlyRate(sl.sleeve.growthRate);
      const y = monthlyRate(sl.sleeve.yieldRate);
      const mer = monthlyRate(sl.sleeve.mer);
      for (const lot of sl.lots) {
        lot.value *= 1 + g;
        sl.accruedYield += lot.value * y;
        lot.value *= 1 - mer;
        if (crossedCutover && lot.valueAtCutover == null) {
          lot.valueAtCutover = lot.value;
        }
      }
      // Yield accrues every month but only lands on the fund's schedule —
      // a quarterly ETF pays three months at once, not a twelfth each
      // month. The last month flushes whatever is still accrued so nothing
      // is left stranded at the horizon.
      const perYear = Math.min(12, Math.max(1, Math.round(sl.sleeve.distributionsPerYear)));
      const everyNMonths = Math.round(12 / perYear);
      const distributes =
        (m + 1) % everyNMonths === 0 || (m === months - 1 && !opts.midStream);
      if (!distributes) continue;
      const yieldCash = sl.accruedYield;
      sl.accruedYield = 0;
      if (yieldCash <= 0) continue;
      if (sl.sleeve.reinvestDividends) {
        // A new parcel bought via DRP this month — dated now, not backdated
        // to when the rest of the sleeve was acquired, so exit CGT sees its
        // real holding period.
        addLot(sl, yieldCash, date);
      } else {
        state.cash += yieldCash;
        dividendCash += yieldCash;
      }
      const credits = frankingCredits(yieldCash, sl.sleeve.frankingPercent);
      const bucket = sl.person.id === "you" ? youYear : spouseYear;
      bucket.assessable += yieldCash + credits;
      bucket.franking += credits;
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
    fyTaxAccrual -= netTax;

    // Settle the year's accrued tax position once, at the 1 Jul FY
    // rollover — like a real PAYG-then-annual-return cycle, not smoothed
    // into every month — or at the simulation's last month, so nothing
    // accrued is left stranded unapplied.
    const prevFyMonth = Number(prevDate.slice(5, 7));
    const fyMonth = Number(date.slice(5, 7));
    const crossedFyEnd = prevFyMonth !== 7 && fyMonth === 7;
    let taxSettlement = 0;
    if ((crossedFyEnd || (m === months - 1 && !opts.midStream)) && fyTaxAccrual !== 0) {
      taxSettlement = fyTaxAccrual;
      if (a.refundsToOffset) state.offset += fyTaxAccrual;
      else state.cash += fyTaxAccrual;
      fyTaxAccrual = 0;
    }

    // The pool is a transit account — the offset is where the household's
    // money actually lives, so the month's balance settles there either way.
    // A surplus tops the offset up; a deficit (a big holiday outrunning that
    // month's pay) is covered by it, which is what makes the offset the
    // everyday account rather than the pool carrying a negative balance
    // nobody actually owes. What happens to the money from there — sit
    // against the loan or get invested — is sweepIdleOffset's call, and the
    // cash buffer is a floor it respects.
    let monthOffsetContribution = 0;
    if (Math.abs(state.cash) > 0.005) {
      monthOffsetContribution = round2(state.cash);
      state.offset += monthOffsetContribution;
      state.cash = 0;
    }

    if (logged?.sweep != null) {
      if (m > 0) applyFlow("sweep", logged.sweep, date, m);
    } else {
      sweepIdleOffset(date, holidayProvisionFor(prevDate));
    }
    if (act) applyBalances(act, date);

    const monthSnap = fillAccessible();
    monthRows.push({
      month: m + 1,
      year: yearIndex + 1,
      // The month this row covers, not the instant it closes — a row that
      // runs 1 Jan to 1 Feb is January. `date` itself stays the closing
      // instant, since that's what CGT and FY timing key off.
      date: prevDate,
      netWealth: round2(monthSnap.netWealth),
      superTotal: round2(monthSnap.superTotal),
      taxableTotal: round2(monthSnap.taxableTotal),
      homeLoan: round2(monthSnap.homeLoan),
      investmentLoan: round2(monthSnap.investmentLoan),
      offset: round2(monthSnap.offset),
      cash: round2(monthSnap.cash),
      invested: round2(periodInvested),
      homeInterest: round2(home.interest),
      homeLoanPayment: round2(home.payment),
      investmentInterest: round2(invInterest),
      incomeTax: round2(netTax),
      offsetContribution: monthOffsetContribution,
      holidaySpend: round2(holidaySpendThisMonth),
      spareCash: round2(monthSpareCash),
      dividendCash: round2(dividendCash),
      taxSettlement: round2(taxSettlement),
      holidayReserved: round2(holidayProvisionFor(prevDate)),
      offsetOpening: round2(offsetOpening),
      investedFromOffset: round2(periodSweptFromOffset),
      afterTaxPay: round2(payThisMonth),
      superYou: round2(state.superYou),
      shares: sharesByHolding(),
      flows: Object.fromEntries(
        Object.entries(flows).map(([k, v]) => [k, round2(v)]),
      ) as Flows,
    });
    periodInvested = 0;
    periodSweptFromOffset = 0;
    yearOffsetContribution += monthOffsetContribution;
    yearHolidaySpend += holidaySpendThisMonth;
    yearSpareCash += monthSpareCash;

    if ((m + 1) % 12 === 0 || m === months - 1) {
      const year = Math.ceil((m + 1) / 12);
      const snap = fillAccessible();
      years.push({
        year,
        netWealth: round2(snap.netWealth),
        accessible: round2(snap.accessible),
        superTotal: round2(snap.superTotal),
        taxableTotal: round2(snap.taxableTotal),
        homeLoan: round2(snap.homeLoan),
        investmentLoan: round2(snap.investmentLoan),
        offset: round2(snap.offset),
        cash: round2(snap.cash),
        restrictedOffset: round2(snap.restrictedOffset),
        netDebt: round2(snap.netDebt),
        homeInterest: round2(yearHomeInterest),
        homeLoanPayment: round2(yearHomePayment),
        investmentInterest: round2(yearInvInterest),
        incomeTax: round2(yearIncomeTax),
        cgtTax: 0,
        offsetContribution: round2(yearOffsetContribution),
        holidaySpend: round2(yearHolidaySpend),
        spareCash: round2(yearSpareCash),
        afterTaxPay: round2(yearAfterTaxPay),
      });
      yearHomeInterest = 0;
      yearHomePayment = 0;
      yearInvInterest = 0;
      yearIncomeTax = 0;
      yearOffsetContribution = 0;
      yearHolidaySpend = 0;
      yearSpareCash = 0;
      yearAfterTaxPay = 0;
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

  const result: ScenarioResult = {
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
    months: monthRows,
  };

  const accruedYield: Record<HoldingKey, number> = {
    you_growth: 0,
    you_income: 0,
    spouse_growth: 0,
    spouse_income: 0,
  };
  for (const sl of state.sleeves) accruedYield[`${sl.person.id}_${kindOf(sl)}`] += sl.accruedYield;
  // The plan year the next run starts in, and its one-off contributions so far.
  const nextYear = Math.floor(months / 12);
  const ccIn = (id: PersonId) =>
    (nextYear === 0 ? (id === "you" ? ccYou : ccSpouse) : 0) +
    (loggedCc[id].get(nextYear) ?? 0);
  const closing: OpeningPosition = {
    date: endDate,
    homeLoan: state.homeLoan,
    offset: state.offset,
    invLoan: state.invLoan,
    superYou: state.superYou,
    superSpouse: state.superSpouse,
    cash: state.cash,
    lots: state.sleeves.flatMap((sl) =>
      sl.lots.map((l) => ({
        personId: sl.person.id,
        sleeve: kindOf(sl),
        cost: l.cost,
        value: l.value,
        acquiredDate: l.acquiredDate,
        valueAtCutover: l.valueAtCutover,
      })),
    ),
    scheduledPayment: scheduled,
    remainingMonths,
    taxAccrual: fyTaxAccrual,
    accruedYield,
    ccThisYear: { you: ccIn("you"), spouse: ccIn("spouse") },
  };

  return { result, closing };
}

export function runHousehold(
  household: Household,
  extra: ScenarioDef[] = [],
  opts: RunOptions = {},
): RunReport {
  const presets = buildPresets(household);
  const presetKeys = new Set(presets.map((p) => allocationKey(p.allocation)));
  const stacks = buildStacks(household).filter(
    (s) => !presetKeys.has(allocationKey(s.allocation)),
  );
  const defs = [...presets, ...stacks, ...extra];
  const results = defs.map((d) => runScenario(household, d, opts));
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
