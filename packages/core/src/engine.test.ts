import { describe, expect, it } from "vitest";
import { concessionalRoom } from "./caps.js";
import { defaultAssumptions, defaultHousehold } from "./defaults.js";
import { runHousehold, runScenario } from "./engine.js";
import { buildPresets } from "./presets.js";
import { combinedMarginalRate, division293Tax, estimateHybridCgt } from "./tax.js";
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
      h.you.concessionalUsedThisFy + cap,
      h.assumptions.div293Threshold,
    );
    const expected =
      cap * (combinedMarginalRate(h.you) - 0.15) - div293;
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
      h.you.concessionalUsedThisFy + cap,
      h.assumptions.div293Threshold,
    );
    const gap =
      cap *
        (combinedMarginalRate(h.you) - combinedMarginalRate(h.spouse)) -
      div293;
    expect(you.netWealth - spouse.netWealth).toBeCloseTo(gap, 0);
  });
});

describe("day-one identity (0% rates)", () => {
  it("offset, taxable, and debt-recycle match net wealth", () => {
    const h = hush();
    const a = runScenario(h, def("off", { offset: h.lumpSum }));
    const b = runScenario(h, def("tax", { taxable_you_growth: h.lumpSum }));
    const c = runScenario(h, def("rec", { debt_recycle_you_growth: h.lumpSum }));
    expect(a.netWealth).toBeCloseTo(b.netWealth, 0);
    expect(b.netWealth).toBeCloseTo(c.netWealth, 0);
  });

  it("offset and extra-repay match net wealth and net debt", () => {
    const h = hush();
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
  it("beats buying in your name when the loan rate is positive and assets are flat", () => {
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
    expect(recycle.netWealth).toBeGreaterThan(invest.netWealth);
    // Roughly lump * rate * MTR * years, refunds compounding in offset at 0%.
    const rough = h.lumpSum * 0.06 * combinedMarginalRate(h.you) * 10;
    expect(recycle.netWealth - invest.netWealth).toBeGreaterThan(rough * 0.8);
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
    expect(report.results.length).toBe(presets.length);
    for (let i = 1; i < report.results.length; i++) {
      expect(report.results[i - 1]!.netIfLiquidated).toBeGreaterThanOrEqual(
        report.results[i]!.netIfLiquidated,
      );
    }
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
      person: { marginalRate: 0.45, medicareLevy: 0.02 },
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
      person: { marginalRate: 0.45, medicareLevy: 0.02 },
    });
    expect(r.preGain).toBeCloseTo(40_000, 0);
    expect(r.tax).toBeGreaterThan(0);
    expect(r.taxIfLegacyDiscount).toBeCloseTo(100_000 * 0.5 * 0.47, 0);
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
