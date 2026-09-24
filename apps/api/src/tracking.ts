import {
  addMonthsIso,
  createReplan,
  createTracker,
  deployable,
  firstOfMonth,
  mapRisuMonth,
  mergeHousehold,
  openingAt,
  replanPreview,
  risuTickerKey,
  upsertActual,
  viewTracker,
  type ActualMonth,
  type Allocation,
  type Household,
  type RisuLink,
  type RisuLotsResponse,
  type Tracker,
} from "@tanuki/core";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getJson, setJson } from "./db.js";

const MONTH = /^\d{4}-\d{2}$/;

/** Risu's base URL. Tanuki only ever talks to risu over its HTTP API. */
function risuUrl(): string | null {
  const u = process.env.RISU_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

class RisuError extends Error {}

async function risuGet<T>(path: string): Promise<T> {
  const base = risuUrl();
  if (!base) throw new RisuError("RISU_URL is not set, so tanuki can't reach risu.");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new RisuError(
      `Couldn't reach risu at ${base}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new RisuError(`Risu answered ${res.status} for ${path}: ${await res.text()}`);
  }
  // An older risu without the route serves its web app for unknown paths,
  // with a 200 — so check we actually got data back.
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    throw new RisuError(
      `Risu at ${base} doesn't have ${path.split("?")[0]} yet — it needs the version with the parcels route deployed.`,
    );
  }
  return (await res.json()) as T;
}

