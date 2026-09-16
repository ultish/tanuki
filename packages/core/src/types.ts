/**
 * Household lump-sum allocator types.
 * Estimates only — not ATO software or financial advice.
 */

export const CGT_REGIME_CUTOVER_ISO = "2027-07-01";

export type PersonId = "you" | "spouse";

export type Person = {
  id: PersonId;
  label: string;
  /** Marginal income tax rate as decimal, e.g. 0.45 */
  marginalRate: number;
  /** Medicare levy as decimal, e.g. 0.02 */
  medicareLevy: number;
  /** Taxable income this FY (AUD) — used for CC deduction room and Div 293 */
  taxableIncome: number;
  /** Total super balance (AUD), prior 30 June */
  superBalance: number;
  /** Concessional contributions already made this FY */
  concessionalUsedThisFy: number;
  /** Unused concessional cap carried forward (ATO 5-year rule, TSB test skipped) */
  unusedConcessionalCarryForward: number;
  age: number;
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
  /** Investment-loan rate; defaults to home rate when omitted */
  investmentLoanRate?: number;
  /** Park concessional-contribution tax refunds in the offset */
  refundsToOffset: boolean;
  /** Use NCC bring-forward when TSB allows */
  useNccBringForward: boolean;
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
  taxableTotal: number;
  netDebt: number;
  homeInterest: number;
  investmentInterest: number;
  incomeTax: number;
  cgtTax: number;
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
  homeLoan: number;
  offset: number;
  investmentLoan: number;
  netDebt: number;
  totalHomeInterest: number;
  totalInvestmentInterest: number;
  totalIncomeTax: number;
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
};

export type RunReport = {
  household: Household;
  disclaimer: string;
  results: ScenarioResult[];
};

export const DISCLAIMER =
  "Estimates only. Not financial, tax, or investment advice. Super caps are FY2026-27. CGT uses the 1 Jul 2027 cutover. CPI indexation and a 30% minimum on post-cutover gains. 50% discount only on eligible pre-cutover gain. Debt recycling assumes a clean paper trail. Pay down or offset, then a separate investment loan. Not ATO software.";
