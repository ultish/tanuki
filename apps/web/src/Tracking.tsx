import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  clearActual,
  deleteTracker,
  fetchOpening,
  fetchRisuLink,
  fetchRisuPortfolios,
  fetchRisuTickers,
  fetchTracker,
  listTrackers,
  pullRisu,
  replan,
  replanPreview,
  saveActual,
  saveRisuLink,
  setTrackerRisu,
  type ActualMonth,
  type Allocation,
  type Flows,
  type HoldingKey,
  type Household,
  type MonthRow,
  type OpeningSummary,
  type RisuLink,
  type RisuLinkState,
  type RisuTicker,
  type RunReport,
  type TrackerSummary,
  type TrackerView,
} from "./api";
import { money } from "./format";
import { Field, NumInput, Stat, Tip } from "./ui";

type TrackerMonth = TrackerView["months"][number];

type Metric = "netWealth" | "taxableTotal" | "offset" | "superTotal" | "homeLoan";
const METRICS: { id: Metric; label: string }[] = [
  { id: "netWealth", label: "Net wealth" },
  { id: "taxableTotal", label: "Shares outside super" },
  { id: "offset", label: "Offset" },
  { id: "superTotal", label: "Super" },
  { id: "homeLoan", label: "Home loan" },
];

const FLOW_LABELS: Record<string, string> = {
  extra_repay: "Paid off the home loan",
  taxable_you_growth: "Growth shares, your name",
  taxable_you_income: "Dividend shares, your name",
  taxable_spouse_growth: "Growth shares, spouse's name",
  taxable_spouse_income: "Dividend shares, spouse's name",
  debt_recycle_you_growth: "Debt recycle → growth",
  debt_recycle_you_income: "Debt recycle → dividend",
  super_cc_you: "Tax-cut into your super",
  super_cc_spouse: "Tax-cut into spouse super",
  super_ncc_you: "After-tax into your super",
  super_ncc_spouse: "After-tax into spouse super",
  sweep: "Idle offset → spouse growth",
};

/** Buckets that buy or sell shares outside super — the ones risu covers. */
const SHARE_FLOWS = new Set([
  "taxable_you_growth",
  "taxable_you_income",
  "taxable_spouse_growth",
  "taxable_spouse_income",
  "debt_recycle_you_growth",
  "debt_recycle_you_income",
  "sweep",
]);

