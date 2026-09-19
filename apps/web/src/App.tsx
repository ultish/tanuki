import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchHousehold,
  fetchMeta,
  runPlan,
  saveHousehold,
  type Allocation,
  type Explainer,
  type Household,
  type Meta,
  type Person,
  type RunReport,
  type ScenarioResult,
} from "./api";
import {
  REST_BUCKETS,
  lastDollarPit,
  stackAllocation,
  taxDelta,
  type SuperFill,
} from "@tanuki/core";
import { money, parseNum, parseNumLoose, pct } from "./format";

const MIX_BUCKETS: { id: string; label: string; tip: string }[] = [
  {
    id: "offset",
    label: "Offset",
    tip: "Park it against the home loan. Interest drops, and you can still spend the cash.",
  },
  {
    id: "extra_repay",
    label: "Pay down home loan",
    tip: "Pay the mortgage down. Same interest save as the offset. Harder to get the cash back.",
  },
  {
    id: "taxable_you_growth",
    label: "Growth shares, your name",
    tip: "Shares that go up in price, in your name. Sell whenever. Tax on a sale is at your rate.",
  },
  {
    id: "taxable_you_income",
    label: "Dividend shares, your name",
    tip: "Shares that pay cash each year, in your name. Each dividend is taxed at your rate.",
  },
  {
    id: "taxable_spouse_growth",
    label: "Growth shares, spouse's name",
    tip: "Same growth shares, in their name. Tax is at their rate. For tax, it's theirs.",
  },
  {
    id: "taxable_spouse_income",
    label: "Dividend shares, spouse's name",
    tip: "Cash-paying shares in their name. Dividends get taxed at 32%, not 47%.",
  },
  {
    id: "debt_recycle_you_growth",
    label: "Debt recycle, growth",
    tip: "Pay it onto the home loan, redraw as an investment split, buy growth shares. Some of the interest comes off your tax. You cannot recycle from an offset.",
  },
  {
    id: "debt_recycle_you_income",
    label: "Debt recycle, income",
    tip: "Same pay-down-then-redraw move, but the shares pay dividends that can help cover the loan.",
  },
  {
    id: "super_cc_you",
    label: "Tax-cut into your super",
    tip: "Put it in your super and cut this year's tax. Super takes 15%. Locked until retirement.",
  },
  {
    id: "super_cc_spouse",
    label: "Tax-cut into spouse super",
    tip: "Same tax cut, their super. Their refund is smaller because their rate is lower.",
  },
  {
    id: "super_ncc_you",
    label: "After-tax into your super",
    tip: "Already-taxed money into your super. No extra refund. Growth inside is taxed at 15%. Locked.",
  },
  {
    id: "super_ncc_spouse",
    label: "After-tax into spouse super",
    tip: "Already-taxed money into their super. Uses their yearly limit. Tax inside is still 15%.",
  },
];

