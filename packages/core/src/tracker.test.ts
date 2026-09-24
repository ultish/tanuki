import { describe, expect, it } from "vitest";
import { defaultAssumptions, defaultHousehold, defaultPerson } from "./defaults.js";
import { simulate } from "./engine.js";
import { mapRisuMonth, type RisuLink } from "./risu.js";
import { pmt } from "./loan.js";
import { incomeTax } from "./tax.js";
import {
  createReplan,
  createTracker,
  openingAt,
  replanPreview,
  viewTracker,
  type Tracker,
} from "./tracker.js";
import type { ActualMonth, Assumptions, Household, ScenarioDef } from "./types.js";

const flat = {
  growthRate: 0,
  yieldRate: 0,
  mer: 0,
  frankingPercent: 0,
};

/**
 * 0% markets, 0% loan, no sweep, no pay: net wealth is just where the
 * dollars sit, and nothing flows through the cash pool into the offset.
 */
function still(
  h: Omit<Partial<Household>, "assumptions"> & { assumptions?: Partial<Assumptions> } = {},
): Household {
  return defaultHousehold({
    lumpSum: 250_000,
    you: defaultPerson("you", { taxableIncome: 0 }),
    spouse: defaultPerson("spouse", { taxableIncome: 0 }),
    loan: {
      balance: 650_000,
      offset: 80_000,
      annualRate: 0,
      remainingYears: 25,
      interestOnly: true,
    },
    ...h,
    assumptions: defaultAssumptions({
      startDate: "2026-09-01",
      horizonYears: 3,
      inflationRate: 0,
      superReturnRate: 0,
      sweepIdleOffset: false,
      growthAsset: { label: "g", ...flat, reinvestDividends: true },
      incomeAsset: { label: "i", ...flat, reinvestDividends: false },
      ...h.assumptions,
    }),
  });
}

function def(allocation: ScenarioDef["allocation"]): ScenarioDef {
  return { id: "t", label: "t", summary: "", group: "custom", allocation };
}

function track(h: Household, allocation: ScenarioDef["allocation"]): Tracker {
  return createTracker({
    id: "t1",
    createdAt: "2026-08-20T00:00:00Z",
    label: "Plan A",
    scenarioLabel: "Growth, your name",
    allocation,
    startDate: "2026-09-14",
    household: h,
  });
}

describe("dated pay events", () => {
  it("steps employer SG up from the month of the rise, not the plan anniversary", () => {
    const h = still({
      you: defaultPerson("you", {
        taxableIncome: 100_000,
        salary: 100_000,
        sgRatePercent: 12,
        employerSgThisFy: 12_000,
        extraConcessionalThisFy: 0,
        payEvents: [{ from: "2027-03-01", taxableIncome: 150_000, salary: 150_000 }],
      }),
      assumptions: { horizonYears: 1 },
    });
    const r = simulate(h, def({ offset: 250_000 })).result;
    // Sep–Feb at $1,000/month SG, Mar–Aug at $1,500, less 15% contributions tax.
    expect(r.superYou).toBeCloseTo(280_000 + 0.85 * (6 * 1_000 + 6 * 1_500), 2);
  });

  it("scales SG with taxable income when the event leaves salary out", () => {
    const h = still({
      you: defaultPerson("you", {
        taxableIncome: 100_000,
        salary: 100_000,
        sgRatePercent: 12,
        extraConcessionalThisFy: 0,
        payEvents: [{ from: "2027-03-01", taxableIncome: 150_000 }],
      }),
      assumptions: { horizonYears: 1 },
    });
    const r = simulate(h, def({ offset: 250_000 })).result;
    expect(r.superYou).toBeCloseTo(280_000 + 0.85 * 15_000, 2);
  });
});

