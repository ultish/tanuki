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
import { fyOf, incomeSchedule, type IncomeSchedule } from "./income.js";
import {
  DISCLAIMER,
  HOLDING_KEYS,
  type ActualMonth,
  type Allocation,
  type AssetSleeve,
  type BucketId,
  type FlowKey,
  type Flows,
  type FyTaxState,
  type HoldingKey,
  type Household,
  type MonthRow,
  type OpeningPosition,
  type Person,
  type PersonId,
  type RunReport,
  type ScenarioDef,
  type ScenarioResult,
  type SleeveKind,
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
  kind: SleeveKind;
  person: Person;
};

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

/** Flows that put cash into shares outside super — what MonthRow.invested counts. */
function investedOf(flows: Flows): number {
  let s = flows.sweep ?? 0;
  for (const k of Object.keys(SHARE_BUCKETS) as BucketId[]) s += flows[k] ?? 0;
  return s;
}

/** "yyyy-mm" of an ISO date. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * The flows a logged month overrides. Risu, when present, is authoritative
 * for every share bucket (absent = none that month) and for the sweep, which
 * it cannot tell apart from a planned spouse growth buy. Sells of parcels
 * bought before `planSince` aren't the plan's money and are skipped.
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
    // The sweep buys in the spouse's name; risu can't tell it from a planned buy.
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
  rawAllocation: Allocation,
  /**
   * Concessional contributions already counted against this FY's cap, when
   * the household's own SG + salary-sacrifice figures aren't the whole story
   * (a run starting mid-FY from an opening position).
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
};

export type Simulation = {
  result: ScenarioResult;
  /** Position at the end of the run, ready to seed another. */
  closing: OpeningPosition;
};

export function runScenario(
  household: Household,
  def: ScenarioDef,
  opts: RunOptions = {},
): ScenarioResult {
  return simulate(household, def, opts).result;
}

