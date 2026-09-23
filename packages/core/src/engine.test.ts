import { describe, expect, it } from "vitest";
import { concessionalRoom, nccRoom } from "./caps.js";
import {
  defaultAssumptions,
  defaultHousehold,
  defaultPerson,
  mergeHousehold,
} from "./defaults.js";
import { allocationSum, applyCaps, runHousehold, runScenario } from "./engine.js";
import { buildPresets } from "./presets.js";
import { buildStacks } from "./stacks.js";
import {
  combinedMarginalRate,
  division293Tax,
  estimateHybridCgt,
  incomeTax,
  lastDollarPit,
  monthlyRate,
  taxDelta,
} from "./tax.js";
import type { Assumptions, Household, ScenarioDef } from "./types.js";

const zeroMarket = defaultAssumptions({
  startDate: "2026-09-01",
  horizonYears: 10,
  inflationRate: 0,
  superReturnRate: 0,
  growthAsset: {
    label: "flat",
    growthRate: 0,
    yieldRate: 0,
    mer: 0,
    frankingPercent: 0,
    reinvestDividends: true,
  },
  incomeAsset: {
    label: "flat-inc",
    growthRate: 0,
    yieldRate: 0,
    mer: 0,
    frankingPercent: 0,
    reinvestDividends: false,
  },
});

function hush(h: Partial<Household> = {}): Household {
  return defaultHousehold({
    assumptions: zeroMarket,
    loan: {
      balance: 650_000,
      offset: 80_000,
      annualRate: 0,
      remainingYears: 25,
      interestOnly: false,
    },
    ...h,
  });
}

function def(
  id: string,
  allocation: ScenarioDef["allocation"],
): ScenarioDef {
  return {
    id,
    label: id,
    summary: id,
    group: "custom",
    allocation,
  };
}

describe("concessional room", () => {
  it("subtracts employer SG and extra concessional from the cap", () => {
    const h = hush({
      you: defaultPerson("you", {
        salary: 20_000 / 0.12,
        sgRatePercent: 12,
        extraConcessionalFortnightly: 5_000 / 26,
      }),
    });
    expect(h.you.employerSgThisFy).toBeCloseTo(20_000, 2);
    expect(h.you.extraConcessionalThisFy).toBeCloseTo(5_000, 2);
    expect(concessionalRoom(h.you, h.assumptions)).toBe(7_500);
    const row = buildPresets(h).find((p) => p.id === "cc-you-spouse-growth");
    expect(row?.allocation.super_cc_you).toBe(7_500);
  });

  it("maps old employerSgThisFy/extraConcessionalThisFy onto salary/fortnightly", () => {
    const h = mergeHousehold(defaultHousehold(), {
      you: { employerSgThisFy: 24_000, extraConcessionalThisFy: 12_000 },
    } as Partial<Household>);
    // 12% default SG rate backed out into a salary, and the annual figure
    // split back into a fortnightly amount — both round-trip to within a
    // cent, not exactly, since the fortnightly figure is stored rounded.
    expect(h.you.salary).toBeCloseTo(200_000, 0);
    expect(h.you.employerSgThisFy).toBeCloseTo(24_000, 0);
    expect(h.you.extraConcessionalThisFy).toBeCloseTo(12_000, 0);
  });

  it("maps old concessionalUsedThisFy onto extra concessional", () => {
    const h = mergeHousehold(defaultHousehold(), {
      you: { concessionalUsedThisFy: 12_000 },
    } as Partial<Household>);
    expect(h.you.extraConcessionalThisFy).toBeCloseTo(12_000, 0);
    expect(h.you.employerSgThisFy).toBe(0);
    expect(
      (h.you as { concessionalUsedThisFy?: number }).concessionalUsedThisFy,
    ).toBeUndefined();
  });
});

describe("concessional vs offset at 0% markets", () => {
  it("your CC beats parking the same dollars in the offset by (MTR − 15%)", () => {
    const h = hush();
    const cap = concessionalRoom(h.you, h.assumptions);
    const offset = runScenario(h, def("o", { offset: h.lumpSum }));
    const cc = runScenario(
      h,
      def("cc", { super_cc_you: cap, offset: h.lumpSum - cap }),
    );
    const div293 = division293Tax(
      h.you.taxableIncome,
      h.you.employerSgThisFy +
        h.you.extraConcessionalThisFy +
        cap,
      h.assumptions.div293Threshold,
    );
    const saving = -taxDelta(
      h.you.taxableIncome,
      -cap,
      h.you.medicareLevy,
    );
    const expected = saving - cap * 0.15 - div293;
    expect(cc.netWealth - offset.netWealth).toBeCloseTo(expected, 0);
  });

  it("your CC beats spouse CC because 47% > 32%", () => {
    const h = hush();
    const cap = Math.min(
      concessionalRoom(h.you, h.assumptions),
      concessionalRoom(h.spouse, h.assumptions),
    );
    const you = runScenario(
      h,
      def("you", { super_cc_you: cap, offset: h.lumpSum - cap }),
    );
    const spouse = runScenario(
      h,
      def("sp", { super_cc_spouse: cap, offset: h.lumpSum - cap }),
    );
    expect(you.netWealth).toBeGreaterThan(spouse.netWealth);
    const div293 = division293Tax(
      h.you.taxableIncome,
      h.you.employerSgThisFy +
        h.you.extraConcessionalThisFy +
        cap,
      h.assumptions.div293Threshold,
    );
    const youSave = -taxDelta(
      h.you.taxableIncome,
      -cap,
      h.you.medicareLevy,
    );
    const spSave = -taxDelta(
      h.spouse.taxableIncome,
      -cap,
      h.spouse.medicareLevy,
    );
    const gap = youSave - spSave - div293;
    expect(you.netWealth - spouse.netWealth).toBeCloseTo(gap, 0);
  });
});