describe("dated rate events", () => {
  it("charges the new rate from the month it takes effect", () => {
    const h = still({
      loan: {
        balance: 650_000,
        offset: 80_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
        rateEvents: [{ from: "2027-01-01", annualRate: 0.06 }],
      },
      assumptions: { horizonYears: 1 },
    });
    const r = simulate(h, def({ offset: 250_000 })).result;
    const interest = Object.fromEntries(r.months.map((m) => [m.date.slice(0, 7), m.homeInterest]));
    expect(interest["2026-12"]).toBe(0);
    // 650k owing, 330k offset → 320k at 6%/12.
    expect(interest["2027-01"]).toBe(1_600);
  });

  it("re-amortises P&I over the remaining term, so the loan still ends on time", () => {
    const h = still({
      lumpSum: 0,
      loan: {
        balance: 600_000,
        offset: 0,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: false,
        rateEvents: [{ from: "2031-09-01", annualRate: 0.06 }],
      },
      assumptions: { horizonYears: 25 },
    });
    const r = simulate(h, def({})).result;
    const before = r.months.find((m) => m.date.startsWith("2031-08"))!;
    const first = r.months.find((m) => m.date.startsWith("2031-09"))!;
    // 60 months of $2,000 principal at 0%, then a new payment over 240 months.
    expect(before.homeLoan).toBe(480_000);
    expect(first.homeInterest).toBe(2_400);
    expect(first.homeLoan).toBeCloseTo(480_000 - (pmt(480_000, 0.06, 20) - 2_400), 2);
    expect(r.homeLoan).toBeCloseTo(0, 2);
  });
});

describe("expense inflation", () => {
  it("grows living costs and the holiday each plan year", () => {
    const h = still({
      assumptions: {
        horizonYears: 2,
        monthlyExpenses: 1_000,
        annualHolidaySpend: 1_200,
        holidayMonth: 12,
        expenseInflationRate: 0.1,
      },
    });
    const r = simulate(h, def({ offset: 250_000 })).result;
    // Year one (Sep 26–Aug 27): 12 × $1,000 + a $1,200 December trip.
    // Year two: everything 10% dearer.
    expect(r.offset).toBeCloseTo(330_000 - (12_000 + 1_200) - (13_200 + 1_320), 2);
  });

  it("at 0% changes nothing", () => {
    const flat = still({ assumptions: { horizonYears: 2, monthlyExpenses: 1_000 } });
    const r = simulate(flat, def({ offset: 250_000 })).result;
    expect(r.offset).toBeCloseTo(330_000 - 24_000, 2);
  });
});

describe("later novated leases", () => {
  it("lowers taxable income for the months the new lease runs", () => {
    const h = still({
      you: defaultPerson("you", {
        taxableIncome: 100_000,
        laterLeases: [{ from: "2027-03-01", to: "2028-03-01", fortnightly: 500 }],
      }),
      assumptions: { horizonYears: 2 },
    });
    const r = simulate(h, def({ offset: 250_000 })).result;
    // Six of the lease's months fall in each plan year: $13,000 a year × 6/12.
    const pay = (income: number) => (income - incomeTax(income, 0.02)) / 12;
    expect(r.months[0]!.afterTaxPay).toBeCloseTo(pay(100_000 - 6_500), 2);
    expect(r.months[12]!.afterTaxPay).toBeCloseTo(pay(100_000 - 6_500), 2);
  });
});

describe("opening position", () => {
  it("carrying on from a closing position is the same as one continuous run", () => {
    // Real markets, real rates, the cash pool, a split between July
    // settlements with tax accrued but unpaid: every carried field matters.
    // Split on a plan-year boundary, where the engine's own years turn over.
    const h = defaultHousehold({
      assumptions: defaultAssumptions({ startDate: "2026-09-01", horizonYears: 2 }),
    });
    const allocation = { taxable_spouse_growth: 100_000, debt_recycle_you_growth: 150_000 };
    const whole = simulate(h, def(allocation)).result;

    const firstYear = simulate(
      { ...h, assumptions: { ...h.assumptions, horizonYears: 1 } },
      def(allocation),
      { midStream: true },
    );
    const rest = simulate(
      {
        ...h,
        lumpSum: 0,
        assumptions: { ...h.assumptions, startDate: firstYear.closing.date, horizonYears: 1 },
      },
      def({}),
      { opening: firstYear.closing },
    ).result;

    expect(firstYear.closing.date).toBe("2027-09-01");
    expect(rest.netWealth).toBeCloseTo(whole.netWealth, 2);
    expect(rest.exitCgt).toBeCloseTo(whole.exitCgt, 2);
    expect(rest.months.at(-1)!.offset).toBeCloseTo(whole.months.at(-1)!.offset, 2);
    expect(firstYear.closing.taxAccrual).not.toBe(0);
  });
});