export default function App() {
  const [household, setHousehold] = useState<Household | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mix, setMix] = useState<Allocation>({});
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [h, m] = await Promise.all([fetchHousehold(), fetchMeta()]);
        if (cancelled) return;
        setHousehold(h);
        setMeta(m);
        setStatus("Ready");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async (h: Household, custom?: Allocation) => {
    setStatus("Calculating…");
    setError(null);
    try {
      const r = await runPlan(h, custom);
      setReport(r);
      setSelectedId((prev) => {
        if (prev && r.results.some((x) => x.id === prev)) return prev;
        return r.results[0]?.id ?? null;
      });
      setStatus("Ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("Failed");
    }
  }, []);

  useEffect(() => {
    if (!household) return;
    const t = window.setTimeout(() => {
      const custom = mixWithLeftover(mix, household.lumpSum);
      void run(household, custom);
    }, 400);
    return () => window.clearTimeout(t);
  }, [household, mix, run]);

  const selected = report?.results.find((r) => r.id === selectedId) ?? null;
  const mixSum = Object.values(mix).reduce((s, n) => s + (n || 0), 0);
  const kickerRef = useRef<HTMLParagraphElement>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const [pastIds, setPastIds] = useState<string[]>([]);

  const registerRow = useCallback(
    (id: string, el: HTMLTableRowElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    },
    [],
  );

  useEffect(() => {
    if (!report) {
      setPastIds([]);
      return;
    }
    const update = () => {
      const line = kickerRef.current?.getBoundingClientRect().bottom ?? 0;
      const next = report.results
        .filter((r) => {
          const el = rowRefs.current.get(r.id);
          return el != null && el.getBoundingClientRect().bottom < line - 1;
        })
        .map((r) => r.id);
      setPastIds((prev) => (sameIds(prev, next) ? prev : next));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [report]);

  if (error && !household) {
    return (
      <div className="shell">
        <p className="mast-aside">{error}</p>
      </div>
    );
  }
  if (!household) {
    return (
      <div className="shell">
        <p className="mast-aside">Opening the ledger…</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="mast">
        <div className="mast-brand">
          <img src="/tanuki-icon.png" alt="" width={56} height={56} />
          <div>
            <h1>
              <span>狸</span>Tanuki
            </h1>
            <p>Place the lump. Loan, offset, super, taxable. Side by side.</p>
          </div>
        </div>
        <p className="mast-aside">
          FY{meta?.fy ?? "2026-27"} caps. This one decides where new money
          goes. Risu tracks what you already own.
        </p>
      </header>

      <div className="spread">
        <aside className="page page-left">
          <p className="kicker">
            <Tip text="Loan, incomes, super as they stand. Change a number and the ranking reruns. Save writes it to the local database.">
              Household
            </Tip>
          </p>
          <HouseholdForm
            household={household}
            onChange={setHousehold}
            onSave={async () => {
              setStatus("Saving…");
              const saved = await saveHousehold(household);
              setHousehold(saved);
              setStatus("Saved");
            }}
            status={status}
          />
        </aside>
        <main className="page page-right">
          <div className="lives-sticky">
            <p className="kicker" ref={kickerRef}>
              <Tip text="Each row is a different way to place the whole lump. Click one for the graph and the numbers. Ranked by If sold, which is net wealth after CGT if you sold the taxable shares at the horizon.">
                Lives the money could live
              </Tip>
            </p>
            {report && pastIds.length > 0 ? (
              <div className="strat-chips" aria-label="Scrolled-past strategies">
                {pastIds.map((id) => {
                  const i = report.results.findIndex((r) => r.id === id);
                  const r = report.results[i];
                  if (!r) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`${id === selectedId ? "on" : ""} ${i === 0 ? "best" : ""}`}
                      title={r.label}
                      aria-label={`${i + 1}, ${r.label}`}
                      onClick={() => setSelectedId(id)}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          {error ? <p className="warn-list">{error}</p> : null}
          {report ? (
            <Ledger
              results={report.results}
              selectedId={selectedId}
              onSelect={setSelectedId}
              registerRow={registerRow}
            />
          ) : (
            <p className="status">Waiting on the first run…</p>
          )}
          {selected ? (
            <ChartPanel
              selected={selected}
              baseline={
                report?.results.find((r) => r.id === "offset") ?? null
              }
            />
          ) : null}
          {selected ? (
            <Detail selected={selected} household={household} />
          ) : null}
        </main>
      </div>

      <Mixer
        household={household}
        mix={mix}
        mixSum={mixSum}
        onChange={setMix}
      />

      {meta ? <Explainers items={meta.explainers} /> : null}
      <p className="foot">
        {report?.disclaimer ??
          "Estimates only. Not financial, tax, or investment advice."}
      </p>
    </div>
  );
}

function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  const [box, setBox] = useState<{
    top: number;
    left: number;
    flip: boolean;
  } | null>(null);

  const open = (el: EventTarget & Element) => {
    const r = el.getBoundingClientRect();
    const width = Math.min(352, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const flip = window.innerHeight - r.bottom < 120;
    setBox({
      top: flip ? r.top - 8 : r.bottom + 8,
      left,
      flip,
    });
  };

  return (
    <>
      <span
        className="tip"
        tabIndex={0}
        onMouseEnter={(e) => open(e.currentTarget)}
        onMouseLeave={() => setBox(null)}
        onFocus={(e) => open(e.currentTarget)}
        onBlur={() => setBox(null)}
      >
        {children}
      </span>
      {box
        ? createPortal(
            <div
              className="tip-bubble"
              role="tooltip"
              style={{
                top: box.top,
                left: box.left,
                transform: box.flip ? "translateY(-100%)" : undefined,
              }}
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Field({
  label,
  tip,
  children,
}: {
  label: string;
  tip: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>
        <Tip text={tip}>{label}</Tip>
      </span>
      {children}
    </label>
  );
}

function NumInput({
  value,
  onChange,
  digits,
  id,
  blankZero,
  onClear,
}: {
  value: number | undefined;
  onChange: (n: number) => void;
  digits?: number;
  id?: string;
  blankZero?: boolean;
  onClear?: () => void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const shown =
    raw ??
    (value == null || !Number.isFinite(value) || (blankZero && value === 0)
      ? ""
      : digits != null
        ? value.toFixed(digits)
        : String(value));

  return (
    <input
      id={id}
      inputMode="decimal"
      value={shown}
      placeholder={blankZero ? "0" : undefined}
      onFocus={() =>
        setRaw(
          value == null || !Number.isFinite(value)
            ? ""
            : digits != null
              ? value.toFixed(digits)
              : String(value),
        )
      }
      onChange={(e) => {
        const next = e.target.value;
        setRaw(next);
        const n = parseNumLoose(next);
        if (n != null) onChange(n);
      }}
      onBlur={() => {
        if (raw != null && raw.trim() === "") {
          if (onClear) onClear();
          else onChange(0);
        } else if (raw != null) {
          const n = parseNum(raw);
          onChange(n);
        }
        setRaw(null);
      }}
    />
  );
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function ccRoom(person: Person, cap: number): number {
  const committed =
    Math.max(0, person.employerSgThisFy) +
    Math.max(0, person.extraConcessionalThisFy);
  const fromCap =
    cap + Math.max(0, person.unusedConcessionalCarryForward) - committed;
  return Math.max(0, Math.min(fromCap, Math.max(0, person.taxableIncome)));
}

function mixWithLeftover(mix: Allocation, lump: number): Allocation | undefined {
  const clean: Allocation = {};
  for (const [k, v] of Object.entries(mix)) {
    if (v && v > 0) clean[k] = v;
  }
  if (!Object.keys(clean).length) return undefined;
  const sum = Object.values(clean).reduce((s, n) => s + n, 0);
  const left = lump - sum;
  if (left > 0.5) clean.offset = (clean.offset ?? 0) + left;
  return clean;
}

function HouseholdForm({
  household,
  onChange,
  onSave,
  status,
}: {
  household: Household;
  onChange: (h: Household) => void;
  onSave: () => void;
  status: string;
}) {
  const h = household;
  const set = (patch: Partial<Household>) => onChange({ ...h, ...patch });
  const setYou = (patch: Partial<Person>) =>
    set({ you: { ...h.you, ...patch } });
  const setSpouse = (patch: Partial<Person>) =>
    set({ spouse: { ...h.spouse, ...patch } });
  const setLoan = (patch: Partial<Household["loan"]>) =>
    set({ loan: { ...h.loan, ...patch } });
  const setA = (patch: Partial<Household["assumptions"]>) =>
    set({ assumptions: { ...h.assumptions, ...patch } });
  const setGrowth = (patch: Partial<Household["assumptions"]["growthAsset"]>) =>
    setA({ growthAsset: { ...h.assumptions.growthAsset, ...patch } });
  const setIncome = (patch: Partial<Household["assumptions"]["incomeAsset"]>) =>
    setA({ incomeAsset: { ...h.assumptions.incomeAsset, ...patch } });

  return (
    <>
      <div className="hero-lump">
        <label htmlFor="lump">
          <Tip text="The cash you are placing. Inheritance, bonus, sale proceeds. Getting it is not extra taxable income.">
            Lump to place
          </Tip>
        </label>
        <NumInput
          id="lump"
          value={h.lumpSum}
          onChange={(n) => set({ lumpSum: n })}
        />
      </div>
      <div className="grid-2">
        <Field
          label="Horizon (years)"
          tip="How far the comparison runs. Every scenario is measured this many years from the start date."
        >
          <NumInput
            value={h.assumptions.horizonYears}
            onChange={(n) => setA({ horizonYears: n })}
          />
        </Field>
        <Field
          label="Start"
          tip="When the lump is placed. If that's before 1 Jul 2027, gain up to that day can still get the old 50% CGT discount."
        >
          <input
            type="date"
            value={h.assumptions.startDate}
            onChange={(e) => setA({ startDate: e.target.value })}
          />
        </Field>
        <Field
          label="Income growth % p.a."
          tip="Grows taxable income each year for the tax scale. Employer SG and extra concessional grow at the same rate and keep going into super, after 15%."
        >
          <NumInput
            value={(h.assumptions.incomeGrowthRate ?? 0) * 100}
            digits={1}
            onChange={(n) => setA({ incomeGrowthRate: n / 100 })}
          />
        </Field>
      </div>

      <div className="section">
        <h3>
          <Tip text="Last-dollar rate is PIT on the top slice of taxable income plus Medicare. Extra income and deductions use the FY2026-27 scale, not a flat top rate. Tax-cut room is the concessional cap minus employer SG and extra concessional already going in this year.">
            You, {pct(lastDollarPit(h.you.taxableIncome) + h.you.medicareLevy, 0)}{" "}
            last dollar.{" "}
            {money(ccRoom(h.you, h.assumptions.concessionalCap))} tax-cut room
          </Tip>
        </h3>
        <PersonFields person={h.you} onChange={setYou} />
      </div>
      <div className="section">
        <h3>
          <Tip text="Last-dollar rate is PIT on the top slice of their taxable income plus Medicare. Extra income and deductions use the FY2026-27 scale. Tax-cut room is the concessional cap minus employer SG and extra concessional already going in this year.">
            Spouse,{" "}
            {pct(
              lastDollarPit(h.spouse.taxableIncome) + h.spouse.medicareLevy,
              0,
            )}{" "}
            last dollar.{" "}
            {money(ccRoom(h.spouse, h.assumptions.concessionalCap))} tax-cut
            room
          </Tip>
        </h3>
        <PersonFields person={h.spouse} onChange={setSpouse} />
      </div>

      <div className="section">
        <h3>
          <Tip text="The owner-occupier home loan. Interest on this slice is not deductible. Offset cash cuts the interest without paying the loan down.">
            Home loan
          </Tip>
        </h3>
        <div className="grid-2">
          <Field
            label="Balance"
            tip="What you still owe on the home loan today, before placing the lump."
          >
            <NumInput
              value={h.loan.balance}
              onChange={(n) => setLoan({ balance: n })}
            />
          </Field>
          <Field
            label="Offset"
            tip="Cash already in the offset account. It reduces interest as if the loan were smaller, and stays spendable."
          >
            <NumInput
              value={h.loan.offset}
              onChange={(n) => setLoan({ offset: n })}
            />
          </Field>
          <Field
            label="Of which, not yours"
            tip="Money sitting in the offset that isn't yours to keep — a family loan you have to repay, for example. It still cuts home-loan interest while it sits there, but it's left out of net wealth and never auto-invested."
          >
            <NumInput
              value={h.loan.restrictedOffset ?? 0}
              onChange={(n) => setLoan({ restrictedOffset: n })}
            />
          </Field>
          <Field
            label="Rate (%)"
            tip="Home-loan interest rate. A dollar in the offset saves this rate, and that saving isn't taxed."
          >
            <NumInput
              value={h.loan.annualRate * 100}
              digits={2}
              onChange={(n) => setLoan({ annualRate: n / 100 })}
            />
          </Field>
          <Field
            label="Years left"
            tip="Years left on the loan. Used to size the principal-and-interest payment from salary each month."
          >
            <NumInput
              value={h.loan.remainingYears}
              onChange={(n) => setLoan({ remainingYears: n })}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={h.loan.interestOnly}
            onChange={(e) => setLoan({ interestOnly: e.target.checked })}
          />
          <Tip text="Tick if you are not paying down principal each month. Unticked means a principal-and-interest payment sized from balance and years left.">
            Interest-only home loan
          </Tip>
        </label>
      </div>

      <div className="section">
        <h3>
          <Tip text="Once offset is bigger than the home loan, extra dollars save no more interest. The split is not offset. This buys growth shares in your spouse's name with that idle cash. No extra loan.">
            Idle offset
          </Tip>
        </h3>
        <label className="check">
          <input
            type="checkbox"
            checked={h.assumptions.sweepIdleOffset !== false}
            onChange={(e) => setA({ sweepIdleOffset: e.target.checked })}
          />
          <Tip text="Each month, offset above the home balance buys growth shares in your spouse's name. Unlevered. You can turn this off to leave the cash in the offset.">
            Invest offset above the home loan
          </Tip>
        </label>
      </div>

      <details className="assumptions">
        <summary>
          <Tip text="These are not forecasts. They are the return and inflation knobs the ranking uses so you can see which strategy wins if the world looks like this.">
            Return and tax assumptions
          </Tip>
        </summary>
        <div className="grid-2" style={{ marginTop: "0.6rem" }}>
          <Field
            label="Growth, capital % p.a."
            tip="Assumed share-price growth for the growth shares, per year, before fees. Not a forecast."
          >
            <NumInput
              value={h.assumptions.growthAsset.growthRate * 100}
              digits={1}
              onChange={(n) => setGrowth({ growthRate: n / 100 })}
            />
          </Field>
          <Field
            label="Growth, yield % p.a."
            tip="Assumed dividends from the growth shares. Taxed each year even if reinvested."
          >
            <NumInput
              value={h.assumptions.growthAsset.yieldRate * 100}
              digits={1}
              onChange={(n) => setGrowth({ yieldRate: n / 100 })}
            />
          </Field>
          <Field
            label="Income, capital % p.a."
            tip="Assumed share-price growth of the high-yield shares. Usually lower than the growth shares."
          >
            <NumInput
              value={h.assumptions.incomeAsset.growthRate * 100}
              digits={1}
              onChange={(n) => setIncome({ growthRate: n / 100 })}
            />
          </Field>
          <Field
            label="Income, yield % p.a."
            tip="Assumed dividends from the high-yield shares. Taxed at the holder's rate. Franking is applied."
          >
            <NumInput
              value={h.assumptions.incomeAsset.yieldRate * 100}
              digits={1}
              onChange={(n) => setIncome({ yieldRate: n / 100 })}
            />
          </Field>
          <Field
            label="Super return % p.a., before 15%"
            tip="Assumed super return before the fund's 15% earnings tax. The model then takes 15% off this whole return."
          >
            <NumInput
              value={h.assumptions.superReturnRate * 100}
              digits={1}
              onChange={(n) => setA({ superReturnRate: n / 100 })}
            />
          </Field>
          <Field
            label="CPI for CGT indexation %"
            tip="Inflation used to lift the cost base of taxable shares after 1 Jul 2027. You are only taxed on gains above this."
          >
            <NumInput
              value={h.assumptions.inflationRate * 100}
              digits={1}
              onChange={(n) => setA({ inflationRate: n / 100 })}
            />
          </Field>
          <Field
            label="Investment-loan rate %"
            tip="Interest rate on a debt-recycled investment loan. Leave blank to use the home-loan rate."
          >
            <NumInput
              value={
                h.assumptions.investmentLoanRate == null
                  ? undefined
                  : h.assumptions.investmentLoanRate * 100
              }
              digits={2}
              onChange={(n) => setA({ investmentLoanRate: n / 100 })}
              onClear={() => setA({ investmentLoanRate: null })}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={h.assumptions.useNccBringForward}
            onChange={(e) => setA({ useNccBringForward: e.target.checked })}
          />
          <Tip text="If total super is under the threshold, you can pull up to three years of after-tax cap into this year.">
            Use NCC bring-forward if total super allows
          </Tip>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={h.assumptions.refundsToOffset}
            onChange={(e) => setA({ refundsToOffset: e.target.checked })}
          />
          <Tip text="Tax saved from deductible super, and net tax on investments, goes into the offset so it keeps cutting home-loan interest.">
            Park tax refunds and net tax in the offset
          </Tip>
        </label>
      </details>

      <div className="actions">
        <button type="button" onClick={() => void onSave()}>
          Save household
        </button>
      </div>
      <p className="status">{status}</p>
    </>
  );
}

function PersonFields({
  person,
  onChange,
}: {
  person: Person;
  onChange: (p: Partial<Person>) => void;
}) {
  return (
    <div className="grid-2">
      <Field
        label="Taxable income"
        tip="This year's taxable income. Extra income and deductions walk the FY2026-27 brackets from this number. Also caps a deductible super contribution, and Division 293."
      >
        <NumInput
          value={person.taxableIncome}
          onChange={(n) =>
            onChange({ taxableIncome: n, marginalRate: lastDollarPit(n) })
          }
        />
      </Field>
      <Field
        label="Last-dollar PIT %"
        tip="From the FY2026-27 scale on taxable income. Not a flat rate. Medicare is added on top."
      >
        <input
          readOnly
          value={(lastDollarPit(person.taxableIncome) * 100).toFixed(0)}
        />
      </Field>
      <Field
        label="Medicare %"
        tip="Medicare levy, usually 2. Added to the marginal rate for the combined rate used on extra income and CGT."
      >
        <NumInput
          value={person.medicareLevy * 100}
          digits={0}
          onChange={(n) => onChange({ medicareLevy: n / 100 })}
        />
      </Field>
      <Field
        label="Super balance"
        tip="Total super last 30 June. At or above the transfer-balance-linked limit, after-tax contributions are $0."
      >
        <NumInput
          value={person.superBalance}
          onChange={(n) => onChange({ superBalance: n })}
        />
      </Field>
      <Field
        label="Employer SG this FY"
        tip="Full year of Super Guarantee the employer will pay, even if none of the lump goes into super. Sole traders usually leave this at 0."
      >
        <NumInput
          value={person.employerSgThisFy}
          onChange={(n) => onChange({ employerSgThisFy: n })}
        />
      </Field>
      <Field
        label="Extra concessional this FY"
        tip="Salary sacrifice or personal deductible contributions already happening this year, not the lump. A sole trader puts what they already pay themselves here."
      >
        <NumInput
          value={person.extraConcessionalThisFy}
          onChange={(n) => onChange({ extraConcessionalThisFy: n })}
        />
      </Field>
      <Field
        label="Unused CC carry-forward"
        tip="Unused concessional cap from earlier years you can still use. Added to this year's remaining cap."
      >
        <NumInput
          value={person.unusedConcessionalCarryForward}
          onChange={(n) => onChange({ unusedConcessionalCarryForward: n })}
        />
      </Field>
      <Field
        label="Age"
        tip="Used for contribution age limits. After-tax contributions stop at 75 in this model."
      >
        <NumInput
          value={person.age}
          onChange={(n) => onChange({ age: n })}
        />
      </Field>
    </div>
  );
}

function Ledger({
  results,
  selectedId,
  onSelect,
  registerRow,
}: {
  results: ScenarioResult[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  registerRow: (id: string, el: HTMLTableRowElement | null) => void;
}) {
  return (
    <div className="ledger-scroll">
    <table className="ledger">
      <thead>
        <tr>
          <th></th>
          <th>
            <Tip text="A full placement of the lump. Click a row to see its graph and the numbers below.">
              Scenario
            </Tip>
          </th>
          <th style={{ textAlign: "right" }}>
            <Tip text="Household net wealth at the horizon without selling the shares. Super, taxable shares, offset, and cash, minus all loans. House value is left out because it is the same in every row.">
              If held
            </Tip>
          </th>
          <th style={{ textAlign: "right" }}>
            <Tip text="Same as If held, but after paying CGT as if you sold the taxable shares on the last day. Super is not sold. This is how the list is ranked.">
              If sold
            </Tip>
          </th>
          <th style={{ textAlign: "right" }}>
            <Tip text="What you could spend without touching super. Shares, offset, and cash, minus loans. Negative means those liquid bits are still less than the debt.">
              Accessible
            </Tip>
          </th>
        </tr>
      </thead>
      <tbody>
        {results.map((r, i) => (
          <tr
            key={r.id}
            ref={(el) => registerRow(r.id, el)}
            className={`${r.id === selectedId ? "selected" : ""} ${i === 0 ? "winner" : ""}`}
            onClick={() => onSelect(r.id)}
          >
            <td className="rank">{i + 1}</td>
            <td>
              <span className="label">
                {r.label}
                {i === 0 ? (
                  <Tip text="Highest If sold figure in this ranking. Not advice. Just the top row under these assumptions.">
                    <span className="hanko">BEST</span>
                  </Tip>
                ) : null}
              </span>
              <span className="put">{putLine(r.appliedAllocation)}</span>
            </td>
            <td className="num">{money(r.netWealth)}</td>
            <td className="num">{money(r.netIfLiquidated)}</td>
            <td className="num">{money(r.accessible)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function ChartPanel({
  selected,
  baseline,
}: {
  selected: ScenarioResult;
  baseline: ScenarioResult | null;
}) {
  const chart = useMemo(() => {
    const years = selected.years;
    const baseYears = baseline?.years ?? [];
    return years.map((y) => {
      return {
        year: y.year,
        super: y.superTotal,
        investments: y.taxableTotal,
        offset: Math.max(0, y.offset + y.cash),
        homeLoan: -Math.max(0, y.homeLoan),
        investmentLoan: -Math.max(0, y.investmentLoan),
        locked: -Math.max(0, y.restrictedOffset),
        netWealth: y.netWealth,
        offsetBaseline:
          baseYears.find((b) => b.year === y.year)?.netWealth ?? null,
      };
    });
  }, [selected, baseline]);
  const hasLocked = chart.some((c) => c.locked < 0);

  return (
    <div className="chart-wrap">
      <ResponsiveContainer>
        <AreaChart data={chart} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="#b7c2bc" strokeDasharray="3 6" />
          <XAxis dataKey="year" tick={{ fill: "#5c6b66", fontSize: 12 }} />
          <YAxis
            tickFormatter={(v: number) =>
              v >= 1_000_000
                ? `${(v / 1_000_000).toFixed(1)}m`
                : `${Math.round(v / 1000)}k`
            }
            tick={{ fill: "#5c6b66", fontSize: 12 }}
            width={48}
          />
          <Tooltip
            formatter={(v) => money(Number(v ?? 0))}
            labelFormatter={(y) => `Year ${y}`}
            wrapperStyle={{ zIndex: 20 }}
          />
          <Legend />
          <Area
            type="linear"
            stackId="assets"
            dataKey="super"
            name="Super"
            stroke="#243868"
            fill="#243868"
            fillOpacity={0.88}
            isAnimationActive={false}
          />
          <Area
            type="linear"
            stackId="assets"
            dataKey="investments"
            name="Investments"
            stroke="#b8892d"
            fill="#b8892d"
            fillOpacity={0.88}
            isAnimationActive={false}
          />
          <Area
            type="linear"
            stackId="assets"
            dataKey="offset"
            name="Offset (home loan)"
            stroke="#1f6b4a"
            fill="#1f6b4a"
            fillOpacity={0.8}
            isAnimationActive={false}
          />
          <Area
            type="linear"
            stackId="debt"
            dataKey="homeLoan"
            name="Home loan"
            stroke="#a13d2f"
            fill="#a13d2f"
            fillOpacity={0.55}
            isAnimationActive={false}
          />
          <Area
            type="linear"
            stackId="debt"
            dataKey="investmentLoan"
            name="Investment loan"
            stroke="#c2703d"
            fill="#c2703d"
            fillOpacity={0.55}
            isAnimationActive={false}
          />
          {hasLocked ? (
            <Area
              type="linear"
              stackId="debt"
              dataKey="locked"
              name="Locked (not yours)"
              stroke="#6b4c7a"
              fill="#6b4c7a"
              fillOpacity={0.55}
              isAnimationActive={false}
            />
          ) : null}
          <Line
            type="linear"
            dataKey="netWealth"
            name="Net wealth"
            stroke="#141816"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {baseline && baseline.id !== selected.id ? (
            <Line
              type="linear"
              dataKey="offsetBaseline"
              name={baseline.label}
              stroke="#5c6b66"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
            />
          ) : null}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const LUMP_BUCKETS: Record<
  string,
  { who: string; chip: string; what: string; tip: string }
> = {
  offset: {
    who: "Household",
    chip: "offset",
    what: "into the home-loan offset, still spendable",
    tip: "Cash against the mortgage. Cuts interest. You can still take it out.",
  },
  extra_repay: {
    who: "Household",
    chip: "pay down loan",
    what: "into the home loan, pays it down",
    tip: "The cash is gone. Same interest save as the offset, harder to undo.",
  },
  taxable_you_growth: {
    who: "You",
    chip: "your growth shares",
    what: "into growth shares in your name, outside super",
    tip: "Tax on dividends and a sale is at your high rate.",
  },
  taxable_you_income: {
    who: "You",
    chip: "your dividend shares",
    what: "into dividend shares in your name, outside super",
    tip: "Cash each year, taxed at your high rate.",
  },
  taxable_spouse_growth: {
    who: "Spouse",
    chip: "spouse growth shares",
    what: "into growth shares in your spouse's name, outside super",
    tip: "Tax at their lower rate. For tax, it is their money.",
  },
  taxable_spouse_income: {
    who: "Spouse",
    chip: "spouse dividend shares",
    what: "into dividend shares in your spouse's name, outside super",
    tip: "Cash each year, taxed at their lower rate.",
  },
  debt_recycle_you_growth: {
    who: "You",
    chip: "recycle → your growth shares",
    what: "onto the home loan, then redrawn to buy growth shares in your name",
    tip: "Pays down the home loan, then that amount is redrawn as an investment split in your name and used to buy growth shares. Offset is unchanged.",
  },
  debt_recycle_you_income: {
    who: "You",
    chip: "recycle → your dividend shares",
    what: "onto the home loan, then redrawn to buy dividend shares in your name",
    tip: "Same pay-down-then-redraw, but the shares pay cash each year.",
  },
  super_cc_you: {
    who: "You",
    chip: "your super, tax-cut",
    what: "into your super as a tax-cut contribution",
    tip: "Your account, not your spouse's. Shrinks this year's tax at your high rate. Super takes 15% of this amount. Locked until retirement.",
  },
  super_cc_spouse: {
    who: "Spouse",
    chip: "spouse super, tax-cut",
    what: "into your spouse's super as a tax-cut contribution",
    tip: "Their account. Tax refund is at their lower rate, so it saves less than doing this in your name.",
  },
  super_ncc_you: {
    who: "You",
    chip: "your super, after-tax",
    what: "into your super as after-tax money",
    tip: "Your account. No extra tax refund. Tax was already paid. Growth inside is taxed at 15%. Locked.",
  },
  super_ncc_spouse: {
    who: "Spouse",
    chip: "spouse super, after-tax",
    what: "into your spouse's super as after-tax money",
    tip: "Their account. Uses their yearly limit. Tax inside super is still 15%.",
  },
};

function allocationParts(
  a: Record<string, number>,
): { id: string; amount: number }[] {
  return Object.entries(a)
    .filter(([, n]) => n != null && n > 0.5)
    .map(([id, amount]) => ({ id, amount }))
    .sort((x, y) => y.amount - x.amount);
}

function moneyShort(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k >= 100 || k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return money(n);
}

function putLine(a: Record<string, number>): string {
  const parts = allocationParts(a);
  if (!parts.length) return "";
  return parts
    .map((p) => `${moneyShort(p.amount)} ${LUMP_BUCKETS[p.id]?.chip ?? p.id}`)
    .join("  ·  ");
}

function Detail({
  selected,
  household,
}: {
  selected: ScenarioResult;
  household: Household;
}) {
  const cgtDelta = selected.exitCgt - selected.exitCgtIfLegacyDiscount;

  return (
    <section className="detail">
      <h2>{selected.label}</h2>
      <LumpSplit selected={selected} household={household} />
      <p className="summary">{selected.summary}</p>
      <dl className="stats">
        <Stat
          label="Net wealth at horizon"
          tip="Everything this scenario owns at the end of the planning years. Super, taxable shares, offset, cash, minus home loan and any investment loan. The house itself is left out, because its value is the same in every row. Shares are still unsold, so CGT has not been paid yet."
        >
          {money(selected.netWealth)}
        </Stat>
        <Stat
          label="If you sold everything"
          tip="Net wealth after paying CGT as if you sold the taxable shares on the last day. Super is not sold. Use this to compare strategies that would otherwise look rich only on paper."
        >
          {money(selected.netIfLiquidated)}
        </Stat>
        <Stat
          label="Accessible, not super"
          tip="Money you could spend without breaking into super. Taxable shares, offset, and cash, minus loans. Negative means those liquid bits are still smaller than the debt, so the lump is sitting in super."
        >
          {money(selected.accessible)}
        </Stat>
        <Stat
          label="Net debt"
          tip="Home loan plus investment loan minus offset. A negative number means the offset is bigger than the loans, so you are ahead on the mortgage side."
        >
          {money(selected.netDebt)}
        </Stat>
        <Stat
          label="Your super"
          tip="Your super balance at the horizon, including this scenario's contributions and assumed growth after 15% tax in the fund. Preserved until you can access super."
        >
          {money(selected.superYou)}
        </Stat>
        <Stat
          label="Spouse super"
          tip="Their super at the horizon, same rules. Two funds means two preservation clocks and two transfer-balance caps."
        >
          {money(selected.superSpouse)}
        </Stat>
        <Stat
          label="Investments, outside super"
          tip="Shares outside super at the horizon, still unsold. Your name plus spouse's name."
        >
          {money(selected.investmentOutsideSuper)}
          {selected.taxableYou > 1 && selected.taxableSpouse > 1 ? (
            <span className="sub">
              {" "}
              you {money(selected.taxableYou)}, spouse {money(selected.taxableSpouse)}
            </span>
          ) : selected.taxableSpouse > 1 && selected.taxableYou <= 1 ? (
            <span className="sub"> in spouse's name</span>
          ) : selected.taxableYou > 1 ? (
            <span className="sub"> in your name</span>
          ) : null}
        </Stat>
        <Stat
          label="Tax on those if sold"
          tip="Yield tax plus CGT if you sold at the horizon. Does not include the investment-loan deduction against salary."
        >
          {money(selected.investmentTaxIfSold)}
        </Stat>
        <Stat
          label="Yield tax"
          tip="Income tax on dividends over the years. Not CGT."
        >
          {money(selected.investmentIncomeTax)}
        </Stat>
        <Stat
          label="CGT if sold"
          tip="Capital gains tax if you sold the taxable shares on the last day, under the 1 Jul 2027 rules."
        >
          {money(selected.exitCgt)}
        </Stat>
        {cgtDelta > 1 ? (
          <Stat
            label="Extra CGT vs old 50% discount"
            tip="How much more CGT this is than the old 50% discount on the whole nominal gain."
          >
            {money(cgtDelta)}
          </Stat>
        ) : null}
        <Stat
          label="Home loan / offset"
          tip="Remaining home-loan principal and offset balance at the horizon. Offset still cuts interest if it is sitting against the loan."
        >
          {money(selected.homeLoan)} / {money(selected.offset)}
        </Stat>
        <Stat
          label="Investment loan"
          tip="Deductible investment loan from debt recycling. Stays interest-only in this model. Zero if this scenario does not recycle."
        >
          {money(selected.investmentLoan)}
        </Stat>
        <Stat
          label="Net tax, including loan deduction"
          tip="Dividend tax minus the investment-loan interest deduction against salary. Negative means the split saved tax on your wage. Different from tax on the shares if sold."
        >
          {money(selected.totalIncomeTax)}
        </Stat>
      </dl>
      {selected.warnings.length ? (
        <ul className="warn-list">
          {selected.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {selected.notes.length ? (
        <ul className="note-list">
          {selected.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function LumpSplit({
  selected,
  household,
}: {
  selected: ScenarioResult;
  household: Household;
}) {
  const rows = allocationParts(selected.appliedAllocation);
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="lump-split">
      <h3>
        <Tip text="Day one. Which account the lump goes into, and whose name is on it. The numbers further down are after years of growth and loan payments.">
          Put the lump here
        </Tip>
      </h3>
      <div className="lump-bar" aria-hidden="true">
        {rows.map((r) => (
          <span
            key={r.id}
            className={`lump-seg who-${(LUMP_BUCKETS[r.id]?.who ?? "Household").toLowerCase()}`}
            style={{ width: `${(r.amount / Math.max(total, 1)) * 100}%` }}
            title={`${money(r.amount)} ${LUMP_BUCKETS[r.id]?.chip ?? r.id}`}
          />
        ))}
      </div>
      <ul>
        {rows.map((r) => {
          const meta = LUMP_BUCKETS[r.id];
          const extra = lumpExtra(r.id, r.amount, household);
          return (
            <li key={r.id}>
              <span className="lump-amt">{money(r.amount)}</span>
              <span className="lump-body">
                <span className="lump-who">{meta?.who ?? r.id}</span>
                {meta ? <Tip text={meta.tip}>goes {meta.what}</Tip> : r.id}
                {extra ? <span className="lump-extra">{extra}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function lumpExtra(
  id: string,
  amount: number,
  household: Household,
): string | null {
  if (id === "super_cc_you" || id === "super_cc_spouse") {
    const person = id === "super_cc_you" ? household.you : household.spouse;
    const intoFund =
      amount * (1 - household.assumptions.concessionalContributionsTax);
    const ccThis =
      Math.max(0, person.employerSgThisFy) +
      Math.max(0, person.extraConcessionalThisFy) +
      amount;
    const over =
      person.taxableIncome +
      ccThis -
      household.assumptions.div293Threshold;
    const div293 =
      over <= 0 || amount <= 0 ? 0 : Math.min(ccThis, over) * 0.15;
    const refund =
      -taxDelta(person.taxableIncome, -amount, person.medicareLevy) - div293;
    const whose = id === "super_cc_you" ? "your" : "their";
    return `Lands in ${whose} super as about ${money(intoFund)} after the fund's 15%. Tax refund about ${money(refund)} goes to the offset.`;
  }
  if (id === "super_ncc_you") {
    return "Lands in your super in full. No extra tax cut.";
  }
  if (id === "super_ncc_spouse") {
    return "Lands in your spouse's super in full. No extra tax cut.";
  }
  if (id.startsWith("debt_recycle_")) {
    return `Home loan down by ${money(amount)}. ${money(amount)} investment split in your name. Offset unchanged.`;
  }
  return null;
}

const SUPER_OPTIONS: { id: SuperFill; label: string }[] = [
  { id: "none", label: "Skip" },
  { id: "you", label: "Your tax-cut, to cap" },
  { id: "spouse", label: "Spouse tax-cut, to cap" },
  { id: "you_then_spouse", label: "Both tax-cuts, you first" },
];

const AFTER_TAX_OPTIONS: { id: SuperFill; label: string }[] = [
  { id: "none", label: "Skip" },
  { id: "you", label: "Your after-tax, to cap" },
  { id: "spouse", label: "Spouse after-tax, to cap" },
  { id: "you_then_spouse", label: "Both after-tax, you first" },
];

function Mixer({
  household,
  mix,
  mixSum,
  onChange,
}: {
  household: Household;
  mix: Allocation;
  mixSum: number;
  onChange: (m: Allocation) => void;
}) {
  const lump = household.lumpSum;
  const leftover = lump - mixSum;
  const [cc, setCc] = useState<SuperFill>("none");
  const [ncc, setNcc] = useState<SuperFill>("none");
  const [rest, setRest] = useState<(typeof REST_BUCKETS)[number] | "">("");
  const fromStack = useRef(false);
  const groups: { title: string; ids: string[] }[] = [
    { title: "Loan", ids: ["offset", "extra_repay"] },
    {
      title: "Shares outside super",
      ids: [
        "taxable_you_growth",
        "taxable_you_income",
        "taxable_spouse_growth",
        "taxable_spouse_income",
      ],
    },
    {
      title: "Debt recycle",
      ids: ["debt_recycle_you_growth", "debt_recycle_you_income"],
    },
    {
      title: "Super",
      ids: [
        "super_cc_you",
        "super_cc_spouse",
        "super_ncc_you",
        "super_ncc_spouse",
      ],
    },
  ];
  const byId = new Map(MIX_BUCKETS.map((b) => [b.id, b]));

  const applyStack = (
    nextCc: SuperFill,
    nextNcc: SuperFill,
    nextRest: (typeof REST_BUCKETS)[number] | "",
  ) => {
    setCc(nextCc);
    setNcc(nextNcc);
    setRest(nextRest);
    fromStack.current = Boolean(nextRest);
    if (!nextRest) onChange({});
  };

  useEffect(() => {
    if (!fromStack.current || !rest) return;
    onChange(stackAllocation(household, cc, ncc, rest));
  }, [household, cc, ncc, rest, onChange]);

  return (
    <section className="mix-sheet">
      <p className="kicker">
        <Tip text="Three steps fill remaining room, then dump leftover in one bucket. That split is the Yours row. The ranking also tries these stacks itself and keeps the winners as extra rows.">
          Your mix
        </Tip>
      </p>
      <p className="summary">
        Super fills to this year's remaining room, not the whole lump. After-tax
        caps are large, so they can swallow leftover before recycle or shares
        get any. Skip after-tax if you want leftover recycled. Set leftover to
        Don't add a Yours row to hide that row.
      </p>
      <div className="stack-grid">
        <label className="field">
          <span>First, tax-cut</span>
          <select
            value={cc}
            onChange={(e) =>
              applyStack(e.target.value as SuperFill, ncc, rest)
            }
          >
            {SUPER_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Then, after-tax</span>
          <select
            value={ncc}
            onChange={(e) =>
              applyStack(cc, e.target.value as SuperFill, rest)
            }
          >
            {AFTER_TAX_OPTIONS.map((o) => (
              <option key={`ncc-${o.id}`} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Leftover</span>
          <select
            value={rest}
            onChange={(e) => {
              const v = e.target.value as (typeof REST_BUCKETS)[number] | "";
              applyStack(cc, ncc, v);
            }}
          >
            <option value="">Don't add a Yours row</option>
            {REST_BUCKETS.map((id) => (
              <option key={id} value={id}>
                {byId.get(id)?.label ?? id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={`mixer-sum ${mixSum > 0 && leftover < -1 ? "bad" : ""}`}>
        {mixSum <= 0
          ? "Pick a leftover bucket to rank your stack, or type exact dollars below."
          : leftover < -1
            ? `Allocated ${money(mixSum)}. ${money(-leftover)} over the lump.`
            : leftover > 1
              ? `Allocated ${money(mixSum)} of ${money(lump)}; ${money(leftover)} will sit in the offset.`
              : `Allocated ${money(mixSum)} of ${money(lump)}.`}
      </p>
      <details className="assumptions">
        <summary>Type exact dollars</summary>
        <div className="mix-groups" style={{ marginTop: "0.8rem" }}>
          {groups.map((g) => (
            <div key={g.title} className="mix-group">
              <h3>{g.title}</h3>
              <div className="mixer-grid">
                {g.ids.map((id) => {
                  const b = byId.get(id);
                  if (!b) return null;
                  return (
                    <MixerRow
                      key={b.id}
                      label={b.label}
                      tip={b.tip}
                      value={mix[b.id] ?? 0}
                      onChange={(n) => {
                        fromStack.current = false;
                        onChange({ ...mix, [b.id]: n });
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function MixerRow({
  label,
  tip,
  value,
  onChange,
}: {
  label: string;
  tip: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <>
      <Tip text={tip}>{label}</Tip>
      <NumInput
        value={value}
        blankZero
        onChange={onChange}
      />
    </>
  );
}

function Stat({
  label,
  tip,
  children,
}: {
  label: string;
  tip: string;
  children: React.ReactNode;
}) {
  return (
    <div className="stat">
      <dt>
        <Tip text={tip}>{label}</Tip>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function Explainers({ items }: { items: Explainer[] }) {
  return (
    <section className="explainers">
      <h2>How to read the ranking</h2>
      {items.map((e) => (
        <article key={e.id} className="explainer">
          <h3>{e.title}</h3>
          <p>{e.body}</p>
        </article>
      ))}
    </section>
  );
}