describe("day-one identity (0% rates)", () => {
  it("debt recycle pays the home down then redraws, it does not stuff the offset", () => {
    const h = hush({
      loan: {
        balance: 400_000,
        offset: 80_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
      // Idle-offset sweep is covered separately below; keep it off here so
      // it doesn't disturb the debt-recycle mechanics this test is about.
      assumptions: defaultAssumptions({ ...zeroMarket, sweepIdleOffset: false }),
    });
    const r = runScenario(h, def("r", { debt_recycle_you_growth: 250_000 }));
    // Day one, before any pay has flowed through the cash pool — the redraw
    // itself must not touch the offset.
    const day0 = r.years[0]!;
    expect(day0.homeLoan).toBeCloseTo(150_000, 0);
    expect(day0.offset).toBeCloseTo(80_000, 0);
    expect(day0.investmentLoan).toBeCloseTo(250_000, 0);
    expect(r.taxableYou).toBeCloseTo(250_000, 0);
  });

  it("offset, taxable, and debt-recycle match net wealth", () => {
    const h = hush();
    const a = runScenario(h, def("off", { offset: h.lumpSum }));
    const b = runScenario(h, def("tax", { taxable_you_growth: h.lumpSum }));
    const c = runScenario(h, def("rec", { debt_recycle_you_growth: h.lumpSum }));
    expect(a.netWealth).toBeCloseTo(b.netWealth, 0);
    expect(b.netWealth).toBeCloseTo(c.netWealth, 0);
  });

  it("offset and extra-repay match net wealth and net debt", () => {
    // Sweep off — with it on, both scenarios sweep their offset down to the
    // same restricted floor regardless of the (different) loan balances
    // left behind, which is a separate thing to test, not what this checks.
    const h = hush({
      assumptions: defaultAssumptions({ ...zeroMarket, sweepIdleOffset: false }),
    });
    const a = runScenario(h, def("off", { offset: h.lumpSum }));
    const b = runScenario(h, def("pay", { extra_repay: h.lumpSum }));
    expect(a.netWealth).toBeCloseTo(b.netWealth, 0);
    expect(a.netDebt).toBeCloseTo(b.netDebt, 0);
  });

  it("offset and extra-repay still match after the loan is paid off", () => {
    const h = hush({
      lumpSum: 200_000,
      loan: {
        balance: 100_000,
        offset: 0,
        annualRate: 0,
        remainingYears: 2,
        interestOnly: false,
      },
      assumptions: defaultAssumptions({
        ...zeroMarket,
        horizonYears: 5,
      }),
    });
    const a = runScenario(h, def("off", { offset: h.lumpSum }));
    const b = runScenario(h, def("pay", { extra_repay: h.lumpSum }));
    expect(a.netWealth).toBeCloseTo(b.netWealth, 0);
    expect(b.homeLoan).toBe(0);
  });
});

describe("debt recycle deduction", () => {
  it("costs the after-tax interest rate when the loan rate is positive and assets are flat", () => {
    const h = hush({
      loan: {
        balance: 650_000,
        offset: 80_000,
        annualRate: 0.06,
        remainingYears: 25,
        interestOnly: true,
      },
      assumptions: defaultAssumptions({
        ...zeroMarket,
        investmentLoanRate: 0.06,
      }),
    });
    const invest = runScenario(h, def("t", { taxable_you_growth: h.lumpSum }));
    const recycle = runScenario(
      h,
      def("r", { debt_recycle_you_growth: h.lumpSum }),
    );
    // Recycling locks a quarter-million of debt outside the offset: the
    // split can't be offset the way the home loan can, so once cash piles
    // up the un-recycled household gets to kill all its interest and the
    // recycled one is still paying 6% on the split. The deduction softens
    // that but never covers it, because the ATO refunds at most your
    // marginal rate, never the whole dollar.
    expect(recycle.netWealth).toBeLessThan(invest.netWealth);
    const gap = invest.netWealth - recycle.netWealth;
    // The gap is the after-tax cost of the interest the offset can no longer
    // reach — well short of the raw interest, and nowhere near zero.
    const rawInterest = recycle.totalInvestmentInterest;
    expect(gap).toBeLessThan(rawInterest);
    expect(gap).toBeGreaterThan(rawInterest * (1 - combinedMarginalRate(h.you)) * 0.5);
  });

  it("charges home-loan interest against net wealth, the same as investment-loan interest", () => {
    // Regression: home-loan interest used to be computed and then dropped,
    // so an interest-only home loan cost the household nothing in the model
    // while the investment split cost full freight — which quietly made
    // debt recycling look worse than it is.
    const build = (annualRate: number) =>
      hush({
        loan: {
          balance: 400_000,
          offset: 0,
          annualRate,
          remainingYears: 25,
          interestOnly: true,
        },
        assumptions: defaultAssumptions({
          ...zeroMarket,
          sweepIdleOffset: false,
          horizonYears: 1,
        }),
      });
    const free = runScenario(build(0), def("o", {}));
    const costly = runScenario(build(0.06), def("o", {}));
    expect(costly.totalHomeInterest).toBeGreaterThan(0);
    expect(free.netWealth - costly.netWealth).toBeCloseTo(
      costly.totalHomeInterest,
      0,
    );
  });

  it("re-amortises the home repayment over what's left after the split", () => {
    const h = hush({
      loan: {
        balance: 400_000,
        offset: 0,
        annualRate: 0.06,
        remainingYears: 25,
        interestOnly: false,
      },
      assumptions: defaultAssumptions({ ...zeroMarket, sweepIdleOffset: false }),
    });
    const plain = runScenario(h, def("o", { offset: h.lumpSum }));
    const recycle = runScenario(h, def("r", { debt_recycle_you_growth: 100_000 }));
    const full = plain.months[0]!.homeLoanPayment;
    // A quarter of the loan moved to the split, so the home repayment is a
    // quarter smaller — the bank sizes each facility to its own balance.
    expect(recycle.months[0]!.homeLoanPayment).toBeCloseTo(full * 0.75, 0);
  });

  it("leaves the repayment alone for an extra repayment, finishing the loan early", () => {
    const h = hush({
      loan: {
        balance: 400_000,
        offset: 0,
        annualRate: 0.06,
        remainingYears: 25,
        interestOnly: false,
      },
      assumptions: defaultAssumptions({ ...zeroMarket, sweepIdleOffset: false }),
    });
    const plain = runScenario(h, def("o", { offset: h.lumpSum }));
    const repaid = runScenario(h, def("p", { extra_repay: 100_000 }));
    // Paying a lump off doesn't recast the loan — same payment, shorter term.
    expect(repaid.months[0]!.homeLoanPayment).toBeCloseTo(
      plain.months[0]!.homeLoanPayment,
      0,
    );
    expect(repaid.homeLoan).toBeLessThan(plain.homeLoan);
  });

  it("values the interest deduction on the tax scale, not a flat 47%", () => {
    const h = hush({
      you: defaultPerson("you", {
        taxableIncome: 193_000,
        marginalRate: 0.45,
      }),
      loan: {
        balance: 650_000,
        offset: 80_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
      assumptions: defaultAssumptions({
        ...zeroMarket,
        investmentLoanRate: 0.06,
      }),
    });
    const invest = runScenario(h, def("t", { taxable_you_growth: h.lumpSum }));
    const recycle = runScenario(
      h,
      def("r", { debt_recycle_you_growth: h.lumpSum }),
    );
    const yearlyInterest = h.lumpSum * 0.06;
    const yearlySave = -taxDelta(193_000, -yearlyInterest, 0.02);
    const yearlyNetCost = yearlyInterest - yearlySave;
    const gap = invest.netWealth - recycle.netWealth;
    expect(gap).toBeCloseTo(yearlyNetCost * 10, 0);
    // The save is on the progressive scale, not a flat 47c in the dollar —
    // so it recovers less than 47% of the raw interest, leaving a bigger
    // net cost than a flat-rate refund would.
    expect(yearlySave).toBeLessThan(yearlyInterest * 0.47);
  });
});

describe("taxable name split", () => {
  it("income in the spouse’s name beats income in yours", () => {
    const a = defaultAssumptions({
      startDate: "2026-09-01",
      horizonYears: 10,
      growthAsset: zeroMarket.growthAsset,
      incomeAsset: {
        label: "yield",
        growthRate: 0,
        yieldRate: 0.05,
        mer: 0,
        frankingPercent: 0,
        reinvestDividends: false,
      },
      superReturnRate: 0,
      inflationRate: 0,
    });
    const h = defaultHousehold({
      assumptions: a,
      loan: {
        balance: 0,
        offset: 0,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
    });
    const you = runScenario(h, def("y", { taxable_you_income: h.lumpSum }));
    const spouse = runScenario(
      h,
      def("s", { taxable_spouse_income: h.lumpSum }),
    );
    expect(spouse.netWealth).toBeGreaterThan(you.netWealth);
    expect(spouse.totalIncomeTax).toBeLessThan(you.totalIncomeTax);
  });

  it("tax on investments if sold is yield tax plus CGT, not the loan deduction", () => {
    const h = hush({
      loan: {
        balance: 650_000,
        offset: 80_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
      assumptions: defaultAssumptions({
        ...zeroMarket,
        investmentLoanRate: 0.06,
        // Off so swept offset cash doesn't inflate investmentOutsideSuper —
        // this test is about the recycled amount specifically.
        sweepIdleOffset: false,
        incomeAsset: {
          label: "yield",
          growthRate: 0,
          yieldRate: 0.05,
          mer: 0,
          frankingPercent: 0,
          reinvestDividends: false,
        },
      }),
    });
    const recycle = runScenario(
      h,
      def("r", { debt_recycle_you_income: h.lumpSum }),
    );
    expect(recycle.investmentOutsideSuper).toBeCloseTo(h.lumpSum, 0);
    expect(recycle.investmentTaxIfSold).toBeCloseTo(
      recycle.investmentIncomeTax + recycle.exitCgt,
      5,
    );
    expect(recycle.totalIncomeTax).toBeLessThan(recycle.investmentIncomeTax);
    const yearCash = h.lumpSum * monthlyRate(0.05) * 12;
    const yearlyYieldTax = taxDelta(
      h.you.taxableIncome,
      yearCash,
      h.you.medicareLevy,
    );
    expect(recycle.investmentIncomeTax).toBeCloseTo(yearlyYieldTax * 10, 0);
  });
});

describe("caps", () => {
  it("clamps concessional over the cap into offset", () => {
    const h = hush();
    const r = runScenario(h, def("x", { super_cc_you: 1_000_000 }));
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.appliedAllocation.super_cc_you).toBe(
      concessionalRoom(h.you, h.assumptions),
    );
    expect(r.appliedAllocation.offset ?? 0).toBeGreaterThan(0);
  });
});

describe("presets + ranking", () => {
  it("builds a household playbook and ranks by liquidated wealth", () => {
    const h = defaultHousehold({
      assumptions: defaultAssumptions({ startDate: "2026-09-01" }),
    });
    const presets = buildPresets(h);
    expect(presets.some((p) => p.id === "offset")).toBe(true);
    expect(presets.some((p) => p.id === "recycle-growth")).toBe(true);
    expect(presets.some((p) => p.id === "cc-you-offset")).toBe(true);
    const report = runHousehold(h);
    expect(report.results.length).toBeGreaterThanOrEqual(presets.length);
    expect(report.results.length).toBeLessThan(presets.length + 20);
    for (let i = 1; i < report.results.length; i++) {
      expect(report.results[i - 1]!.netIfLiquidated).toBeGreaterThanOrEqual(
        report.results[i]!.netIfLiquidated,
      );
    }
  });

  it("tries stacked leftovers and keeps a recycle-plus-super winner", () => {
    const h = defaultHousehold({
      assumptions: defaultAssumptions({ startDate: "2026-09-01" }),
    });
    const searched = buildStacks(h);
    expect(
      searched.some(
        (s) =>
          (s.allocation.super_cc_you ?? 0) > 0 &&
          (s.allocation.super_cc_spouse ?? 0) > 0 &&
          (s.allocation.debt_recycle_you_growth ?? 0) > 0,
      ),
    ).toBe(true);
    const report = runHousehold(h);
    const stacks = report.results.filter((r) => r.id.startsWith("stack:"));
    expect(stacks.length).toBeGreaterThan(0);
    expect(
      stacks.some(
        (s) =>
          (s.appliedAllocation.super_cc_you ?? 0) > 0 &&
          ((s.appliedAllocation.debt_recycle_you_growth ?? 0) > 0 ||
            (s.appliedAllocation.debt_recycle_you_income ?? 0) > 0),
      ),
    ).toBe(true);
  });
});

describe("CGT 2027 hybrid", () => {
  it("post-2027 purchase uses indexation and the 30% floor / MTR", () => {
    const r = estimateHybridCgt({
      proceeds: 150_000,
      cost: 100_000,
      acquiredDate: "2027-08-01",
      disposedDate: "2036-08-01",
      inflationRate: 0.025,
      person: { taxableIncome: 400_000, medicareLevy: 0.02 },
    });
    expect(r.preGain).toBe(0);
    expect(r.tax).toBeGreaterThan(0);
    expect(r.tax).toBeGreaterThan(r.taxIfLegacyDiscount * 0.9);
    expect(r.notes.some((n) => n.includes("Acquired after"))).toBe(true);
  });

  it("straddle: pre-cutover discount + post indexation", () => {
    const r = estimateHybridCgt({
      proceeds: 200_000,
      cost: 100_000,
      acquiredDate: "2024-01-01",
      disposedDate: "2030-01-01",
      valueAtCutover: 140_000,
      inflationRate: 0.025,
      person: { taxableIncome: 400_000, medicareLevy: 0.02 },
    });
    expect(r.preGain).toBeCloseTo(40_000, 0);
    expect(r.tax).toBeGreaterThan(0);
    expect(r.taxIfLegacyDiscount).toBeCloseTo(100_000 * 0.5 * 0.47, 0);
  });

  it("does not give a late-bought parcel a decade of CPI indexation", () => {
    const person = { taxableIncome: 400_000, medicareLevy: 0.02 };
    const gain = {
      proceeds: 300_000,
      cost: 200_000,
      disposedDate: "2036-09-01",
      inflationRate: 0.025,
      person,
    };
    const backdated = estimateHybridCgt({
      ...gain,
      acquiredDate: "2026-09-01",
    });
    const twoYears = estimateHybridCgt({
      ...gain,
      acquiredDate: "2034-09-01",
    });
    expect(twoYears.tax).toBeGreaterThan(backdated.tax);
    expect(twoYears.tax / backdated.tax).toBeGreaterThan(1.5);
  });
});

describe("applyCaps", () => {
  it("scales a mix that is over the lump before clamping super", () => {
    const h = hush({ lumpSum: 250_000 });
    const { applied, warnings } = applyCaps(h, {
      offset: 200_000,
      extra_repay: 200_000,
    });
    expect(allocationSum(applied)).toBeCloseTo(250_000, 0);
    expect(warnings.some((w) => w.includes("scaled"))).toBe(true);
  });
});

describe("NCC bring-forward TSB bands", () => {
  it("reads the 2-year TSB threshold from assumptions, not a FY constant", () => {
    const person = defaultPerson("you", { superBalance: 1_900_000, age: 50 });
    const base = defaultAssumptions();
    expect(nccRoom(person, base, true)).toBe(base.nonConcessionalCap * 2);
    const shifted = defaultAssumptions({ tsbBringForward2y: 1_850_000 });
    expect(nccRoom(person, shifted, true)).toBe(shifted.nonConcessionalCap);
  });
});

describe("idle offset sweep", () => {
  it("buys unlevered spouse growth with offset above the home loan", () => {
    const h = hush({
      loan: {
        balance: 100_000,
        offset: 180_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
      assumptions: defaultAssumptions({
        ...zeroMarket,
        sweepIdleOffset: true,
      }),
    });
    const r = runScenario(h, def("o", { offset: h.lumpSum }));
    expect(r.investmentLoan).toBe(0);
    expect(r.homeLoan).toBeCloseTo(100_000, 0);
    // Day one, before pay starts flowing through the pool. No restriction
    // set, so the floor is just the home loan balance — offset builds to
    // full loan parity first, then the rest is swept.
    const day0 = r.years[0]!;
    expect(day0.offset).toBeCloseTo(100_000, 0);
    expect(day0.taxableTotal).toBeCloseTo(180_000 + h.lumpSum - 100_000, 0);
    expect(r.taxableYou).toBe(0);
  });
});

describe("restricted offset (not yours)", () => {
  it("is excluded from net wealth but still offsets home-loan interest", () => {
    // sweepIdleOffset off, and the loan balance kept well above offset, so
    // this isolates the net-wealth/interest effect from the sweep mechanic
    // (covered separately below).
    const noSweep = defaultAssumptions({ ...zeroMarket, sweepIdleOffset: false });
    const h1 = hush({
      assumptions: noSweep,
      loan: {
        balance: 600_000,
        offset: 200_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
    });
    const h2 = hush({
      assumptions: noSweep,
      loan: {
        balance: 600_000,
        offset: 200_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
        restrictedOffset: 50_000,
      },
    });
    const a = runScenario(h1, def("o", { offset: h1.lumpSum }));
    const b = runScenario(h2, def("o", { offset: h2.lumpSum }));
    expect(a.netWealth - b.netWealth).toBeCloseTo(50_000, 0);
    expect(a.offset).toBeCloseTo(b.offset, 0);
    expect(a.totalHomeInterest).toBeCloseTo(b.totalHomeInterest, 0);
  });

  it("keeps the floor at the restricted amount once it's bigger than the loan", () => {
    const h = hush({
      loan: {
        balance: 50_000,
        offset: 180_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
        restrictedOffset: 100_000,
      },
      assumptions: defaultAssumptions({ ...zeroMarket, sweepIdleOffset: true }),
    });
    const r = runScenario(h, def("o", { offset: h.lumpSum }));
    // floor = max(homeLoan 50k, restricted 100k) = 100k — the loan is
    // already more than covered, so the restriction is what's protected.
    // idle = offset(180k+250k) - 100k = 330k swept, on day one.
    const day0 = r.years[0]!;
    expect(day0.offset).toBeCloseTo(100_000, 0);
    expect(day0.taxableTotal).toBeCloseTo(180_000 + h.lumpSum - 100_000, 0);
  });

  it("protects idle cash when offset hasn't reached the floor yet", () => {
    const h = hush({
      loan: {
        balance: 30_000,
        offset: 40_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
        restrictedOffset: 50_000,
      },
      assumptions: defaultAssumptions({ ...zeroMarket, sweepIdleOffset: true }),
    });
    // floor = max(homeLoan 30k, restricted 50k) = 50k. offset (40k) is
    // under that even before the lump — empty allocation, nothing sweeps.
    const r = runScenario(h, def("o", {}));
    const day0 = r.years[0]!;
    expect(day0.taxableTotal).toBe(0);
    expect(day0.offset).toBeCloseTo(40_000, 0);
  });
});

describe("income growth", () => {
  it("adds grown work super each year after fund tax", () => {
    const h = hush({
      you: defaultPerson("you", {
        salary: 10_000 / 0.12,
        sgRatePercent: 12,
        extraConcessionalFortnightly: 0,
        taxableIncome: 100_000,
      }),
      assumptions: defaultAssumptions({
        ...zeroMarket,
        horizonYears: 2,
        incomeGrowthRate: 0.1,
      }),
    });
    const r = runScenario(h, def("o", { offset: h.lumpSum }));
    const intoFund = (n: number) => n * (1 - h.assumptions.concessionalContributionsTax);
    expect(r.superYou).toBeCloseTo(
      h.you.superBalance + intoFund(10_000) + intoFund(11_000),
      0,
    );
  });
});

describe("income tax brackets", () => {
  it("matches the FY2026-27 resident table at 190k", () => {
    expect(incomeTax(190_000, 0)).toBeCloseTo(51_370, 6);
    expect(lastDollarPit(193_000)).toBe(0.45);
    expect(lastDollarPit(189_000)).toBe(0.37);
  });

  it("a 15025 deduction at 193k is mostly 37%, not 45%", () => {
    const save = -taxDelta(193_000, -15_025, 0.02);
    expect(save).toBeCloseTo(3_000 * 0.47 + 12_025 * 0.39, 2);
    expect(save).toBeLessThan(15_025 * 0.47);
  });
});

describe("Div 293", () => {
  it("charges 15% on concessional once income + CC exceeds 250k", () => {
    expect(division293Tax(220_000, 32_500, 250_000)).toBeCloseTo(
      (220_000 + 32_500 - 250_000) * 0.15,
      5,
    );
    expect(division293Tax(180_000, 32_500, 250_000)).toBe(0);
  });
});

describe("annual tax settlement (1 Jul FY rollover)", () => {
  it("keeps the monthly refund out of the offset until the FY rolls over in July", () => {
    const h = hush({
      loan: {
        balance: 650_000,
        offset: 80_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
      assumptions: defaultAssumptions({
        ...zeroMarket,
        startDate: "2026-09-01",
        investmentLoanRate: 0.06,
        sweepIdleOffset: false,
      }),
    });
    const r = runScenario(h, def("r", { debt_recycle_you_growth: h.lumpSum }));
    const months = r.months;
    const delta = (i: number) => months[i]!.offset - months[i - 1]!.offset;
    // Pay settles into the offset at the same rate every month, so the only
    // thing that can make one month different is the refund.
    for (let i = 2; i < 9; i++) {
      expect(delta(i)).toBeCloseTo(delta(1), 0);
    }
    // Month 10 is the first time the simulated calendar rolls from June into
    // July, and that's when the whole year's refund shows up — once.
    expect(delta(9)).toBeGreaterThan(delta(8) + 1);
    const totalNetTax = months
      .slice(0, 10)
      .reduce((s, mo) => s + mo.incomeTax, 0);
    expect(delta(9) - delta(8)).toBeCloseTo(-totalNetTax, 0);
  });
});

describe("distribution schedule", () => {
  const yielding = (distributionsPerYear: number) =>
    hush({
      loan: {
        balance: 0,
        offset: 0,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
      assumptions: defaultAssumptions({
        ...zeroMarket,
        startDate: "2027-01-01",
        horizonYears: 1,
        sweepIdleOffset: false,
        incomeAsset: {
          label: "yielder",
          growthRate: 0,
          yieldRate: 0.04,
          mer: 0,
          frankingPercent: 0,
          reinvestDividends: false,
          distributionsPerYear,
        },
      }),
    });

  it("pays a quarterly fund in four lumps, not twelve dribbles", () => {
    const r = runScenario(
      yielding(4),
      def("i", { taxable_you_income: 120_000 }),
    );
    const paid = r.months.filter((m) => m.dividendCash > 0.5);
    expect(paid.map((m) => m.date.slice(5, 7))).toEqual([
      "03",
      "06",
      "09",
      "12",
    ]);
    // Nine months of the year show nothing arriving at all.
    expect(r.months.filter((m) => m.dividendCash <= 0.5)).toHaveLength(8);
  });

  it("pays the same total over the year however it's split up", () => {
    const total = (perYear: number) =>
      runScenario(yielding(perYear), def("i", { taxable_you_income: 120_000 }))
        .months.reduce((s, m) => s + m.dividendCash, 0);
    // A quarter's yield sits uninvested a little longer, so the totals are
    // close rather than identical — but nothing is lost or invented.
    expect(total(4)).toBeCloseTo(total(12), 0);
    expect(total(1)).toBeCloseTo(total(12), 0);
  });
});

describe("cash pool", () => {
  const poolHousehold = (assumptions: Partial<Assumptions> = {}) =>
    hush({
      you: defaultPerson("you", { taxableIncome: 60_000 }),
      spouse: defaultPerson("spouse", { taxableIncome: 0 }),
      loan: {
        balance: 50_000,
        offset: 0,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
      },
      assumptions: defaultAssumptions({
        ...zeroMarket,
        sweepIdleOffset: false,
        ...assumptions,
      }),
    });

  it("settles pay minus every cost into the offset each month", () => {
    const r = runScenario(poolHousehold({ monthlyExpenses: 3_000 }), def("o", {}));
    const monthlyPay = (60_000 - incomeTax(60_000, 0.02)) / 12;
    const leftover = monthlyPay - 3_000; // no loan payment/interest here (0% IO)
    expect(r.months[0]!.spareCash).toBeCloseTo(leftover, 0);
    expect(r.months[0]!.offsetContribution).toBeCloseTo(leftover, 0);
    expect(r.months[0]!.offset).toBeCloseTo(leftover, 0);
    // The pool is transit only — it doesn't hold a balance between months.
    expect(r.months[0]!.cash).toBe(0);
    expect(r.months[1]!.offset).toBeCloseTo(leftover * 2, 0);
  });

  it("keeps the whole leftover, not a fixed monthly amount", () => {
    // The old fixed "extra to offset per month" dial is gone: whatever the
    // household doesn't spend lands in the offset, however large.
    const r = runScenario(poolHousehold(), def("o", {}));
    const monthlyPay = (60_000 - incomeTax(60_000, 0.02)) / 12;
    expect(r.months[0]!.offsetContribution).toBeCloseTo(monthlyPay, 0);
  });

  it("ignores spouse's pay when income isn't pooled", () => {
    const notPooled = runScenario(
      poolHousehold({ pooledIncome: false }),
      def("o", {}),
    );
    const pooled = runScenario(
      poolHousehold({ pooledIncome: true }),
      def("o", {}),
    );
    const youOnlyPay = (60_000 - incomeTax(60_000, 0.02)) / 12;
    expect(notPooled.months[0]!.afterTaxPay).toBeCloseTo(youOnlyPay, 0);
    // Spouse earns nothing here, so pooling changes nothing — the point is
    // that your own pay is what reaches the pool either way.
    expect(pooled.months[0]!.offsetContribution).toBeCloseTo(
      notPooled.months[0]!.offsetContribution,
      0,
    );
  });

  it("lines plan years up with calendar years from a 1 January start", () => {
    const r = runScenario(
      poolHousehold({
        startDate: "2027-01-01",
        incomeGrowthRate: 0.1,
        annualHolidaySpend: 5_000,
      }),
      def("o", {}),
    );
    // A row covers the month it's named after, rather than the instant it
    // closes — month one of a 1 Jan start is January, not February.
    expect(r.months[0]!.date).toBe("2027-01-01");
    expect(r.months[11]!.date).toBe("2027-12-01");
    expect(r.months[12]!.date).toBe("2028-01-01");
    // Pay steps up on 1 January, not partway through the year.
    expect(r.months[11]!.afterTaxPay).toBeCloseTo(r.months[0]!.afterTaxPay, 0);
    expect(r.months[12]!.afterTaxPay).toBeGreaterThan(
      r.months[11]!.afterTaxPay + 1,
    );
    // And the holiday lands each January, opening the calendar year.
    expect(r.months[0]!.holidaySpend).toBeCloseTo(5_000, 0);
    expect(r.months[12]!.holidaySpend).toBeCloseTo(5_000, 0);
    expect(r.months[11]!.holidaySpend).toBe(0);
  });

  it("charges annualHolidaySpend in holidayMonth, January by default", () => {
    const r = runScenario(
      poolHousehold({ monthlyExpenses: 0, annualHolidaySpend: 5_000 }),
      def("o", {}),
    );
    for (const m of r.months) {
      const january = m.date.slice(5, 7) === "01";
      expect(m.holidaySpend).toBeCloseTo(january ? 5_000 : 0, 0);
    }
    // The plan starts in September, so the first holiday is four months in,
    // not twelve — it follows the calendar, not the plan's anniversary.
    expect(r.months[4]!.date).toBe("2027-01-01");
    expect(r.years[1]!.holidaySpend).toBeCloseTo(5_000, 0);
    // It comes out of that month's spare cash, so less reaches the offset
    // than in a normal month.
    expect(r.months[4]!.spareCash).toBeCloseTo(
      r.months[3]!.spareCash - 5_000,
      0,
    );
    expect(r.months[4]!.offsetContribution).toBeLessThan(
      r.months[3]!.offsetContribution,
    );
  });

  it("moves the holiday to whichever month holidayMonth names", () => {
    const r = runScenario(
      poolHousehold({
        monthlyExpenses: 0,
        annualHolidaySpend: 5_000,
        holidayMonth: 12,
      }),
      def("o", {}),
    );
    for (const m of r.months) {
      const december = m.date.slice(5, 7) === "12";
      expect(m.holidaySpend).toBeCloseTo(december ? 5_000 : 0, 0);
    }
    expect(r.months[3]!.date).toBe("2026-12-01");
  });

  it("covers a holiday bigger than the month's pay out of the offset", () => {
    const monthlyPay = (60_000 - incomeTax(60_000, 0.02)) / 12;
    const holiday = Math.round(monthlyPay * 4); // far more than one month's pay
    const r = runScenario(
      poolHousehold({ monthlyExpenses: 0, annualHolidaySpend: holiday }),
      def("o", {}),
    );
    const before = r.months[3]!.offset;
    const holidayMonth = r.months[4]!;
    expect(holidayMonth.date).toBe("2027-01-01");
    // The month runs a real deficit, and the offset — the everyday account —
    // wears it, rather than the pool carrying a negative balance.
    expect(holidayMonth.spareCash).toBeLessThan(0);
    expect(holidayMonth.offsetContribution).toBeLessThan(0);
    expect(holidayMonth.cash).toBe(0);
    expect(holidayMonth.offset).toBeCloseTo(before + holidayMonth.spareCash, 0);
  });

  it("holds the minimum cash buffer back from being invested", () => {
    const build = (minimumCash: number) =>
      hush({
        loan: {
          balance: 0,
          offset: 200_000,
          annualRate: 0,
          remainingYears: 25,
          interestOnly: true,
          restrictedOffset: 0,
        },
        assumptions: defaultAssumptions({ ...zeroMarket, minimumCash }),
      });
    const noBuffer = runScenario(build(0), def("o", {}));
    const buffered = runScenario(build(50_000), def("o", {}));
    // Loan is paid off, so with no buffer the whole offset is idle and gets
    // invested on day one. The buffer keeps 50k of it liquid instead.
    expect(noBuffer.years[0]!.offset).toBeCloseTo(0, 0);
    expect(buffered.years[0]!.offset).toBeCloseTo(50_000, 0);
    // Still the household's money either way — just not at risk.
    expect(buffered.years[0]!.netWealth).toBeCloseTo(
      noBuffer.years[0]!.netWealth,
      0,
    );
  });

  it("saves for the holiday ahead of time instead of raiding the cash buffer", () => {
    const build = (annualHolidaySpend: number) =>
      hush({
        // Loan already paid off, so the liquid floor — not parity — is what
        // governs the sweep. That's where the holiday could bite.
        loan: {
          balance: 0,
          offset: 60_000,
          annualRate: 0,
          remainingYears: 25,
          interestOnly: true,
          restrictedOffset: 0,
        },
        assumptions: defaultAssumptions({
          ...zeroMarket,
          minimumCash: 20_000,
          monthlyExpenses: 0,
          annualHolidaySpend,
          holidayMonth: 1,
        }),
      });
    const withHoliday = runScenario(build(12_000), def("o", {}));
    const byMonth = (iso: string) =>
      withHoliday.months.find((m) => m.date === iso)!;

    // Through the year the floor climbs a twelfth of the trip at a time, so
    // the offset holds the buffer plus what's saved so far.
    expect(byMonth("2027-01-01").offset).toBeCloseTo(20_000, 0);
    expect(byMonth("2027-07-01").offset).toBeCloseTo(20_000 + 6_000, 0);
    expect(byMonth("2027-12-01").offset).toBeCloseTo(20_000 + 11_000, 0);
    // The trip is paid for out of what was saved for it — the cash buffer
    // itself is never dipped into.
    expect(byMonth("2028-01-01").holidaySpend).toBeCloseTo(12_000, 0);
    for (const m of withHoliday.months) {
      expect(m.offset).toBeGreaterThanOrEqual(20_000 - 0.5);
    }
  });

  it("holds the holiday fund clear of the offset target when asked to", () => {
    const build = (holidayFundOnTop: boolean) =>
      hush({
        // Modest surplus, so a $12k trip is worth several months of it —
        // otherwise the offset refills the same month and neither setting
        // ever stalls.
        you: defaultPerson("you", { taxableIncome: 60_000 }),
        spouse: defaultPerson("spouse", { taxableIncome: 0 }),
        // A real loan outstanding and already at parity, which is the only
        // regime where the two settings differ.
        loan: {
          balance: 300_000,
          offset: 300_000,
          annualRate: 0,
          remainingYears: 25,
          interestOnly: true,
          restrictedOffset: 0,
        },
        assumptions: defaultAssumptions({
          ...zeroMarket,
          minimumCash: 0,
          monthlyExpenses: 2_000,
          annualHolidaySpend: 12_000,
          holidayMonth: 1,
          holidayFundOnTop,
        }),
      });
    const onTop = runScenario(build(true), def("o", {}));
    const inside = runScenario(build(false), def("o", {}));
    const at = (r: typeof onTop, iso: string) =>
      r.months.find((m) => m.date === iso)!;

    // On top: the offset visibly carries the loan plus what's been saved, so
    // the trip spends its own money.
    expect(at(onTop, "2027-07-01").offset).toBeCloseTo(
      at(onTop, "2027-07-01").homeLoan + 6_000,
      0,
    );
    // Inside: the offset is the holiday fund, so it never rises above parity
    // and the trip is made good out of the months after it.
    expect(at(inside, "2027-07-01").offset).toBeCloseTo(
      at(inside, "2027-07-01").homeLoan,
      0,
    );
    // Which is why one keeps investing through the trip and the other stalls.
    const stalled = (r: typeof onTop) =>
      r.months.filter((m) => m.invested <= 0.5).length;
    expect(stalled(onTop)).toBeLessThan(stalled(inside));
  });

  it("stacks the cash buffer on top of restricted offset, both staying liquid", () => {
    const h = hush({
      loan: {
        balance: 0,
        offset: 200_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
        restrictedOffset: 100_000,
      },
      assumptions: defaultAssumptions({ ...zeroMarket, minimumCash: 30_000 }),
    });
    const r = runScenario(h, def("o", {}));
    // Restricted money isn't yours to spend and the buffer is yours to keep
    // liquid — they're different rules, so they add up rather than overlap.
    expect(r.years[0]!.offset).toBeCloseTo(130_000, 0);
  });
});

describe("novated lease", () => {
  it("triggers Division 293 once the lease ends and taxable income effectively rises", () => {
    const build = (endDate: string) =>
      hush({
        you: defaultPerson("you", {
          taxableIncome: 245_000,
          salary: 20_000 / 0.12,
          sgRatePercent: 12,
          extraConcessionalFortnightly: 0,
          novatedLeaseFortnightly: 500, // $13,000/yr
          novatedLeaseEndDate: endDate,
        }),
        assumptions: defaultAssumptions({
          ...zeroMarket,
          horizonYears: 1,
          incomeGrowthRate: 0,
        }),
      });
    // zeroMarket starts 2026-09-01.
    const stillLeased = build("2027-09-01"); // ends 12 months out — active the whole horizon
    const leaseAlreadyEnded = build("2026-09-01"); // ends right when the plan starts

    const a = runScenario(stillLeased, def("o", { offset: stillLeased.lumpSum }));
    const b = runScenario(
      leaseAlreadyEnded,
      def("o", { offset: leaseAlreadyEnded.lumpSum }),
    );
    // Division 293 = min(committed, income + committed − 250k) × 15%.
    // Still leased: income 245k, over = 245k+20k−250k = 15k < committed
    // (20k) — "over" is the binding side: 15k × 15% = $2,250.
    // Lease over: income 258k, over = 258k+20k−250k = 28k > committed —
    // committed is now the binding side: 20k × 15% = $3,000. The $13k/yr
    // isn't taxed 1:1 — it's whichever side of the min() is smaller.
    const expectedGap = 20_000 * 0.15 - 15_000 * 0.15;
    // Net wealth alone can't isolate this any more: the lease ending also
    // hands the household its salary-sacrificed pay back, and that now lands
    // in the cash pool instead of vanishing. Net the pay difference out —
    // taken from the engine's own figures rather than re-derived here — and
    // what's left is the Division 293 step.
    const payGap = b.years[1]!.afterTaxPay - a.years[1]!.afterTaxPay;
    expect(payGap).toBeGreaterThan(0);
    expect(a.netWealth - b.netWealth + payGap).toBeCloseTo(expectedGap, 0);
  });
});