describe("tracker", () => {
  const plan = { taxable_you_growth: 250_000 };

  it("starts on the first of the chosen month and projects from there", () => {
    const t = track(still(), plan);
    expect(t.startDate).toBe("2026-09-01");
    expect(t.baseline.household.assumptions.startDate).toBe("2026-09-01");
    expect(t.baseline.months[0]!.date).toBe("2026-09-01");
    expect(t.baseline.months).toHaveLength(36);
    expect(t.baseline.allocation).toEqual({ taxable_you_growth: 250_000 });
  });

  it("with nothing logged, the re-forecast is the plan", () => {
    const h = still();
    const v = viewTracker(track(h, plan), h, [
      { date: "2026-10", confirmed: true },
    ]);
    expect(v.lastLogged).toBe("2026-10");
    expect(v.months[35]!.reforecast.netWealth).toBe(v.months[35]!.plan.netWealth);
    expect(v.end.reforecast).toEqual(v.end.plan);
  });

  it("a smaller logged buy leaves the rest in the offset", () => {
    const h = still();
    const v = viewTracker(track(h, plan), h, [
      { date: "2026-09", confirmed: true, flows: { taxable_you_growth: 200_000 } },
    ]);
    const m1 = v.months[0]!.reforecast;
    expect(m1.shares.you_growth).toBe(200_000);
    expect(m1.offset).toBe(80_000 + 50_000);
    expect(m1.flows.taxable_you_growth).toBe(200_000);
    expect(m1.netWealth).toBe(v.months[0]!.plan.netWealth);
  });

  it("a typed share balance is the market moving: it carries forward, cost stays", () => {
    const h = still();
    const t = track(h, plan);
    const v = viewTracker(t, h, [
      { date: "2026-11", confirmed: true, balances: { shares: { you_growth: 230_000 } } },
    ]);
    expect(v.months[2]!.reforecast.shares.you_growth).toBe(230_000);
    expect(v.months[35]!.reforecast.shares.you_growth).toBe(230_000);
    expect(v.end.reforecast.netWealth).toBe(v.end.plan.netWealth - 20_000);
    // Sold at a $20k loss against the original $250k cost: no CGT.
    expect(v.end.reforecast.netIfLiquidated).toBe(v.end.reforecast.netWealth);
  });

  it("a negative flow is a sell into the offset", () => {
    const h = still();
    const v = viewTracker(track(h, plan), h, [
      { date: "2027-01", confirmed: true, flows: { taxable_you_growth: -50_000 } },
    ]);
    const jan = v.months[4]!.reforecast;
    expect(jan.shares.you_growth).toBe(200_000);
    expect(jan.offset).toBe(80_000 + 50_000);
    expect(jan.invested).toBe(-50_000);
    expect(jan.netWealth).toBe(v.months[4]!.plan.netWealth);
  });

  it("typed loan and offset balances win", () => {
    const h = still();
    const v = viewTracker(track(h, plan), h, [
      { date: "2026-10", confirmed: true, balances: { offset: 90_000, homeLoan: 640_000 } },
    ]);
    expect(v.months[1]!.reforecast.offset).toBe(90_000);
    expect(v.months[1]!.reforecast.homeLoan).toBe(640_000);
  });

  const link: RisuLink = {
    portfolios: [
      { id: 1, personId: "you", purpose: "taxable" },
      { id: 2, personId: "spouse", purpose: "taxable" },
    ],
    tickers: {},
  };
  const risuMonth: ActualMonth["risu"] = {
    pulledAt: "2026-10-01T00:00:00Z",
    lots: [
      { portfolioId: 1, personId: "you", purpose: "taxable", sleeve: "growth", ticker: "OLD", cost: 40_000, value: 55_000, acquiredDate: "2024-01-10", valueAtCutover: null },
      { portfolioId: 1, personId: "you", purpose: "taxable", sleeve: "growth", ticker: "VGS", cost: 180_000, value: 183_000, acquiredDate: "2026-09-10", valueAtCutover: null },
      { portfolioId: 2, personId: "spouse", purpose: "taxable", sleeve: "growth", ticker: "VGS", cost: 9_000, value: 9_500, acquiredDate: "2026-09-11", valueAtCutover: null },
    ],
    trades: [
      { portfolioId: 1, bucket: "taxable_you_growth", ticker: "VGS", date: "2026-09-10", amount: 180_000 },
      { portfolioId: 1, bucket: "taxable_you_growth", ticker: "OLD", date: "2026-09-12", acquiredDate: "2024-01-10", amount: -5_000 },
      { portfolioId: 2, bucket: "taxable_spouse_growth", ticker: "VGS", date: "2026-09-11", amount: 9_000 },
    ],
  };
  const withRisu = (portfolios: number[]) => ({ ...track(still(), plan), risuPortfolios: portfolios });

  it("risu parcels replace the share position; pre-plan parcels and their sells are left out", () => {
    const h = still();
    const v = viewTracker(withRisu([1]), h, [{ date: "2026-09", confirmed: true, risu: risuMonth }], link);
    const m1 = v.months[0]!.reforecast;
    expect(m1.shares.you_growth).toBe(183_000);
    expect(m1.offset).toBe(80_000 + 70_000);
    expect(m1.invested).toBe(180_000);
    // The spouse's portfolio isn't tracked by this plan, so their buy doesn't count.
    expect(m1.shares.spouse_growth).toBe(0);
  });

  it("a plan tracking both portfolios counts both people's parcels", () => {
    const v = viewTracker(withRisu([1, 2]), still(), [{ date: "2026-09", confirmed: true, risu: risuMonth }], link);
    const m1 = v.months[0]!.reforecast;
    expect(m1.shares.you_growth).toBe(183_000);
    expect(m1.shares.spouse_growth).toBe(9_500);
    expect(m1.offset).toBe(80_000 + 70_000 - 9_000);
  });

  it("a plan tracking no portfolios ignores risu and follows the projection", () => {
    const h = still();
    const t = withRisu([]);
    const v = viewTracker(t, h, [{ date: "2026-09", confirmed: false, risu: risuMonth }], link);
    expect(v.lastLogged).toBeNull();
    expect(v.months[0]!.actual).toBeUndefined();
    expect(v.months[0]!.reforecast.shares.you_growth).toBe(250_000);
  });

  it("the at-today's-rates line picks up a rate change recorded after the plan was accepted", () => {
    const accepted = still({
      loan: { balance: 650_000, offset: 80_000, annualRate: 0.05, remainingYears: 25, interestOnly: true },
    });
    const t = track(accepted, plan);
    const now: Household = {
      ...accepted,
      loan: { ...accepted.loan, rateEvents: [{ from: "2027-01-01", annualRate: 0.07 }] },
    };
    const v = viewTracker(t, now, []);
    const jan = v.months[4]!;
    // Interest-only interest is paid out of the offset each month, so charge
    // it on what the offset held going into January.
    expect(jan.plan.homeInterest).toBeCloseTo((650_000 - jan.plan.offsetOpening) * 0.05 / 12, 0);
    expect(jan.todaysRates.homeInterest).toBeCloseTo(
      (650_000 - jan.todaysRates.offsetOpening) * 0.07 / 12,
      0,
    );
    expect(jan.reforecast.homeInterest).toBe(jan.todaysRates.homeInterest);
  });
});

