/**
 * Engine correctness audit — written TDD-style, ahead of the fixes.
 *
 * Each test encodes what the engine should do financially, independent of
 * what it did at the time. All findings here were fixed the same day. Kept
 * as a permanent regression suite against the same bugs recurring.
 */
import { describe, expect, it } from "vitest";
import { defaultAssumptions, defaultHousehold, defaultPerson } from "./defaults.js";
import { applyCaps, runScenario } from "./engine.js";
import { addMonthsIso, division293Tax } from "./tax.js";
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

function def(id: string, allocation: ScenarioDef["allocation"]): ScenarioDef {
  return { id, label: id, summary: id, group: "custom", allocation };
}

describe("AUDIT: Division 293 on ongoing concessional contributions", () => {
  it("levies Division 293 on employer SG that pushes income over $250k, not just on the lump", () => {
    const build = (sgAmount: number) =>
      hush({
        you: defaultPerson("you", {
          taxableIncome: 245_000,
          salary: sgAmount / 0.12,
          sgRatePercent: 12,
          extraConcessionalFortnightly: 0,
        }),
        assumptions: defaultAssumptions({
          ...zeroMarket,
          horizonYears: 1,
          incomeGrowthRate: 0,
        }),
      });
    const below = build(3_000); // 245k + 3k SG = 248k, under the $250k threshold
    const above = build(20_000); // 245k + 20k SG = 265k, $15k over threshold

    const rBelow = runScenario(below, def("o", { offset: below.lumpSum }));
    const rAbove = runScenario(above, def("o", { offset: above.lumpSum }));

    const extraSg = 20_000 - 3_000;
    const extraIntoSuperIfNoDiv293 =
      extraSg * (1 - below.assumptions.concessionalContributionsTax);
    const expectedDiv293 = division293Tax(
      245_000,
      20_000,
      below.assumptions.div293Threshold,
    );
    const expectedDelta = extraIntoSuperIfNoDiv293 - expectedDiv293;

    // The $17k of extra employer SG should land in super net of BOTH the
    // 15% contributions tax AND Division 293 on the slice over $250k.
    expect(rAbove.netWealth - rBelow.netWealth).toBeCloseTo(expectedDelta, 0);
  });
});

describe("AUDIT: concessional cap on ongoing SG contributions", () => {
  it("does not let extra super guarantee vanish once the cap bites in a later year", () => {
    const build = (sgAmount: number) =>
      hush({
        you: defaultPerson("you", {
          taxableIncome: 100_000,
          salary: sgAmount / 0.12,
          sgRatePercent: 12,
          extraConcessionalFortnightly: 0,
        }),
        assumptions: defaultAssumptions({
          ...zeroMarket,
          horizonYears: 2,
          incomeGrowthRate: 0,
        }),
      });
    const atCap = build(32_500); // exactly this FY's concessional cap
    const overCap = build(36_000); // $3,500/yr over the cap

    const rAtCap = runScenario(atCap, def("o", { offset: atCap.lumpSum }));
    const rOverCap = runScenario(overCap, def("o", { offset: overCap.lumpSum }));

    const superGrowthYearTwo = (r: typeof rAtCap) =>
      r.years[2]!.superTotal - r.years[1]!.superTotal;

    // Year two is where the flat cap-clamp applies (year one is treated as
    // already-committed and isn't re-checked). A household whose compulsory
    // SG is $3,500/yr higher should end up with more super, more tax paid
    // on the excess, or more cash — not a bit-for-bit identical outcome.
    expect(superGrowthYearTwo(rOverCap)).toBeGreaterThan(
      superGrowthYearTwo(rAtCap),
    );
  });
});

describe("AUDIT: addMonthsIso month-end handling", () => {
  it("clamps to the end of a shorter month instead of rolling into the next one", () => {
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsIso("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(addMonthsIso("2026-01-30", 1)).toBe("2026-02-28");
    expect(addMonthsIso("2026-03-31", 1)).toBe("2026-04-30");
  });
});

describe("AUDIT: debt recycle beyond the home loan balance", () => {
  it("warns when the recycled amount exceeds the available home loan balance", () => {
    const h = hush({
      lumpSum: 200_000,
      loan: {
        balance: 100_000,
        offset: 20_000,
        annualRate: 0.06,
        remainingYears: 25,
        interestOnly: true,
      },
    });
    // The lump is larger than the home loan balance.
    const r = runScenario(h, def("r", { debt_recycle_you_growth: h.lumpSum }));
    expect(
      r.warnings.some((w) => /recycle/i.test(w) || /loan balance/i.test(w)),
    ).toBe(true);
  });
});

describe("AUDIT: allocation input validation", () => {
  it("does not let a negative bucket amount slip through applyCaps unflagged", () => {
    const h = hush();
    // The positive leg is only "under" the lump because of the negative leg.
    const bogus = { offset: -1_000_000, taxable_you_growth: 1_200_000 };
    const { applied } = applyCaps(h, bogus);
    expect(Object.values(applied).some((v) => (v ?? 0) < 0)).toBe(false);
  });
});