function lastDayOfMonth(month: string): string {
  const next = addMonthsIso(`${month}-01`, 1);
  const d = new Date(`${next}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** An entry with nothing in it is the same as no entry. */
function isBlank(a: ActualMonth): boolean {
  return (
    !a.confirmed &&
    !a.note?.trim() &&
    !a.risu &&
    !Object.keys(a.flows ?? {}).length &&
    !Object.keys(a.balances ?? {}).filter((k) => k !== "shares").length &&
    !Object.keys(a.balances?.shares ?? {}).length
  );
}

function cleanNumbers<T extends Record<string, unknown>>(o: T | undefined): Partial<T> | undefined {
  if (!o || typeof o !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? (out as Partial<T>) : undefined;
}

/**
 * Parse a month entry from a client body. Keeps only well-formed numbers.
 * Risu data never comes from the client — plans see a narrowed copy of it —
 * so the stored pull is kept as is.
 */
function parseActual(month: string, body: Partial<ActualMonth>): ActualMonth {
  const entry: ActualMonth = { date: month, confirmed: Boolean(body.confirmed) };
  const flows = cleanNumbers(body.flows as Record<string, unknown>);
  if (flows) entry.flows = flows;
  const b = body.balances;
  if (b && typeof b === "object") {
    const { shares, ...rest } = b;
    const balances: NonNullable<ActualMonth["balances"]> = {
      ...(cleanNumbers(rest as Record<string, unknown>) ?? {}),
    };
    const s = cleanNumbers(shares as Record<string, unknown>);
    if (s) balances.shares = s;
    if (Object.keys(balances).length) entry.balances = balances;
  }
  if (typeof body.note === "string" && body.note.trim()) entry.note = body.note.trim();
  return entry;
}

function portfolioIds(raw: unknown): number[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((n): n is number => Number.isInteger(n)))] : [];
}

export function registerTrackingRoutes(
  app: Hono,
  deps: { db: () => Database.Database; loadHousehold: () => Household },
): void {
  const loadLog = () => getJson<ActualMonth[]>(deps.db(), "actuals") ?? [];
  const saveLog = (log: ActualMonth[]) => setJson(deps.db(), "actuals", log);
  const loadTrackers = () => getJson<Tracker[]>(deps.db(), "trackers") ?? [];
  const saveTrackers = (t: Tracker[]) => setJson(deps.db(), "trackers", t);
  const loadLink = (): RisuLink =>
    getJson<RisuLink>(deps.db(), "risuLink") ?? { portfolios: [], tickers: {} };

  const findTracker = (id: string) => loadTrackers().find((t) => t.id === id);

  // ── The household log ────────────────────────────────────────────────────

  app.get("/api/actuals", (c) => c.json(loadLog()));

  app.put("/api/actuals/:month", async (c) => {
    const month = c.req.param("month");
    if (!MONTH.test(month)) return c.json({ error: "Month must be yyyy-mm." }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Partial<ActualMonth>;
    const log = loadLog();
    const entry = parseActual(month, body);
    const stored = log.find((a) => a.date === month)?.risu;
    if (stored) entry.risu = stored;
    const next = isBlank(entry)
      ? log.filter((a) => a.date !== month)
      : upsertActual(log, entry);
    saveLog(next);
    return c.json(isBlank(entry) ? null : entry);
  });

  app.delete("/api/actuals/:month", (c) => {
    const month = c.req.param("month");
    saveLog(loadLog().filter((a) => a.date !== month));
    return c.json({ ok: true });
  });

  /** Re-pull a month's share parcels and trades from risu into the log. */
  app.post("/api/actuals/:month/risu", async (c) => {
    const month = c.req.param("month");
    if (!MONTH.test(month)) return c.json({ error: "Month must be yyyy-mm." }, 400);
    const link = loadLink();
    if (!link.portfolios.length) {
      return c.json({ error: "No risu portfolios are linked yet." }, 400);
    }
    const monthEnd = lastDayOfMonth(month);
    const asOf = monthEnd < today() ? monthEnd : today();
    try {
      const responses = await Promise.all(
        link.portfolios.map(async (p) => ({
          portfolioId: p.id,
          data: await risuGet<RisuLotsResponse>(
            `/api/lots?portfolioId=${p.id}&asOf=${asOf}&since=${month}-01`,
          ),
        })),
      );
      const mapped = mapRisuMonth(link, responses);
      if (mapped.unmapped.length) {
        return c.json(
          {
            error: `Set growth or income for ${mapped.unmapped.join(", ")} before pulling.`,
            unmapped: mapped.unmapped,
          },
          422,
        );
      }
      const log = loadLog();
      const prev = log.find((a) => a.date === month);
      const entry: ActualMonth = {
        ...(prev ?? { date: month, confirmed: false }),
        risu: { pulledAt: new Date().toISOString(), lots: mapped.lots, trades: mapped.trades },
      };
      saveLog(upsertActual(log, entry));
      return c.json({ entry, warnings: mapped.warnings });
    } catch (e) {
      if (e instanceof RisuError) return c.json({ error: e.message }, 502);
      throw e;
    }
  });

  // ── Trackers ─────────────────────────────────────────────────────────────

  app.get("/api/trackers", (c) =>
    c.json(
      loadTrackers().map(({ baseline, opening, ...t }) => ({
        ...t,
        months: baseline.months.length,
      })),
    ),
  );

  app.post("/api/trackers", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      household?: Partial<Household>;
      allocation?: Allocation;
      scenarioLabel?: string;
      label?: string;
      startDate?: string;
      risuPortfolios?: number[];
    };
    if (!body.allocation || !body.startDate) {
      return c.json({ error: "allocation and startDate are required." }, 400);
    }
    let startDate: string;
    try {
      startDate = firstOfMonth(body.startDate);
    } catch {
      return c.json({ error: "startDate must be yyyy-mm or yyyy-mm-dd." }, 400);
    }
    const household = body.household
      ? mergeHousehold(deps.loadHousehold(), body.household)
      : deps.loadHousehold();
    const t = createTracker({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      label: body.label?.trim() || body.scenarioLabel || "Plan",
      scenarioLabel: body.scenarioLabel ?? "Custom",
      allocation: body.allocation,
      startDate,
      household,
      risuPortfolios: portfolioIds(body.risuPortfolios),
    });
    saveTrackers([...loadTrackers(), t]);
    return c.json(viewTracker(t, deps.loadHousehold(), loadLog(), loadLink()), 201);
  });

  app.get("/api/trackers/:id", (c) => {
    const t = findTracker(c.req.param("id"));
    if (!t) return c.json({ error: "No such tracker." }, 404);
    return c.json(viewTracker(t, deps.loadHousehold(), loadLog(), loadLink()));
  });

  /** Which linked risu portfolios feed this plan. A view setting, not part of the frozen target. */
  app.put("/api/trackers/:id/risu", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { portfolios?: number[] };
    const trackers = loadTrackers();
    const t = trackers.find((x) => x.id === c.req.param("id"));
    if (!t) return c.json({ error: "No such tracker." }, 404);
    t.risuPortfolios = portfolioIds(body.portfolios);
    saveTrackers(trackers);
    return c.json(viewTracker(t, deps.loadHousehold(), loadLog(), loadLink()));
  });

  app.delete("/api/trackers/:id", (c) => {
    const id = c.req.param("id");
    saveTrackers(loadTrackers().filter((t) => t.id !== id));
    return c.json({ ok: true });
  });

  app.get("/api/trackers/:id/opening", (c) => {
    const t = findTracker(c.req.param("id"));
    if (!t) return c.json({ error: "No such tracker." }, 404);
    const at = c.req.query("at") ?? "";
    if (!MONTH.test(at)) return c.json({ error: "at must be yyyy-mm." }, 400);
    const h = deps.loadHousehold();
    try {
      const o = openingAt(t, h, loadLog(), at, loadLink());
      return c.json({
        date: o.date,
        offset: o.offset,
        homeLoan: o.homeLoan,
        investmentLoan: o.invLoan,
        superYou: o.superYou,
        superSpouse: o.superSpouse,
        shares: o.lots.reduce((s, l) => s + l.value, 0),
        deployable: deployable(o, h),
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/trackers/:id/replan/preview", async (c) => {
    const t = findTracker(c.req.param("id"));
    if (!t) return c.json({ error: "No such tracker." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { at?: string; deploy?: number };
    if (!body.at || !MONTH.test(body.at)) return c.json({ error: "at must be yyyy-mm." }, 400);
    try {
      return c.json(
        replanPreview(t, deps.loadHousehold(), loadLog(), body.at, Number(body.deploy ?? 0), loadLink()),
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/trackers/:id/replan", async (c) => {
    const parent = findTracker(c.req.param("id"));
    if (!parent) return c.json({ error: "No such tracker." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      at?: string;
      deploy?: number;
      allocation?: Allocation;
      scenarioLabel?: string;
      label?: string;
    };
    if (!body.at || !MONTH.test(body.at) || !body.allocation) {
      return c.json({ error: "at (yyyy-mm) and allocation are required." }, 400);
    }
    try {
      const t = createReplan({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        label: body.label?.trim() || `${parent.label}, re-planned ${body.at}`,
        scenarioLabel: body.scenarioLabel ?? "Custom",
        allocation: body.allocation,
        parent,
        current: deps.loadHousehold(),
        log: loadLog(),
        at: body.at,
        deploy: Number(body.deploy ?? 0),
        link: loadLink(),
      });
      saveTrackers([...loadTrackers(), t]);
      return c.json(viewTracker(t, deps.loadHousehold(), loadLog(), loadLink()), 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // ── Risu link ────────────────────────────────────────────────────────────

  app.get("/api/risu/link", (c) =>
    c.json({ ...loadLink(), configured: risuUrl() != null, url: risuUrl() }),
  );

  app.put("/api/risu/link", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<RisuLink>;
    const portfolios = (Array.isArray(body.portfolios) ? body.portfolios : [])
      .filter(
        (p) =>
          Number.isInteger(p?.id) &&
          (p.personId === "you" || p.personId === "spouse") &&
          (p.purpose === "taxable" || p.purpose === "debt_recycle"),
      )
      .map((p) => ({ id: p.id, name: p.name, personId: p.personId, purpose: p.purpose }));
    const tickers: RisuLink["tickers"] = {};
    for (const [k, v] of Object.entries(body.tickers ?? {})) {
      if (v === "growth" || v === "income") tickers[k.toUpperCase()] = v;
    }
    const link: RisuLink = { portfolios, tickers };
    setJson(deps.db(), "risuLink", link);
    return c.json(link);
  });

  app.get("/api/risu/portfolios", async (c) => {
    try {
      return c.json(await risuGet<{ id: number; name: string }[]>("/api/portfolios"));
    } catch (e) {
      if (e instanceof RisuError) return c.json({ error: e.message }, 502);
      throw e;
    }
  });

  /** Every ticker held or traded in the linked portfolios since the earliest plan, with its sleeve if set. */
  app.get("/api/risu/tickers", async (c) => {
    const link = loadLink();
    const since =
      loadTrackers()
        .map((t) => t.planSince)
        .sort()[0] ?? today();
    try {
      const seen = new Map<string, { key: string; ticker: string; portfolios: number[] }>();
      for (const p of link.portfolios) {
        const data = await risuGet<RisuLotsResponse>(
          `/api/lots?portfolioId=${p.id}&asOf=${today()}&since=${since}`,
        );
        for (const x of [...data.lots, ...data.buys, ...data.disposals]) {
          const key = risuTickerKey(x.exchange, x.ticker);
          const row = seen.get(key) ?? { key, ticker: x.ticker, portfolios: [] };
          if (!row.portfolios.includes(p.id)) row.portfolios.push(p.id);
          seen.set(key, row);
        }
      }
      return c.json(
        [...seen.values()]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((r) => ({ ...r, sleeve: link.tickers[r.key] ?? link.tickers[r.ticker] ?? null })),
      );
    } catch (e) {
      if (e instanceof RisuError) return c.json({ error: e.message }, 502);
      throw e;
    }
  });
}
