import type {
  ActualMonth,
  LaterLease,
  Flows,
  HoldingKey,
  PayEvent,
  RateEvent,
  RisuLink,
  TrackerView,
} from "@tanuki/core";

export type {
  ActualMonth,
  Flows,
  HoldingKey,
  LaterLease,
  PayEvent,
  RateEvent,
  RisuLink,
  TrackerView,
};

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
  novatedLeaseFortnightly: number;
  novatedLeaseEndDate: string;
  laterLeases?: LaterLease[];
  payEvents?: PayEvent[];
};

export type Loan = {
  balance: number;
  offset: number;
  annualRate: number;
  remainingYears: number;
  monthlyRepayment?: number;
  interestOnly: boolean;
  restrictedOffset?: number;
  rateEvents?: RateEvent[];
};

export type AssetSleeve = {
  label: string;
  growthRate: number;
  yieldRate: number;
  mer: number;
  frankingPercent: number;
  reinvestDividends: boolean;
  distributionsPerYear: number;
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
  minimumCash: number;
  monthlyExpenses: number;
  expenseInflationRate: number;
  annualHolidaySpend: number;
  holidayMonth: number;
  holidayFundOnTop: boolean;
  pooledIncome: boolean;
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
  homeLoanPayment: number;
  investmentInterest: number;
  incomeTax: number;
  cgtTax: number;
  offsetContribution: number;
  holidaySpend: number;
  spareCash: number;
  afterTaxPay: number;
};

export type MonthRow = {
  month: number;
  year: number;
  date: string;
  netWealth: number;
  superTotal: number;
  superYou: number;
  taxableTotal: number;
  shares: Record<HoldingKey, number>;
  flows: Flows;
  homeLoan: number;
  investmentLoan: number;
  offset: number;
  cash: number;
  invested: number;
  homeInterest: number;
  homeLoanPayment: number;
  investmentInterest: number;
  incomeTax: number;
  offsetContribution: number;
  holidaySpend: number;
  spareCash: number;
  dividendCash: number;
  taxSettlement: number;
  holidayReserved: number;
  offsetOpening: number;
  investedFromOffset: number;
  afterTaxPay: number;
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
  months: MonthRow[];
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

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    let detail: unknown;
    try {
      detail = JSON.parse(text);
      if (detail && typeof detail === "object" && "error" in detail) {
        message = String((detail as { error: unknown }).error);
      }
    } catch {
      /* not JSON */
    }
    throw Object.assign(new Error(message), { detail });
  }
  return res.json() as Promise<T>;
}

export type TrackerSummary = {
  id: string;
  label: string;
  createdAt: string;
  scenarioLabel: string;
  startDate: string;
  parentId?: string;
  planSince: string;
  months: number;
};

export type OpeningSummary = {
  date: string;
  offset: number;
  homeLoan: number;
  investmentLoan: number;
  superYou: number;
  superSpouse: number;
  shares: number;
  deployable: number;
};

export const listTrackers = () => send<TrackerSummary[]>("GET", "/api/trackers");
export const fetchTracker = (id: string) =>
  send<TrackerView>("GET", `/api/trackers/${id}`);
export const createTracker = (body: {
  household: Household;
  allocation: Allocation;
  scenarioLabel: string;
  label: string;
  startDate: string;
}) => send<TrackerView>("POST", "/api/trackers", body);
export const setTrackerRisu = (id: string, portfolios: number[]) =>
  send<TrackerView>("PUT", `/api/trackers/${id}/risu`, { portfolios });
export const deleteTracker = (id: string) =>
  send<{ ok: true }>("DELETE", `/api/trackers/${id}`);
export const fetchOpening = (id: string, at: string) =>
  send<OpeningSummary>("GET", `/api/trackers/${id}/opening?at=${at}`);
export const replanPreview = (id: string, at: string, deploy: number) =>
  send<RunReport>("POST", `/api/trackers/${id}/replan/preview`, { at, deploy });
export const replan = (
  id: string,
  body: { at: string; deploy: number; allocation: Allocation; scenarioLabel: string; label: string },
) => send<TrackerView>("POST", `/api/trackers/${id}/replan`, body);

export const saveActual = (month: string, entry: Omit<ActualMonth, "date">) =>
  send<ActualMonth | null>("PUT", `/api/actuals/${month}`, entry);
export const clearActual = (month: string) =>
  send<{ ok: true }>("DELETE", `/api/actuals/${month}`);
export const pullRisu = (month: string) =>
  send<{ entry: ActualMonth; warnings: string[] }>("POST", `/api/actuals/${month}/risu`);

export type RisuLinkState = RisuLink & { configured: boolean; url: string | null };
export type RisuTicker = {
  key: string;
  ticker: string;
  portfolios: number[];
  sleeve: "growth" | "income" | null;
};

export const fetchRisuLink = () => send<RisuLinkState>("GET", "/api/risu/link");
export const saveRisuLink = (link: RisuLink) =>
  send<RisuLink>("PUT", "/api/risu/link", link);
export const fetchRisuPortfolios = () =>
  send<{ id: number; name: string }[]>("GET", "/api/risu/portfolios");
export const fetchRisuTickers = () => send<RisuTicker[]>("GET", "/api/risu/tickers");
