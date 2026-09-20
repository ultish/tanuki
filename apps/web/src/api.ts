export type Person = {
  id: "you" | "spouse";
  label: string;
  marginalRate: number;
  medicareLevy: number;
  taxableIncome: number;
  superBalance: number;
  salary: number;
  sgRatePercent: number;
  extraConcessionalFortnightly: number;
  employerSgThisFy: number;
  extraConcessionalThisFy: number;
  unusedConcessionalCarryForward: number;
  age: number;
};

export type Loan = {
  balance: number;
  offset: number;
  annualRate: number;
  remainingYears: number;
  monthlyRepayment?: number;
  interestOnly: boolean;
  restrictedOffset?: number;
};

export type AssetSleeve = {
  label: string;
  growthRate: number;
  yieldRate: number;
  mer: number;
  frankingPercent: number;
  reinvestDividends: boolean;
};

export type Assumptions = {
  horizonYears: number;
  startDate: string;
  inflationRate: number;
  incomeGrowthRate: number;
  growthAsset: AssetSleeve;
  incomeAsset: AssetSleeve;
  superReturnRate: number;
  superEarningsTax: number;
  concessionalContributionsTax: number;
  div293Threshold: number;
  concessionalCap: number;
  nonConcessionalCap: number;
  nccBringForwardCap: number;
  tsbNccLimit: number;
  tsbBringForward3y: number;
  tsbBringForward2y: number;
  investmentLoanRate: number | null;
  refundsToOffset: boolean;
  useNccBringForward: boolean;
  sweepIdleOffset: boolean;
};

export type Household = {
  lumpSum: number;
  you: Person;
  spouse: Person;
  loan: Loan;
  assumptions: Assumptions;
};

export type Allocation = Record<string, number>;

export type YearRow = {
  year: number;
  netWealth: number;
  accessible: number;
  superTotal: number;
  taxableTotal: number;
  homeLoan: number;
  investmentLoan: number;
  offset: number;
  cash: number;
  restrictedOffset: number;
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
  group: string;
  allocation: Allocation;
  appliedAllocation: Allocation;
  warnings: string[];
  notes: string[];
  netWealth: number;
  accessible: number;
  superYou: number;
  superSpouse: number;
  taxableYou: number;
  taxableSpouse: number;
  investmentOutsideSuper: number;
  homeLoan: number;
  offset: number;
  investmentLoan: number;
  netDebt: number;
  totalHomeInterest: number;
  totalInvestmentInterest: number;
  totalIncomeTax: number;
  investmentIncomeTax: number;
  investmentTaxIfSold: number;
  exitCgt: number;
  netIfLiquidated: number;
  exitCgtIfLegacyDiscount: number;
  totalCapitalIn: number;
  years: YearRow[];
};

export type RunReport = {
  household: Household;
  disclaimer: string;
  results: ScenarioResult[];
};

export type Explainer = { id: string; title: string; body: string };

export type Meta = {
  fy: string;
  caps: Record<string, number>;
  explainers: Explainer[];
  disclaimer: string;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function fetchHousehold(): Promise<Household> {
  return fetch("/api/household").then((r) => json<Household>(r));
}

export function saveHousehold(h: Household): Promise<Household> {
  return fetch("/api/household", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(h),
  }).then((r) => json<Household>(r));
}

export function fetchMeta(): Promise<Meta> {
  return fetch("/api/meta").then((r) => json<Meta>(r));
}

export function runPlan(
  household: Household,
  custom?: Allocation,
): Promise<RunReport> {
  return fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ household, custom }),
  }).then((r) => json<RunReport>(r));
}