export function simulate(
  household: Household,
  def: ScenarioDef,
  opts: RunOptions = {},
): Simulation {
  const a = household.assumptions;
  const loan = household.loan;
  const opening = opts.opening;
  const months = Math.max(1, Math.round(a.horizonYears * 12));
  const start = a.startDate;
  const planSince = opts.planSince ?? start;
  const restrictedOffset = Math.max(0, loan.restrictedOffset ?? 0);
  const growthRate = a.incomeGrowthRate ?? 0;
  const income: Record<PersonId, IncomeSchedule> = {
    you: incomeSchedule(household.you, start, growthRate),
    spouse: incomeSchedule(household.spouse, start, growthRate),
  };
  const personOf = (id: PersonId): Person =>
    id === "you" ? household.you : household.spouse;

  const rateEvents = [...(loan.rateEvents ?? [])].sort((x, y) =>
    x.from.localeCompare(y.from),
  );
  const homeRateAt = (iso: string): number => {
    let r = loan.annualRate;
    for (const e of rateEvents) if (e.from <= iso) r = e.annualRate;
    return r;
  };
  const invRateAt = (iso: string): number =>
    a.investmentLoanRate ?? homeRateAt(iso);

  // Tax is assessed per Australian financial year. A run that starts from an
  // opening position mid-FY carries that FY's running totals.
  const emptyFy = (): FyTaxState => ({
    assessable: 0,
    franking: 0,
    deductions: 0,
    oneOffCc: 0,
  });
  let fy = fyOf(start);
  const carried = opening && opening.fy.fy === fy ? opening.fy : null;
  const fyTax: Record<PersonId, FyTaxState> = {
    you: carried ? { ...carried.you } : emptyFy(),
    spouse: carried ? { ...carried.spouse } : emptyFy(),
  };
  let prevYearNet = carried?.prevNet ?? 0;
  let prevInvIncomeTax = carried?.prevInvTax ?? 0;

  const { applied, warnings } = applyCaps(
    household,
    def.allocation,
    opening
      ? {
          you: income.you.fy(fy).work + fyTax.you.oneOffCc,
          spouse: income.spouse.fy(fy).work + fyTax.spouse.oneOffCc,
        }
      : undefined,
  );

  const sleeveAsset = (kind: SleeveKind): AssetSleeve =>
    kind === "growth" ? a.growthAsset : a.incomeAsset;

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
        homeLoan: loan.balance,
        offset: loan.offset,
        invLoan: 0,
        superYou: household.you.superBalance,
        superSpouse: household.spouse.superBalance,
        sleeves: [],
        cash: 0,
      };

  const sleeveFor = (personId: PersonId, kind: SleeveKind): SleeveState => {
    let sl = state.sleeves.find(
      (s) => s.person.id === personId && s.kind === kind,
    );
    if (!sl) {
      sl = { lots: [], sleeve: sleeveAsset(kind), kind, person: personOf(personId) };
      state.sleeves.push(sl);
    }
    return sl;
  };

  const setLots = (
    lots: {
      personId: PersonId;
      sleeve: SleeveKind;
      cost: number;
      value: number;
      acquiredDate: string;
      valueAtCutover: number | null;
    }[],
  ) => {
    state.sleeves = [];
    for (const l of lots) {
      sleeveFor(l.personId, l.sleeve).lots.push({
        acquiredDate: l.acquiredDate,
        cost: l.cost,
        value: l.value,
        valueAtCutover: l.valueAtCutover,
      });
    }
  };
  if (opening) setLots(opening.lots);

  const buy = (
    personId: PersonId,
    kind: SleeveKind,
    amount: number,
    acquiredDate: string,
  ) => {
    if (amount <= 0) return;
    sleeveFor(personId, kind).lots.push({
      acquiredDate,
      cost: amount,
      value: amount,
      valueAtCutover: null,
    });
  };

  /** Sell pro rata across a sleeve's lots. Returns the proceeds actually raised. */
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

  let flows: Flows = {};
  const addFlow = (k: FlowKey, v: number) => {
    if (v) flows[k] = (flows[k] ?? 0) + v;
  };

  const placeDebtRecycle = (amount: number, kind: SleeveKind, date: string) => {
    if (amount <= 0) return;
    const availableBalance = state.homeLoan;
    const pay = Math.min(amount, availableBalance);
    state.homeLoan -= pay;
    state.invLoan += pay;
    buy("you", kind, pay, date);
    addFlow(kind === "growth" ? "debt_recycle_you_growth" : "debt_recycle_you_income", pay);
    if (amount > pay) {
      const shortfall = amount - pay;
      state.offset += shortfall;
      warnings.push(
        `Asked to debt-recycle $${Math.round(amount).toLocaleString("en-AU")} but the home loan balance is only $${Math.round(availableBalance).toLocaleString("en-AU")}. The extra $${Math.round(shortfall).toLocaleString("en-AU")} was parked in the offset instead.`,
      );
    }
  };

  const toHousehold = (amount: number) => {
    if (a.refundsToOffset) state.offset += amount;
    else state.cash += amount;
  };

  /**
   * Extra tax on top of the fund's flat 15%, for a concessional contribution
   * arriving this year: Division 293 above the income threshold, and
   * excess-concessional-contributions tax above the cap (marginal rate,
   * less a 15% offset for the contributions tax the fund already withheld).
   * `raw` is the ongoing SG + salary-sacrifice for the year (uncapped —
   * employer SG is compulsory and is paid in full regardless of anyone's
   * personal cap); `oneOff` is the lump or logged contributions on top.
   */
  const concessionalExtraTax = (
    person: Person,
    taxableIncomeThisYear: number,
    raw: number,
    oneOff: number,
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
      cappedRaw + oneOff,
      a.div293Threshold,
    );
    return excessTax + div293;
  };

  /**
   * The FY's extra tax on ongoing SG + salary sacrifice alone, accrued a
   * twelfth a month so a run bears exactly the months it covers.
   */
  const accrueWorkExtraTax = () => {
    for (const id of ["you", "spouse"] as const) {
      const t = income[id].fy(fy);
      const extra = concessionalExtraTax(personOf(id), t.taxableIncome, t.work, 0);
      if (extra > 0) toHousehold(-extra / 12);
    }
  };

  /**
   * A one-off concessional contribution: into the fund net of 15%, the
   * income-tax saving back to the household, less any Division 293 it adds
   * on top of what this FY already carries.
   */
  const contributeCc = (id: PersonId, amount: number) => {
    if (amount <= 0) return;
    const person = personOf(id);
    const t = income[id].fy(fy);
    const prior = fyTax[id].oneOffCc;
    const extra =
      concessionalExtraTax(person, t.taxableIncome, t.work, prior + amount) -
      concessionalExtraTax(person, t.taxableIncome, t.work, prior);
    const intoFund = amount * (1 - a.concessionalContributionsTax);
    if (id === "you") state.superYou += intoFund;
    else state.superSpouse += intoFund;
    const saving = -taxDelta(t.taxableIncome - prior, -amount, person.medicareLevy);
    fyTax[id].oneOffCc += amount;
    toHousehold(saving - extra);
  };

  /** Money moved after the lump is placed, out of (or back into) the offset. */
  const applyFlow = (k: FlowKey, v: number, date: string) => {
    if (!v || k === "offset") return;
    if (k === "sweep") {
      if (v > 0) {
        state.offset -= v;
        buy("spouse", "growth", v, date);
      } else {
        state.offset += sell("spouse", "growth", -v);
      }
      addFlow(k, v);
      return;
    }
    const share = SHARE_BUCKETS[k];
    if (share) {
      if (v > 0) {
        state.offset -= v;
        if (share.recycle) {
          placeDebtRecycle(v, share.kind, date);
        } else {
          buy(share.personId, share.kind, v, date);
          addFlow(k, v);
        }
      } else {
        const proceeds = sell(share.personId, share.kind, -v);
        const repay = share.recycle ? Math.min(proceeds, state.invLoan) : 0;
        state.invLoan -= repay;
        state.offset += proceeds - repay;
        addFlow(k, -proceeds);
      }
      return;
    }
    if (v < 0) return;
    switch (k) {
      case "extra_repay": {
        const pay = Math.min(v, state.homeLoan);
        state.homeLoan -= pay;
        state.offset -= pay;
        addFlow(k, pay);
        return;
      }
      case "super_cc_you":
      case "super_cc_spouse":
        state.offset -= v;
        contributeCc(k === "super_cc_you" ? "you" : "spouse", v);
        addFlow(k, v);
        return;
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

  const sweepIdleOffset = (acquiredDate: string) => {
    if (!a.sweepIdleOffset) return;
    // Only the restricted floor is protected — this sweeps past the home
    // loan balance too, trading the guaranteed home-loan-rate interest
    // save for the sleeve's (uncertain) return. The loan still pays down
    // slower as a result: stepHomeLoan charges real interest on whatever
    // of it stops being offset.
    const idle = state.offset - restrictedOffset;
    if (idle <= 0.5) return;
    state.offset -= idle;
    buy("spouse", "growth", idle, acquiredDate);
    addFlow("sweep", idle);
  };

  /** End-of-month balances you typed, or pulled from risu, win over the projection. */
  const applyBalances = (act: ActualMonth, date: string) => {
    const covered: PersonId[] = act.risu ? (act.risu.covers ?? ["you", "spouse"]) : [];
    if (act.risu) {
      // Risu's parcels replace the covered people's shares; the rest stay.
      const kept = state.sleeves.filter((sl) => !covered.includes(sl.person.id));
      state.sleeves = kept;
      for (const l of act.risu.lots) {
        if (l.acquiredDate < planSince || !covered.includes(l.personId)) continue;
        sleeveFor(l.personId, l.sleeve).lots.push({
          acquiredDate: l.acquiredDate,
          cost: l.cost,
          value: l.value,
          valueAtCutover: l.valueAtCutover,
        });
      }
    }
    {
      for (const [key, target] of Object.entries(act.balances?.shares ?? {}) as [
        HoldingKey,
        number,
      ][]) {
        if (!Number.isFinite(target)) continue;
        const [personId, kind] = key.split("_") as [PersonId, SleeveKind];
        if (covered.includes(personId)) continue;
        const sl = sleeveFor(personId, kind);
        const now = sleeveValue(sl);
        if (now > 0) {
          // The market moved: cost, date and cutover value stay.
          const f = Math.max(0, target) / now;
          for (const lot of sl.lots) lot.value *= f;
        } else if (target > 0) {
          buy(personId, kind, target, date);
        }
      }
    }
    const b = act.balances;
    if (b?.offset != null) state.offset = b.offset;
    if (b?.homeLoan != null) state.homeLoan = b.homeLoan;
    if (b?.investmentLoan != null) state.invLoan = b.investmentLoan;
    if (b?.superYou != null) state.superYou = b.superYou;
  };

  // ── Month one: place the lump ────────────────────────────────────────────
  const act0 = opts.actuals?.get(monthKey(start));
  const logged0 = act0 ? loggedFlows(act0, planSince) : null;
  let placement: Allocation = applied;
  if (logged0) {
    // What you actually did with the lump. Unlogged buckets follow the plan;
    // whatever wasn't placed sits in the offset.
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
  for (const k of [
    "taxable_you_growth",
    "taxable_you_income",
    "taxable_spouse_growth",
    "taxable_spouse_income",
  ] as const) {
    const share = SHARE_BUCKETS[k]!;
    buy(share.personId, share.kind, placement[k] ?? 0, start);
    addFlow(k, placement[k] ?? 0);
  }
  placeDebtRecycle(placement.debt_recycle_you_growth ?? 0, "growth", start);
  placeDebtRecycle(placement.debt_recycle_you_income ?? 0, "income", start);
  contributeCc("you", placement.super_cc_you ?? 0);
  contributeCc("spouse", placement.super_cc_spouse ?? 0);
  addFlow("super_cc_you", placement.super_cc_you ?? 0);
  addFlow("super_cc_spouse", placement.super_cc_spouse ?? 0);
  state.superYou += placement.super_ncc_you ?? 0;
  state.superSpouse += placement.super_ncc_spouse ?? 0;
  addFlow("super_ncc_you", placement.super_ncc_you ?? 0);
  addFlow("super_ncc_spouse", placement.super_ncc_spouse ?? 0);
  if (logged0?.sweep != null) applyFlow("sweep", logged0.sweep, start);
  else sweepIdleOffset(start);

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
    const out = { you_growth: 0, you_income: 0, spouse_growth: 0, spouse_income: 0 };
    for (const sl of state.sleeves) out[`${sl.person.id}_${sl.kind}`] += sleeveValue(sl);
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
    investmentInterest: 0,
    incomeTax: 0,
    cgtTax: 0,
  });

  let yearHomeInterest = 0;
  let yearInvInterest = 0;
  let yearIncomeTax = 0;

  /** Salary for the FY, less one-off concessional deductions — the base investment income sits on. */
  const personBase = (id: PersonId): number =>
    income[id].fy(fy).taxableIncome - fyTax[id].oneOffCc;

  const yearNet = (id: PersonId): number => {
    const st = fyTax[id];
    return (
      taxDelta(personBase(id), st.assessable - st.deductions, personOf(id).medicareLevy) -
      st.franking
    );
  };

  const yearYieldTax = (id: PersonId): number => {
    const st = fyTax[id];
    return (
      taxDelta(personBase(id), st.assessable, personOf(id).medicareLevy) - st.franking
    );
  };

  let scheduled =
    opening?.scheduledPayment ??
    loan.monthlyRepayment ??
    pmt(loan.balance, homeRateAt(start), loan.remainingYears);
  let remainingMonths = opening?.remainingMonths ?? Math.round(loan.remainingYears * 12);
  let rateInForce = homeRateAt(start);

  for (let m = 0; m < months; m++) {
    const monthStart = addMonthsIso(start, m);
    const date = addMonthsIso(start, m + 1);
    const crossedCutover = monthStart < "2027-07-01" && date >= "2027-07-01";
    const act = m === 0 ? act0 : opts.actuals?.get(monthKey(monthStart));
    const logged = m === 0 ? logged0 : act ? loggedFlows(act, planSince) : null;
    if (m > 0) flows = {};

    const monthFy = fyOf(monthStart);
    if (monthFy !== fy) {
      fy = monthFy;
      fyTax.you = emptyFy();
      fyTax.spouse = emptyFy();
      prevYearNet = 0;
      prevInvIncomeTax = 0;
    }
    accrueWorkExtraTax();

    // Logged flows land at the start of the month. Month one's went into
    // the placement above.
    if (m > 0 && logged) {
      for (const [k, v] of Object.entries(logged) as [FlowKey, number][]) {
        if (k !== "sweep") applyFlow(k, v, monthStart);
      }
    }

    const rate = homeRateAt(monthStart);
    if (rate !== rateInForce) {
      rateInForce = rate;
      if (loan.monthlyRepayment == null && !loan.interestOnly) {
        scheduled = pmt(state.homeLoan, rate, Math.max(1, remainingMonths) / 12);
      }
    }
    const home = stepHomeLoan({
      balance: state.homeLoan,
      offset: state.offset,
      annualRate: rate,
      scheduledPayment: scheduled,
      interestOnly: loan.interestOnly,
    });
    state.homeLoan = home.balance;
    remainingMonths = Math.max(0, remainingMonths - 1);
    totalHomeInterest += home.interest;
    yearHomeInterest += home.interest;
    // P&I is assumed paid from salary. If the loan does not need the full
    // scheduled amount (paid off, or last partial), the leftover still
    // exists as household cashflow — park it in the offset so extra-repay
    // gets credit for freeing the mortgage payment.
    if (!loan.interestOnly) {
      const surplus = Math.max(0, scheduled - home.payment);
      if (surplus > 0) state.offset += surplus;
    }

    const invInterest = state.invLoan * (invRateAt(monthStart) / 12);
    totalInvInterest += invInterest;
    yearInvInterest += invInterest;
    // The deduction below only reduces tax owed; the interest itself still
    // has to be paid, or it isn't a real deduction. Without this, a higher
    // investment-loan rate manufactures a bigger "refund" with no offsetting
    // cost, so debt recycling would never stop looking better as rates rise.
    state.cash -= invInterest;

    state.superYou *= 1 + superM;
    state.superSpouse *= 1 + superM;
    const ccTax = 1 - a.concessionalContributionsTax;
    const workYou = income.you.at(monthStart);
    const workSpouse = income.spouse.at(monthStart);
    state.superYou += ((workYou.sg + workYou.sacrifice) * ccTax) / 12;
    state.superSpouse += ((workSpouse.sg + workSpouse.sacrifice) * ccTax) / 12;

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
        if (yieldCash > 0) {
          sl.lots.push({ acquiredDate: date, cost: yieldCash, value: yieldCash, valueAtCutover: null });
        }
      } else {
        state.cash += yieldCash;
      }
      if (yieldCash > 0) {
        const credits = frankingCredits(yieldCash, sl.sleeve.frankingPercent);
        const bucket = fyTax[sl.person.id];
        bucket.assessable += yieldCash + credits;
        bucket.franking += credits;
      }
    }

    fyTax.you.deductions += invInterest;
    const netTaxYtd = yearNet("you") + yearNet("spouse");
    const netTax = netTaxYtd - prevYearNet;
    prevYearNet = netTaxYtd;
    totalIncomeTax += netTax;
    yearIncomeTax += netTax;
    const yieldTaxYtd = yearYieldTax("you") + yearYieldTax("spouse");
    totalInvestmentIncomeTax += yieldTaxYtd - prevInvIncomeTax;
    prevInvIncomeTax = yieldTaxYtd;
    toHousehold(-netTax);

    if (m > 0) {
      if (logged?.sweep != null) applyFlow("sweep", logged.sweep, date);
      else sweepIdleOffset(date);
    } else if (logged0?.sweep == null) {
      sweepIdleOffset(date);
    }
    if (act) applyBalances(act, date);

    const monthSnap = fillAccessible();
    monthRows.push({
      month: m + 1,
      date: monthKey(monthStart),
      year: Math.floor(m / 12) + 1,
      netWealth: round2(monthSnap.netWealth),
      superTotal: round2(monthSnap.superTotal),
      superYou: round2(state.superYou),
      taxableTotal: round2(monthSnap.taxableTotal),
      shares: sharesByHolding(),
      flows: Object.fromEntries(
        Object.entries(flows).map(([k, v]) => [k, round2(v)]),
      ) as Flows,
      homeLoan: round2(monthSnap.homeLoan),
      investmentLoan: round2(monthSnap.investmentLoan),
      offset: round2(monthSnap.offset),
      cash: round2(monthSnap.cash),
      invested: round2(investedOf(flows)),
      homeInterest: round2(home.interest),
      investmentInterest: round2(invInterest),
      incomeTax: round2(netTax),
    });

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
    const person = { ...sl.person, taxableIncome: personBase(sl.person.id) };
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

  const takenBy = (id: PersonId) =>
    state.sleeves
      .filter((s) => s.person.id === id)
      .reduce((s, x) => s + sleeveValue(x), 0);

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
    taxableYou: round2(takenBy("you")),
    taxableSpouse: round2(takenBy("spouse")),
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
        sleeve: sl.kind,
        cost: l.cost,
        value: l.value,
        acquiredDate: l.acquiredDate,
        valueAtCutover: l.valueAtCutover,
      })),
    ),
    scheduledPayment: scheduled,
    remainingMonths,
    fy: {
      fy,
      you: { ...fyTax.you },
      spouse: { ...fyTax.spouse },
      prevNet: prevYearNet,
      prevInvTax: prevInvIncomeTax,
    },
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