const HOLDINGS: { key: HoldingKey; label: string }[] = [
  { key: "you_growth", label: "Your growth shares" },
  { key: "you_income", label: "Your dividend shares" },
  { key: "spouse_growth", label: "Spouse growth shares" },
  { key: "spouse_income", label: "Spouse dividend shares" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(key: string): string {
  return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function nextMonth(key: string): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function signedMoney(n: number): string {
  if (Math.abs(n) < 0.5) return "—";
  return `${n > 0 ? "+" : "−"}${money(Math.abs(n))}`;
}

function axisMoney(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}m` : `${Math.round(a / 1000)}k`;
  return v < 0 ? `-${s}` : s;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Tracking({
  household,
  openId,
  onOpened,
}: {
  household: Household;
  openId: string | null;
  onOpened: () => void;
}) {
  const [list, setList] = useState<TrackerSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<TrackerView | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [link, setLink] = useState<RisuLinkState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const l = await listTrackers();
    setList(l);
    return l;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [l, k] = await Promise.all([refreshList(), fetchRisuLink()]);
        setLink(k);
        setSelectedId((prev) => {
          if (openId && l.some((t) => t.id === openId)) return openId;
          if (prev && l.some((t) => t.id === prev)) return prev;
          return l[0]?.id ?? null;
        });
        if (openId) onOpened();
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, [openId, onOpened, refreshList]);

  const reload = useCallback(async () => {
    if (!selectedId) {
      setView(null);
      return;
    }
    try {
      setView(await fetchTracker(selectedId));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [selectedId]);

  useEffect(() => {
    setMonth(null);
    void reload();
  }, [reload]);

  const labelOf = (id: string | undefined) => list?.find((t) => t.id === id)?.label;

  return (
    <div className="spread tracking">
      <aside className="page page-left">
        <p className="kicker">
          <Tip text="Each one is a frozen target. What actually happened is logged once, per month, and every plan reads the same log.">
            Plans you're tracking
          </Tip>
        </p>
        {list == null ? (
          <p className="status">Loading…</p>
        ) : list.length === 0 ? (
          <p className="plan-tip">
            Nothing yet. Pick a scenario under Plans, open it, and use{" "}
            <em>Track this plan</em>.
          </p>
        ) : (
          <ul className="tracker-list">
            {list.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className={t.id === selectedId ? "on" : ""}
                  aria-pressed={t.id === selectedId}
                  onClick={() => setSelectedId(t.id)}
                >
                  <span className="tracker-name">{t.label}</span>
                  <span className="tracker-sub">
                    {t.scenarioLabel} · from {monthLabel(t.startDate)}
                    {t.parentId ? ` · re-plan of ${labelOf(t.parentId) ?? "a deleted plan"}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="plan-tip">
          Re-forecasts use the <em>saved</em> household's pay and rate changes.
          Save the household after adding one.
        </p>
        <RisuLinkPanel link={link} onSaved={setLink} />
      </aside>
      <main className="page page-right">
        {error ? <p className="warn-list">{error}</p> : null}
        {view ? (
          <TrackerDetail
            key={view.tracker.id}
            view={view}
            household={household}
            parentLabel={labelOf(view.tracker.parentId)}
            month={month}
            onMonth={setMonth}
            link={link}
            onView={setView}
            onChanged={reload}
            onDeleted={async () => {
              const l = await refreshList();
              setSelectedId(l[0]?.id ?? null);
            }}
            onReplanned={async (id) => {
              await refreshList();
              setSelectedId(id);
            }}
          />
        ) : list?.length ? (
          <p className="status">Loading the plan…</p>
        ) : null}
      </main>
    </div>
  );
}

function TrackerDetail({
  view,
  household,
  parentLabel,
  month,
  onMonth,
  link,
  onView,
  onChanged,
  onDeleted,
  onReplanned,
}: {
  view: TrackerView;
  household: Household;
  parentLabel: string | undefined;
  month: string | null;
  onMonth: (m: string | null) => void;
  link: RisuLinkState | null;
  onView: (v: TrackerView) => void;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onReplanned: (id: string) => Promise<void>;
}) {
  const t = view.tracker;
  const first = view.months[0]!;
  const last = view.months.at(-1)!;
  const focus = focusMonth(view, month);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tracked = t.risuPortfolios.filter((id) => link?.portfolios.some((p) => p.id === id));
  const risuReady = Boolean(link?.configured && tracked.length);

  return (
    <section className="detail tracker-detail">
      <h2>{t.label}</h2>
      <p className="summary">
        {t.scenarioLabel}. {monthLabel(first.date)} to {monthLabel(last.date)}
        {t.parentId ? `, re-planned from ${parentLabel ?? "a deleted plan"}` : ""}.
      </p>
      <dl className="stats">
        <Stat
          label="The plan, if sold at the end"
          tip="What you accepted: net wealth at the end after CGT on the shares, as projected the day you started tracking. It never moves."
        >
          {money(view.end.plan.netIfLiquidated)}
        </Stat>
        <Stat
          label="Re-forecast"
          tip="From where the log says you actually are, carrying on with the plan's own rules. Uses the pay and rate changes you've recorded."
        >
          {money(view.end.reforecast.netIfLiquidated)}{" "}
          <span className="delta">
            {signedMoney(view.end.reforecast.netIfLiquidated - view.end.plan.netIfLiquidated)}
          </span>
        </Stat>
        <Stat
          label="The plan at today's rates"
          tip="The original plan re-run with the rate and pay changes recorded since, and nothing you logged. The gap between this and the plan is the world moving; the gap between this and the re-forecast is what you did differently."
        >
          {money(view.end.todaysRates.netIfLiquidated)}{" "}
          <span className="delta">
            {signedMoney(view.end.todaysRates.netIfLiquidated - view.end.plan.netIfLiquidated)}
          </span>
        </Stat>
        <Stat
          label="Logged through"
          tip="The last month with anything logged. Months after it are projection."
        >
          {view.lastLogged ? monthLabel(view.lastLogged) : "Nothing yet"}
        </Stat>
      </dl>

      <TrackerChart
        view={view}
        selected={focus}
        onSelect={(d) => {
          if (d <= thisMonth()) onMonth(d);
        }}
      />

      {link?.configured && link.portfolios.length ? (
        <div className="risu-pick">
          <span className="events-head">
            <Tip text="Optional. Tick the risu portfolios whose real parcels stand in for this plan's shares. Only the people who own a ticked portfolio are taken from risu; everyone else's shares stay typed or projected. Tick none to ignore risu for this plan.">
              Shares from risu
            </Tip>
          </span>
          {link.portfolios.map((p) => (
            <label className="check" key={p.id}>
              <input
                type="checkbox"
                checked={tracked.includes(p.id)}
                onChange={async (e) => {
                  const next = e.target.checked
                    ? [...tracked, p.id]
                    : tracked.filter((id) => id !== p.id);
                  onView(await setTrackerRisu(t.id, next));
                }}
              />
              {p.name ?? `Portfolio ${p.id}`} ({p.personId === "you" ? "you" : "spouse"}
              {p.purpose === "debt_recycle" ? ", debt-recycled" : ""})
            </label>
          ))}
        </div>
      ) : null}

      <LogPanel
        view={view}
        month={month}
        onMonth={onMonth}
        risuReady={risuReady}
        onChanged={onChanged}
      />

      <Replan view={view} household={household} onReplanned={onReplanned} />

      <div className="actions">
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                await deleteTracker(t.id);
                await onDeleted();
              }}
            >
              Delete {t.label}
            </button>
            <button type="button" className="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="ghost" onClick={() => setConfirmDelete(true)}>
            Delete this plan…
          </button>
        )}
      </div>
      <p className="plan-tip">Deleting a plan keeps the monthly log; other plans still read it.</p>
    </section>
  );
}

