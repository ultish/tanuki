/**
 * Household lump-sum allocator types.
 * Estimates only — not ATO software or financial advice.
 */

export const CGT_REGIME_CUTOVER_ISO = "2027-07-01";

export type PersonId = "you" | "spouse";

export type Person = {
  id: PersonId;
  label: string;
  /** Last-dollar PIT as decimal, e.g. 0.45. Ranking uses the FY2026-27 scale on taxable income. */
  marginalRate: number;
  /** Medicare levy as decimal, e.g. 0.02 */
  medicareLevy: number;
  /** Taxable income this FY (AUD) — used for CC deduction room and Div 293 */
  taxableIncome: number;
  /** Total super balance (AUD), prior 30 June */
  superBalance: number;
  /** Annual gross salary (OTE) this FY — the basis for `sgRatePercent` below. */
  salary: number;
  /** Employer Super Guarantee rate as a percentage, e.g. 12 for 12%. */
  sgRatePercent: number;
  /** Salary-sacrifice or personal deductible contribution, per fortnight, before tax. */
  extraConcessionalFortnightly: number;
  /**
   * Employer Super Guarantee expected this FY, before the lump.
   * Derived — `salary * sgRatePercent / 100`, kept in sync by `mergePerson`.
   * Still a real field because the engine reads it directly.
   */
  employerSgThisFy: number;
  /**
   * Salary sacrifice or personal deductible contributions already planned
   * this FY, before the lump.
   * Derived — `extraConcessionalFortnightly * 26`, kept in sync by `mergePerson`.
   */
  extraConcessionalThisFy: number;
  /** Unused concessional cap carried forward (ATO 5-year rule, TSB test skipped) */
  unusedConcessionalCarryForward: number;
  age: number;
  /**
   * Real pay changes, each "my taxable income is X from date Y". An event
   * resets the base; `Assumptions.incomeGrowthRate` keeps compounding from
   * it each 1 July. Events dated before a plan's start still apply, so a
   * rise logged after `taxableIncome` was last edited is not lost.
   */
  payEvents?: PayEvent[];
};

export type PayEvent = {
  /** ISO yyyy-mm-dd the new pay takes effect. */
  from: string;
  taxableIncome: number;
  /**
   * New OTE salary, which drives employer SG. Omitted: SG scales by the
   * same ratio as `taxableIncome`, which is right for an ordinary rise.
   */
  salary?: number;
};

/** "The home loan rate is X from date Y." */
export type RateEvent = {
  from: string;
  annualRate: number;
};

export type Loan = {
  /** Outstanding home loan principal */
  balance: number;
  /** Offset balance (reduces interest-bearing principal) */
  offset: number;
  /** Home loan rate as decimal, e.g. 0.058 */
  annualRate: number;
  remainingYears: number;
  /** If set, used as the P&I (or IO) payment; else computed from balance/term */
  monthlyRepayment?: number;
  interestOnly: boolean;
  /**
   * Offset money that isn't yours (e.g. a family loan you must repay).
   * Still reduces home-loan interest while it sits there, but it's excluded
   * from net wealth and never swept into investments.
   */
  restrictedOffset?: number;
  /**
   * Dated rate changes. `annualRate` is the rate before the first event.
   * When `monthlyRepayment` is unset, the P&I repayment is recalculated
   * over the remaining term each time the rate changes, as a bank would.
   * The investment loan follows these too while `investmentLoanRate` is null.
   */
  rateEvents?: RateEvent[];
};

export type AssetSleeve = {
  label: string;
  /** Expected capital growth effective p.a. */
  growthRate: number;
  /** Expected cash yield effective p.a. */
  yieldRate: number;
  mer: number;
  /** 0–100 */
  frankingPercent: number;
  /** Reinvest yield (DRP). Tax still levied. */
  reinvestDividends: boolean;
};