describe("re-plan", () => {
  it("starts where the log says you are and places the new lump from the offset", () => {
    const h = still();
    const parent = track(h, { taxable_you_growth: 250_000 });
    const log: ActualMonth[] = [
      { date: "2027-02", confirmed: true, balances: { offset: 120_000 } },
    ];
    const opening = openingAt(parent, h, log, "2027-09");
    expect(opening.date).toBe("2027-09-01");
    expect(opening.offset).toBe(120_000);

    const child = createReplan({
      id: "t2",
      createdAt: "2027-08-30T00:00:00Z",
      label: "Plan B",
      scenarioLabel: "Spouse growth",
      allocation: { taxable_spouse_growth: 30_000 },
      parent,
      current: h,
      log,
      at: "2027-09",
      deploy: 30_000,
    });
    expect(child.parentId).toBe("t1");
    expect(child.startDate).toBe("2027-09-01");
    expect(child.planSince).toBe("2026-09-01");
    const m1 = child.baseline.months[0]!;
    expect(m1.date).toBe("2027-09-01");
    expect(m1.shares.spouse_growth).toBe(30_000);
    expect(m1.shares.you_growth).toBe(250_000);
    expect(m1.offset).toBe(90_000);
    // At 0% everything, moving money doesn't change net wealth.
    const parentView = viewTracker(parent, h, log);
    expect(m1.netWealth).toBe(parentView.months[12]!.reforecast.netWealth);
  });

  it("with nothing to place, offers carrying on from here", () => {
    const h = still();
    const parent = track(h, { taxable_you_growth: 250_000 });
    const r = replanPreview(parent, h, [], "2027-09", 0);
    expect(r.results.map((x) => x.label)).toContain("Carry on from here");
  });

  it("won't deploy more than the offset above the restricted floor", () => {
    const h = still({
      loan: { balance: 650_000, offset: 80_000, annualRate: 0, remainingYears: 25, interestOnly: true, restrictedOffset: 60_000 },
    });
    const parent = track(h, { taxable_you_growth: 250_000 });
    expect(() =>
      createReplan({
        id: "t2", createdAt: "", label: "", scenarioLabel: "", allocation: {},
        parent, current: h, log: [], at: "2027-09", deploy: 30_000,
      }),
    ).toThrow("Can only deploy up to $20,000");
  });
});