function TrackerChart({
  view,
  selected,
  onSelect,
}: {
  view: TrackerView;
  selected: string | null;
  onSelect: (month: string) => void;
}) {
  const [metric, setMetric] = useState<Metric>("netWealth");
  const [showRates, setShowRates] = useState(false);
  const lastLogged = view.lastLogged;
  const data = useMemo(
    () =>
      view.months.map((m) => ({
        date: m.date,
        plan: m.plan[metric],
        actual: lastLogged && m.date <= lastLogged ? m.reforecast[metric] : null,
        reforecast: !lastLogged || m.date >= lastLogged ? m.reforecast[metric] : null,
        rates: m.todaysRates[metric],
        logged: Boolean(m.actual),
      })),
    [view, metric, lastLogged],
  );
  const now = thisMonth();
  const nowInRange = view.months.some((m) => m.date === now);

  return (
    <>
      <div className="chart-controls">
        <label className="field inline">
          <span>Show</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {METRICS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showRates}
            onChange={(e) => setShowRates(e.target.checked)}
          />
          <Tip text="The original plan, re-run with the rate and pay changes you've recorded, ignoring anything you logged.">
            Plan at today's rates
          </Tip>
        </label>
      </div>
      <div
        className="chart-wrap clickable"
        // Pointer-up, not click: recharts re-renders the hovered point
        // between down and up, and the browser then drops the click.
        onPointerUp={(e) => {
          if (e.button !== 0) return;
          // Month from the pointer's position across the plot area — the
          // category axis spaces months evenly edge to edge.
          const grid = e.currentTarget.querySelector(".recharts-cartesian-grid");
          const r = grid?.getBoundingClientRect();
          if (!r || r.width <= 0 || data.length < 2) return;
          const f = (e.clientX - r.left) / r.width;
          if (f < -0.02 || f > 1.02) return;
          const i = Math.round(Math.min(1, Math.max(0, f)) * (data.length - 1));
          onSelect(data[i]!.date);
        }}
      >
        <ResponsiveContainer>
          <LineChart
            data={data}
            margin={{ top: 8, right: 12, left: 8, bottom: 0 }}
          >
            <CartesianGrid stroke="#b7c2bc" strokeDasharray="3 6" />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => (d.endsWith("-07") ? `FY${d.slice(2, 4)}` : "")}
              interval={0}
              tick={{ fill: "#5c6b66", fontSize: 12 }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={axisMoney}
              tick={{ fill: "#5c6b66", fontSize: 12 }}
              width={52}
              domain={["auto", "auto"]}
            />
            <Tooltip
              formatter={(v) => money(Number(v ?? 0))}
              labelFormatter={(d) => monthLabel(String(d))}
              wrapperStyle={{ zIndex: 20, pointerEvents: "none" }}
            />
            <Legend />
            {nowInRange ? (
              <ReferenceLine x={now} stroke="#b8892d" strokeDasharray="2 3" />
            ) : null}
            {selected ? <ReferenceLine x={selected} stroke="#b8892d" strokeWidth={2} /> : null}
            <Line
              type="linear"
              dataKey="plan"
              name="Plan"
              stroke="#5c6b66"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
            {showRates ? (
              <Line
                type="linear"
                dataKey="rates"
                name="Plan at today's rates"
                stroke="#b8892d"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
            <Line
              type="linear"
              dataKey="reforecast"
              name="Re-forecast"
              stroke="#243868"
              strokeWidth={1.5}
              strokeDasharray="2 3"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            {lastLogged ? (
              <Line
                type="linear"
                dataKey="actual"
                name="Actual"
                stroke="#141816"
                strokeWidth={2.25}
                dot={(p: { cx?: number; cy?: number; index?: number; payload?: { logged?: boolean } }) =>
                  p.payload?.logged && p.cx != null && p.cy != null ? (
                    <circle key={p.index} cx={p.cx} cy={p.cy} r={3} fill="#141816" />
                  ) : (
                    <g key={p.index} />
                  )
                }
                connectNulls={false}
                isAnimationActive={false}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

/**
 * The month the log panel shows: the one you picked, else the oldest month
 * that's started and isn't confirmed, else the latest one that has.
 */
function focusMonth(view: TrackerView, picked: string | null): string | null {
  if (picked) return picked;
  const now = thisMonth();
  const started = view.months.filter((m) => m.date <= now);
  return started.find((m) => !m.actual?.confirmed)?.date ?? started.at(-1)?.date ?? null;
}

function LogPanel({
  view,
  month,
  onMonth,
  risuReady,
  onChanged,
}: {
  view: TrackerView;
  month: string | null;
  onMonth: (m: string | null) => void;
  risuReady: boolean;
  onChanged: () => Promise<void>;
}) {
  const now = thisMonth();
  const started = view.months.filter((m) => m.date <= now);
  const due = started.filter((m) => !m.actual?.confirmed);
  const focus = focusMonth(view, month);
  const i = started.findIndex((m) => m.date === focus);
  const row = i >= 0 ? started[i]! : null;
  // Months that are over, still open, and not the one on screen.
  const rest = due.filter((m) => m.date < now && m.date !== focus);
  const [busy, setBusy] = useState(false);

  if (!started.length) {
    return (
      <p className="plan-tip">
        This plan starts in {monthLabel(view.months[0]!.date)}. Nothing to log yet.
      </p>
    );
  }

  return (
    <>
      <div className="up-next">
        <span className="events-head">
          {due.length === 0
            ? "All caught up"
            : row && !row.actual?.confirmed && month == null
              ? "Up next"
              : "Editing"}
        </span>
        <span className="plan-tip">
          {due.length === 0
            ? "Every month so far is confirmed. Pick one below or on the chart to change it."
            : `${due.length} month${due.length === 1 ? "" : "s"} to confirm${
                due.some((m) => m.date === now) ? `, including ${monthLabel(now)}, still in progress` : ""
              }.`}
        </span>
        {rest.length ? (
          <button
            type="button"
            className="event-add"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                for (const m of rest) {
                  const { date: _d, risu: _r, ...kept } = m.actual ?? { date: m.date, confirmed: false };
                  await saveActual(m.date, { ...kept, confirmed: true });
                }
                await onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            Nothing else changed? Confirm the other {rest.length} as projected
          </button>
        ) : null}
      </div>

      {row ? (
        <MonthForm
          key={row.date}
          row={row}
          view={view}
          risuReady={risuReady}
          prev={i > 0 ? started[i - 1]!.date : null}
          next={i < started.length - 1 ? started[i + 1]!.date : null}
          onGo={onMonth}
          onConfirmed={() => onMonth(null)}
          onSaved={onChanged}
        />
      ) : null}

      <LoggedMonths view={view} selected={focus} onSelect={onMonth} />
    </>
  );
}

function LoggedMonths({
  view,
  selected,
  onSelect,
}: {
  view: TrackerView;
  selected: string | null;
  onSelect: (m: string) => void;
}) {
  const [all, setAll] = useState(false);
  const logged = view.months.filter((m) => m.actual).reverse();
  if (!logged.length) return null;
  const shown = all ? logged : logged.slice(0, 6);
  return (
    <div className="logged">
      <p className="events-head">
        <Tip text="Every month with something logged, newest first. The gap is net wealth against the frozen plan at the end of that month. Click one to change it.">
          Logged
        </Tip>
      </p>
      <ul>
        {shown.map((m) => {
          const gap = m.reforecast.netWealth - m.plan.netWealth;
          return (
            <li key={m.date}>
              <button
                type="button"
                className={m.date === selected ? "on" : ""}
                onClick={() => onSelect(m.date)}
              >
                <span className="logged-month">
                  {monthLabel(m.date)}
                  {m.actual?.confirmed ? " ✓" : ""}
                </span>
                <span className="logged-what">
                  {money(m.reforecast.invested)} invested
                  {Math.abs(m.reforecast.invested - m.plan.invested) > 0.5
                    ? ` (plan ${money(m.plan.invested)})`
                    : ""}
                  {m.actual?.risu ? " · risu" : ""}
                  {m.actual?.note ? ` · ${m.actual.note}` : ""}
                </span>
                <span className={`logged-gap${gap < -0.5 ? " neg" : ""}`}>
                  {signedMoney(gap)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {logged.length > shown.length ? (
        <button type="button" className="event-add" onClick={() => setAll(true)}>
          Show all {logged.length}
        </button>
      ) : null}
    </div>
  );
}

type Draft = Record<string, number | undefined>;

/** Form keys: "flow:<bucket>", "bal:<field>", "share:<holding>". */
function storedDraft(a: ActualMonth | undefined): Draft {
  const d: Draft = {};
  for (const [k, v] of Object.entries(a?.flows ?? {})) d[`flow:${k}`] = v;
  const { shares, ...rest } = a?.balances ?? {};
  for (const [k, v] of Object.entries(rest)) d[`bal:${k}`] = v as number;
  for (const [k, v] of Object.entries(shares ?? {})) d[`share:${k}`] = v;
  return d;
}

function projected(row: MonthRow, key: string): number {
  const [kind, name] = key.split(":") as [string, string];
  if (kind === "flow") return row.flows[name as keyof Flows] ?? 0;
  if (kind === "share") return row.shares[name as HoldingKey] ?? 0;
  if (name === "investmentLoan") return row.investmentLoan;
  return (row as unknown as Record<string, number>)[name] ?? 0;
}

function MonthForm({
  row,
  view,
  risuReady,
  prev,
  next,
  onGo,
  onConfirmed,
  onSaved,
}: {
  row: TrackerMonth;
  view: TrackerView;
  risuReady: boolean;
  prev: string | null;
  next: string | null;
  onGo: (m: string) => void;
  onConfirmed: () => void;
  onSaved: () => Promise<void>;
}) {
  const entry = row.actual;
  const [draft, setDraft] = useState<Draft>(() => storedDraft(entry));
  const [note, setNote] = useState(entry?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const risu = entry?.risu;
  const covers = risu?.covers ?? [];
  const covered = (personId: string) => covers.includes(personId as "you" | "spouse");
  const bucketPerson = (k: string) =>
    k === "sweep" || k.includes("_spouse_") ? "spouse" : "you";

  const planUses = (k: string) => view.months.some((m) => (m.plan.flows as Record<string, number>)[k]);
  const flowKeys = Object.keys(FLOW_LABELS).filter(
    (k) =>
      k === "super_cc_you" ||
      (view.tracker.allocation as Record<string, number>)[k] ||
      planUses(k) ||
      draft[`flow:${k}`] != null,
  );
  const holdingKeys = HOLDINGS.filter(
    (h) =>
      view.months.some((m) => m.plan.shares[h.key] > 0 || m.reforecast.shares[h.key] > 0) ||
      draft[`share:${h.key}`] != null,
  );
  const showInvLoan = view.months.some((m) => m.plan.investmentLoan > 0) || draft["bal:investmentLoan"] != null;

  // Risu is authoritative for shares: show what it says, read-only.
  const risuHoldings = useMemo(() => {
    if (!risu) return null;
    const out: Record<string, number> = {};
    for (const l of risu.lots) {
      if (l.acquiredDate < view.tracker.planSince) continue;
      const k = `${l.personId}_${l.sleeve}`;
      out[k] = (out[k] ?? 0) + l.value;
    }
    return out;
  }, [risu, view.tracker.planSince]);
  const risuFlows = useMemo(() => {
    if (!risu) return null;
    const out: Record<string, number> = {};
    for (const t of risu.trades) {
      if (t.amount < 0 && t.acquiredDate && t.acquiredDate < view.tracker.planSince) continue;
      out[t.bucket] = (out[t.bucket] ?? 0) + t.amount;
    }
    return out;
  }, [risu, view.tracker.planSince]);

  const value = (key: string) => draft[key] ?? projected(row.reforecast, key);
  const set = (key: string, v: number | undefined) =>
    setDraft((d) => {
      const next = { ...d };
      if (v == null) delete next[key];
      else next[key] = v;
      return next;
    });

  const build = (confirmed: boolean): Omit<ActualMonth, "date"> => {
    const flows: Record<string, number> = {};
    const balances: Record<string, number> = {};
    const shares: Record<string, number> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (v == null) continue;
      const [kind, name] = k.split(":") as [string, string];
      if (
        risu &&
        ((kind === "flow" && SHARE_FLOWS.has(name) && covered(bucketPerson(name))) ||
          (kind === "share" && covered(name.split("_")[0]!)))
      ) {
        continue;
      }
      if (kind === "flow") flows[name] = v;
      else if (kind === "share") shares[name] = v;
      else balances[name] = v;
    }
    return {
      confirmed,
      flows,
      balances: { ...balances, ...(Object.keys(shares).length ? { shares } : {}) },
      note,
    };
  };

  /** `fn` may return a message to show instead of `done` (e.g. risu warnings). */
  const run = async (fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      const said = await fn();
      await onSaved();
      setMessage(typeof said === "string" ? said : done ?? null);
      return true;
    } catch (e) {
      setMessage(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // A render function, not a component: a component defined in here would
  // remount on every keystroke and drop the input's focus.
  const field = (k: string, label: string, readOnly?: number) => {
    const stored = draft[k] != null;
    const plan = projected(row.plan, k);
    return (
      <div key={k} className={`month-field${stored ? " stored" : ""}`}>
        <span className="month-label">{label}</span>
        {readOnly != null ? (
          <input readOnly value={money(readOnly)} />
        ) : (
          <NumInput
            value={value(k)}
            digits={0}
            onChange={(n) => set(k, n)}
            onClear={() => set(k, undefined)}
          />
        )}
        <span className="month-plan" title="What the frozen plan said for this month">
          plan {money(plan)}
        </span>
        {stored && readOnly == null ? (
          <button
            type="button"
            className="event-x"
            title="Use the projection instead"
            aria-label={`Use the projection for ${label}`}
            onClick={() => set(k, undefined)}
          >
            ↺
          </button>
        ) : (
          <span />
        )}
      </div>
    );
  };

  return (
    <div className="month-form">
      <div className="month-form-head">
        <button
          type="button"
          className="month-step"
          aria-label="Previous month"
          disabled={!prev}
          onClick={() => prev && onGo(prev)}
        >
          ‹
        </button>
        <h3>{monthLabel(row.date)}</h3>
        <button
          type="button"
          className="month-step"
          aria-label="Next month"
          disabled={!next}
          onClick={() => next && onGo(next)}
        >
          ›
        </button>
        <span className="plan-tip">
          {entry?.confirmed ? "Confirmed." : entry ? "Logged, not confirmed." : "Nothing logged — showing the projection."}{" "}
          Change only what differs; the rest follows the projection.
        </span>
      </div>

      <p className="events-head">
        <Tip text="Net dollars that went in this month, by bucket. A sell is negative. Month one is the lump itself; anything you don't place stays in the offset.">
          What you did
        </Tip>
      </p>
      <div className="month-grid">
        {flowKeys.map((k) =>
          field(
            `flow:${k}`,
            FLOW_LABELS[k]!,
            risuFlows && SHARE_FLOWS.has(k) && covered(bucketPerson(k)) ? risuFlows[k] ?? 0 : undefined,
          ),
        )}
      </div>

      <p className="events-head">
        <Tip text="Where you ended up, at the end of the month. A share balance is the market moving: it rescales the parcels you hold and keeps their cost and dates.">
          Where you ended up
        </Tip>
      </p>
      <div className="month-grid">
        {field("bal:offset", "Offset")}
        {field("bal:homeLoan", "Home loan")}
        {showInvLoan ? field("bal:investmentLoan", "Investment loan") : null}
        {field("bal:superYou", "Your super")}
        {holdingKeys.map((h) =>
          field(
            `share:${h.key}`,
            h.label,
            risuHoldings && covered(h.key.split("_")[0]!) ? risuHoldings[h.key] ?? 0 : undefined,
          ),
        )}
      </div>

      {risu ? (
        <p className="plan-tip">
          Shares pulled from risu {new Date(risu.pulledAt).toLocaleString("en-AU")}:{" "}
          {risu.lots.length} parcels, {risu.trades.length} trades. Parcels bought
          before {monthLabel(view.tracker.planSince)} aren't counted.
        </p>
      ) : null}

      <label className="field">
        <span>Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything worth remembering" />
      </label>

      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (await run(() => saveActual(row.date, build(true)), "Confirmed.")) onConfirmed();
          }}
        >
          {Object.keys(draft).length || note !== (entry?.note ?? "") ? "Confirm month" : "Confirm as projected"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => run(() => saveActual(row.date, build(false)), "Saved.")}
        >
          Save, not confirmed
        </button>
        {risuReady ? (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await pullRisu(row.date);
                return r.warnings.length
                  ? `Pulled from risu. ${r.warnings.join(" ")}`
                  : "Pulled from risu.";
              })
            }
          >
            {risu ? "Re-pull from risu" : "Pull shares from risu"}
          </button>
        ) : null}
        {entry ? (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => run(() => clearActual(row.date), "Cleared.")}
          >
            Clear month
          </button>
        ) : null}
      </div>
      {message ? <p className="status">{message}</p> : null}
    </div>
  );
}

function allocationLine(a: Allocation): string {
  return Object.entries(a)
    .filter(([, v]) => v > 0.5)
    .map(([k, v]) => `${money(v)} ${k === "offset" ? "offset" : (FLOW_LABELS[k] ?? k).toLowerCase()}`)
    .join(", ");
}

function Replan({
  view,
  household,
  onReplanned,
}: {
  view: TrackerView;
  household: Household;
  onReplanned: (id: string) => Promise<void>;
}) {
  const first = view.months[0]!.date;
  const last = view.months.at(-1)!.date;
  const suggested = (() => {
    const m = view.lastLogged ? nextMonth(view.lastLogged) : thisMonth();
    return m <= first ? nextMonth(first) : m > last ? last : m;
  })();
  const [at, setAt] = useState(suggested);
  const [opening, setOpening] = useState<OpeningSummary | null>(null);
  const [deploy, setDeploy] = useState(0);
  const [report, setReport] = useState<RunReport | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setPick(null);
    fetchOpening(view.tracker.id, at)
      .then((o) => {
        if (cancelled) return;
        setOpening(o);
        setDeploy(Math.floor(o.deployable));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setOpening(null);
        setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [view, at]);

  const chosen = report?.results.find((r) => r.id === pick) ?? null;

  return (
    <details className="assumptions plan">
      <summary>
        <Tip text="Start a new plan from a month, from wherever the log says you are then. You choose how much of the offset to put to work and which strategy places it. This plan stays as the original promise.">
          Re-plan from a month
        </Tip>
      </summary>
      <div className="grid-2" style={{ marginTop: "0.6rem" }}>
        <Field label="Starting" tip="The first month of the new plan. Everything up to the month before comes from the log.">
          <input
            type="month"
            value={at}
            min={nextMonth(first)}
            max={last}
            onChange={(e) => e.target.value && setAt(e.target.value)}
          />
        </Field>
        <Field
          label="Money to place"
          tip="Taken out of the offset and placed by the strategy you pick. Up to the offset above the restricted floor. Zero re-baselines the same plan from here."
        >
          <NumInput value={deploy} onChange={(n) => setDeploy(Math.max(0, n))} />
        </Field>
      </div>
      {opening ? (
        <p className="plan-tip">
          At the start of {monthLabel(at)}: offset {money(opening.offset)} (
          {money(opening.deployable)} movable), home loan {money(opening.homeLoan)}
          {opening.investmentLoan > 0.5 ? `, investment loan ${money(opening.investmentLoan)}` : ""}, shares{" "}
          {money(opening.shares)}, super {money(opening.superYou + opening.superSpouse)}.
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="ghost"
          disabled={busy || !opening}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await replanPreview(view.tracker.id, at, deploy);
              setReport(r);
              setPick(r.results[0]?.id ?? null);
              setLabel(`${view.tracker.label}, from ${monthLabel(at)}`);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Show strategies
        </button>
      </div>
      {report ? (
        <>
          <ul className="replan-list">
            {report.results.slice(0, 10).map((r, i) => (
              <li key={r.id}>
                <label className="check">
                  <input
                    type="radio"
                    name="replan-pick"
                    checked={pick === r.id}
                    onChange={() => setPick(r.id)}
                  />
                  <span>
                    <strong>{i + 1}. {r.label}</strong> — {money(r.netIfLiquidated)} if sold at the end
                    <span className="tracker-sub">{allocationLine(r.appliedAllocation) || "Nothing placed"}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <Field label="Name" tip="What to call the new plan.">
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <div className="actions">
            <button
              type="button"
              disabled={busy || !chosen}
              onClick={async () => {
                if (!chosen) return;
                setBusy(true);
                try {
                  const v = await replan(view.tracker.id, {
                    at,
                    deploy,
                    allocation: chosen.appliedAllocation,
                    scenarioLabel: chosen.label,
                    label,
                  });
                  await onReplanned(v.tracker.id);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Start the new plan
            </button>
          </div>
        </>
      ) : null}
      {error ? <p className="warn-list">{error}</p> : null}
      {household.loan.restrictedOffset ? (
        <p className="plan-tip">
          {money(household.loan.restrictedOffset)} of the offset isn't yours and can't be placed.
        </p>
      ) : null}
    </details>
  );
}

function RisuLinkPanel({
  link,
  onSaved,
}: {
  link: RisuLinkState | null;
  onSaved: (l: RisuLinkState) => void;
}) {
  const [portfolios, setPortfolios] = useState<{ id: number; name: string }[] | null>(null);
  const [draft, setDraft] = useState<RisuLink>({ portfolios: [], tickers: {} });
  const [tickers, setTickers] = useState<RisuTicker[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (link) setDraft({ portfolios: link.portfolios, tickers: link.tickers });
  }, [link]);

  if (!link) return null;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const saved = await saveRisuLink(draft);
    onSaved({ ...link, ...saved });
    setMessage("Saved.");
  };

  const rowFor = (id: number) => draft.portfolios.find((p) => p.id === id);
  const setPortfolio = (id: number, name: string, patch: Partial<RisuLink["portfolios"][number]> | null) =>
    setDraft((d) => {
      const rest = d.portfolios.filter((p) => p.id !== id);
      if (!patch) return { ...d, portfolios: rest };
      const prev = d.portfolios.find((p) => p.id === id) ?? { id, name, personId: "you" as const, purpose: "taxable" as const };
      return { ...d, portfolios: [...rest, { ...prev, ...patch }].sort((a, b) => a.id - b.id) };
    });

  return (
    <details className="assumptions">
      <summary>
        <Tip text="Pull real share parcels and trades from risu instead of typing share figures. Tanuki reads risu's HTTP API only, never its database.">
          Risu link
        </Tip>
      </summary>
      {!link.configured ? (
        <p className="plan-tip">
          Set <code>RISU_URL</code> on the tanuki server (on hana-server,{" "}
          <code>http://127.0.0.1:8788</code>) to link risu.
        </p>
      ) : (
        <>
          <p className="plan-tip">Reading {link.url}.</p>
          <div className="actions">
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => act(async () => setPortfolios(await fetchRisuPortfolios()))}
            >
              Load portfolios
            </button>
          </div>
          {(portfolios ?? draft.portfolios.map((p) => ({ id: p.id, name: p.name ?? `#${p.id}` }))).map((p) => {
            const row = rowFor(p.id);
            return (
              <div className="risu-row" key={p.id}>
                <span className="month-label">{p.name}</span>
                <select
                  aria-label={`${p.name} belongs to`}
                  value={row?.personId ?? ""}
                  onChange={(e) =>
                    setPortfolio(
                      p.id,
                      p.name,
                      e.target.value ? { personId: e.target.value as "you" | "spouse", name: p.name } : null,
                    )
                  }
                >
                  <option value="">Not linked</option>
                  <option value="you">You</option>
                  <option value="spouse">Spouse</option>
                </select>
                <select
                  aria-label={`${p.name} holds`}
                  disabled={!row}
                  value={row?.purpose ?? "taxable"}
                  onChange={(e) =>
                    setPortfolio(p.id, p.name, { purpose: e.target.value as "taxable" | "debt_recycle" })
                  }
                >
                  <option value="taxable">Own money</option>
                  <option value="debt_recycle">Debt-recycled</option>
                </select>
              </div>
            );
          })}
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => act(save)}>
              Save link
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy || !draft.portfolios.length}
              onClick={() =>
                act(async () => {
                  await save();
                  setTickers(await fetchRisuTickers());
                })
              }
            >
              Map tickers
            </button>
          </div>
          {tickers ? (
            tickers.length ? (
              <>
                {tickers.map((t) => (
                  <div className="risu-row" key={t.key}>
                    <span className="month-label">{t.key}</span>
                    <select
                      aria-label={`${t.key} sleeve`}
                      value={draft.tickers[t.key] ?? ""}
                      onChange={(e) =>
                        setDraft((d) => {
                          const next = { ...d.tickers };
                          if (e.target.value) next[t.key] = e.target.value as "growth" | "income";
                          else delete next[t.key];
                          return { ...d, tickers: next };
                        })
                      }
                    >
                      <option value="">—</option>
                      <option value="growth">Growth</option>
                      <option value="income">Income</option>
                    </select>
                  </div>
                ))}
                <div className="actions">
                  <button type="button" disabled={busy} onClick={() => act(save)}>
                    Save tickers
                  </button>
                </div>
              </>
            ) : (
              <p className="plan-tip">No holdings or trades in the linked portfolios since the first plan started.</p>
            )
          ) : null}
          {message ? <p className="status">{message}</p> : null}
        </>
      )}
    </details>
  );
}