export type Assumptions = {
  horizonYears: number;
  /** ISO yyyy-mm-dd */
  startDate: string;
  /** CPI used to index cost base after 1 Jul 2027 */
  inflationRate: number;
  /** Grows taxable income, employer SG, and extra concessional each year */
  incomeGrowthRate: number;
  growthAsset: AssetSleeve;
  incomeAsset: AssetSleeve;
  /**
   * Super total return p.a. before 15% earnings tax.
   * Model applies earnings tax on the whole return (does not split CGT 10%).
   */
  superReturnRate: number;
  superEarningsTax: number;
  concessionalContributionsTax: number;
  div293Threshold: number;
  concessionalCap: number;
  nonConcessionalCap: number;
  /** 3-year bring-forward (3 × annual NCC) */
  nccBringForwardCap: number;
  /** TSB at or above this → NCC cap is nil */
  tsbNccLimit: number;
  /** TSB below this → full 3-year bring-forward */
  tsbBringForward3y: number;
  /** TSB below this (and at/above tsbBringForward3y) → 2-year bring-forward */
  tsbBringForward2y: number;
  /**
   * Investment-loan rate; falls back to the home rate when null. `null`
   * rather than optional/undefined so a client can explicitly clear it —
   * JSON.stringify drops `undefined` keys, so an optional field can never
   * be un-set over a PUT, only ever set.
   */
  investmentLoanRate: number | null;
  /** Park concessional-contribution tax refunds in the offset */
  refundsToOffset: boolean;
  /** Use NCC bring-forward when TSB allows */
  useNccBringForward: boolean;
  /** Invest offset above the home loan in unlevered shares */
  sweepIdleOffset: boolean;
};

export type Household = {
  lumpSum: number;
  you: Person;
  spouse: Person;
  loan: Loan;
  assumptions: Assumptions;
};

/**
 * Where a dollar of the lump can go. Amounts in a scenario should sum to
 * the lump (engine dumps leftover into offset and records a warning).
 */
export type BucketId =
  | "offset"
  | "extra_repay"
  | "taxable_you_growth"
  | "taxable_you_income"
  | "taxable_spouse_growth"
  | "taxable_spouse_income"
  | "debt_recycle_you_growth"
  | "debt_recycle_you_income"
  | "super_cc_you"
  | "super_cc_spouse"
  | "super_ncc_you"
  | "super_ncc_spouse";

export type Allocation = Partial<Record<BucketId, number>>;

export type ScenarioDef = {
  id: string;
  label: string;
  summary: string;
  group:
    | "loan"
    | "taxable"
    | "recycle"
    | "super"
    | "mix"
    | "custom";
  allocation: Allocation;
};

export type YearRow = {
  year: number;
  netWealth: number;
  accessible: number;
  superTotal: number;
  /** Shares outside super — you + spouse, own name + debt-recycled + swept idle offset. */
  taxableTotal: number;
  /** Owner-occupier home loan balance. */
  homeLoan: number;
  /** Investment (debt-recycle) loan balance. */
  investmentLoan: number;
  /** Full offset balance, including any restrictedOffset still sitting in it. */
  offset: number;
  /** Uninvested cash outside the offset account. */
  cash: number;
  /** Offset money that isn't yours (see Loan.restrictedOffset). Constant for the run. */
  restrictedOffset: number;
  netDebt: number;
  homeInterest: number;
  investmentInterest: number;
  incomeTax: number;
  cgtTax: number;
};

/**
 * One simulated month — the same balances as YearRow, at monthly grain, plus
 * `invested`: new cash actually moved into taxable investments that month
 * (the initial lump placement folded into month 1, plus any idle-offset
 * sweep). Does not include DRP reinvestment — that's automatic, not an
 * action anyone takes.
 */
export type MonthRow = {
  month: number;
  /** Calendar month this row covers, "yyyy-mm". Balances are as at its end. */
  date: string;
  /** Which YearRow.year this month rolls into (1-based; month 1..12 -> year 1). */
  year: number;
  netWealth: number;
  superTotal: number;
  superYou: number;
  taxableTotal: number;
  /** Shares outside super by owner and sleeve. Debt-recycled shares are in `you_*`. */
  shares: Record<HoldingKey, number>;
  /**
   * Money moved this month, by bucket. Month 1 carries the lump placement;
   * later months the idle-offset sweep and anything logged. Negative is a
   * sell.
   */
  flows: Flows;
  homeLoan: number;
  investmentLoan: number;
  offset: number;
  cash: number;
  invested: number;
  homeInterest: number;
  investmentInterest: number;
  incomeTax: number;
};

export type ScenarioResult = {
  id: string;
  label: string;
  summary: string;
  group: ScenarioDef["group"];
  allocation: Allocation;
  /** Applied after cap clamps; leftover parked in offset */
  appliedAllocation: Allocation;
  warnings: string[];
  notes: string[];
  /** Assets − debts at horizon (house value excluded — constant across scenarios) */
  netWealth: number;
  /** Super is preserved; this is everything else */
  accessible: number;
  superYou: number;
  superSpouse: number;
  taxableYou: number;
  taxableSpouse: number;
  /** Taxable you + spouse. Shares outside super. */
  investmentOutsideSuper: number;
  homeLoan: number;
  offset: number;
  investmentLoan: number;
  netDebt: number;
  totalHomeInterest: number;
  totalInvestmentInterest: number;
  totalIncomeTax: number;
  /** Tax on dividends/yield only. Does not include the investment-loan deduction. */
  investmentIncomeTax: number;
  /** investmentIncomeTax + exitCgt */
  investmentTaxIfSold: number;
  /** CGT if liquidated at horizon (not deducted from netWealth unless noted) */
  exitCgt: number;
  /** netWealth − exitCgt */
  netIfLiquidated: number;
  /**
   * Same portfolios under a counterfactual 50% CGT discount (no indexation,
   * no 30% floor) — for “what 2027 changed” comparisons.
   */
  exitCgtIfLegacyDiscount: number;
  totalCapitalIn: number;
  years: YearRow[];
  months: MonthRow[];
};