describe("risu mapping", () => {
  const link: RisuLink = {
    portfolios: [
      { id: 1, personId: "you", purpose: "taxable" },
      { id: 2, personId: "you", purpose: "debt_recycle" },
      { id: 3, personId: "spouse", purpose: "taxable" },
    ],
    tickers: { "ASX:VGS": "growth", "ASX:VHY": "income" },
  };
  const empty = { asOf: "2029-03-31", since: "2029-03-01", lots: [], buys: [], disposals: [] };

  it("maps portfolios and tickers onto buckets, and lists unmapped tickers", () => {
    const out = mapRisuMonth(link, [
      { portfolioId: 2, data: { ...empty, buys: [{ ticker: "VGS", exchange: "ASX", date: "2029-03-05", costAud: 10_000 }] } },
      { portfolioId: 3, data: { ...empty, disposals: [{ ticker: "VHY", exchange: "ASX", acquiredDate: "2027-01-01", disposedDate: "2029-03-20", proceedsAud: 4_000 }] } },
      { portfolioId: 1, data: { ...empty, lots: [{ ticker: "TSLA", exchange: "US", acquiredDate: "2028-01-01", quantity: 3, costBaseAud: 1_500, marketValueAud: 1_800, valueAtCutoverAud: null }] } },
    ]);
    expect(out.trades).toEqual([
      { portfolioId: 2, bucket: "debt_recycle_you_growth", ticker: "VGS", date: "2029-03-05", amount: 10_000 },
      { portfolioId: 3, bucket: "taxable_spouse_income", ticker: "VHY", date: "2029-03-20", acquiredDate: "2027-01-01", amount: -4_000 },
    ]);
    expect(out.unmapped).toEqual(["US:TSLA"]);
    expect(out.lots).toEqual([]);
  });
});
