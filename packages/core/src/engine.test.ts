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
import type { Household, ScenarioDef } from "./types.js";

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
    expect(r.homeLoan).toBeCloseTo(150_000, 0);
    expect(r.offset).toBeCloseTo(80_000, 0);
    expect(r.investmentLoan).toBeCloseTo(250_000, 0);
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
    // Paying 6% to hold a 0%-return asset is a loss even after the
    // deduction — the ATO refunds at most your marginal rate, never the
    // whole dollar of interest.
    expect(recycle.netWealth).toBeLessThan(invest.netWealth);
    // Roughly lump * rate * (1 - MTR) * years, net cost after the deduction.
    const rough = h.lumpSum * 0.06 * (1 - combinedMarginalRate(h.you)) * 10;
    expect(invest.netWealth - recycle.netWealth).toBeGreaterThan(rough * 0.8);
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
  it("buys unlevered spouse growth with offset above the restricted floor", () => {
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
    // No restriction set, so the sweep takes it all the way to zero — even
    // below the still-outstanding home loan balance.
    expect(r.offset).toBeCloseTo(0, 0);
    expect(r.taxableSpouse).toBeCloseTo(180_000 + h.lumpSum, 0);
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

  it("is never swept into investments, even when idle-offset sweeping is on", () => {
    const h = hush({
      loan: {
        balance: 100_000,
        offset: 180_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
        restrictedOffset: 60_000,
      },
      assumptions: defaultAssumptions({ ...zeroMarket, sweepIdleOffset: true }),
    });
    const r = runScenario(h, def("o", { offset: h.lumpSum }));
    // idle = offset(180k+250k) - restricted(60k) = 370k swept, leaving
    // exactly the restricted 60k sitting in offset — the home loan balance
    // (100k) is no longer a floor.
    expect(r.offset).toBeCloseTo(60_000, 0);
    expect(r.taxableSpouse).toBeCloseTo(180_000 + h.lumpSum - 60_000, 0);
  });

  it("protects idle cash when offset is at or below the restricted floor", () => {
    const h = hush({
      loan: {
        balance: 100_000,
        offset: 40_000,
        annualRate: 0,
        remainingYears: 25,
        interestOnly: true,
        restrictedOffset: 50_000,
      },
      assumptions: defaultAssumptions({ ...zeroMarket, sweepIdleOffset: true }),
    });
    // offset (40k) is under the restriction (50k) even before the lump —
    // empty allocation, so nothing should sweep.
    const r = runScenario(h, def("o", {}));
    expect(r.taxableSpouse).toBe(0);
    expect(r.offset).toBeCloseTo(40_000, 0);
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