export type SleeveKind = "growth" | "income";
export type HoldingKey = `${PersonId}_${SleeveKind}`;
export const HOLDING_KEYS: readonly HoldingKey[] = [
  "you_growth",
  "you_income",
  "spouse_growth",
  "spouse_income",
];

/** An allocation bucket, or the idle-offset sweep. */
export type FlowKey = BucketId | "sweep";
export type Flows = Partial<Record<FlowKey, number>>;

/** One share parcel carried into a run that does not start from nothing. */
export type OpeningLot = {
  personId: PersonId;
  sleeve: SleeveKind;
  cost: number;
  value: number;
  acquiredDate: string;
  valueAtCutover: number | null;
};

/**
 * Where a household actually is at `date` — enough to carry on a
 * simulation from there instead of from a standing start.
 */
export type OpeningPosition = {
  /** ISO yyyy-mm-dd: the first day of the run that starts here. */
  date: string;
  homeLoan: number;
  offset: number;
  invLoan: number;
  superYou: number;
  superSpouse: number;
  cash: number;
  lots: OpeningLot[];
  /** The P&I repayment in force, so the new run doesn't silently re-amortise. */
  scheduledPayment: number;
  remainingMonths: number;
  /**
   * The financial year in progress, so a run starting mid-FY taxes the rest
   * of it on the same base and sees cap room already used.
   */
  fy: {
    fy: number;
    you: FyTaxState;
    spouse: FyTaxState;
    prevNet: number;
    prevInvTax: number;
  };
};

export type FyTaxState = {
  assessable: number;
  franking: number;
  deductions: number;
  /** One-off concessional contributions this FY: lump placement plus logged. */
  oneOffCc: number;
};

/** A parcel as pulled from risu, already mapped onto tanuki's owners/sleeves. */
export type RisuLot = {
  /** Risu portfolio it came from; a plan only reads the portfolios it tracks. */
  portfolioId: number;
  personId: PersonId;
  purpose: "taxable" | "debt_recycle";
  sleeve: SleeveKind;
  ticker: string;
  cost: number;
  /** AUD at month end. */
  value: number;
  acquiredDate: string;
  valueAtCutover: number | null;
};

export type RisuTrade = {
  portfolioId: number;
  bucket: BucketId;
  ticker: string;
  /** Buy: the trade date. Sell: the disposal date. */
  date: string;
  /** Sells only: when the parcel sold was bought. */
  acquiredDate?: string;
  /** AUD. Positive for a buy (cost), negative for a sell (proceeds). */
  amount: number;
};

/**
 * One calendar month of what actually happened. Lives once on the
 * household; every tracker reads the same log. Absent fields mean "use the
 * projection".
 */
export type ActualMonth = {
  /** "yyyy-mm" */
  date: string;
  confirmed: boolean;
  flows?: Flows;
  balances?: {
    offset?: number;
    homeLoan?: number;
    investmentLoan?: number;
    superYou?: number;
    shares?: Partial<Record<HoldingKey, number>>;
  };
  /** Present when shares were pulled from risu; replaces share flows and balances. */
  risu?: {
    pulledAt: string;
    lots: RisuLot[];
    trades: RisuTrade[];
    /**
     * Whose shares these parcels account for. Risu replaces the projection
     * only for them; anyone else's shares stay typed or projected. Set when a
     * plan narrows the log to the portfolios it tracks; absent means both.
     */
    covers?: PersonId[];
  };
  note?: string;
};

export type RunReport = {
  household: Household;
  disclaimer: string;
  results: ScenarioResult[];
};

export const DISCLAIMER =
  "Estimates only. Not financial, tax, or investment advice. Super caps are FY2026-27. CGT uses the 1 Jul 2027 cutover. CPI indexation and a 30% minimum on post-cutover gains. 50% discount only on eligible pre-cutover gain. Debt recycling pays down the home loan, then redraws an investment split. Not ATO software.";
