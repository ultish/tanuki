import "./env.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  customScenario,
  defaultHousehold,
  EXPLAINERS,
  FY_2026_27,
  mergeHousehold,
  runHousehold,
  type Allocation,
  type Household,
} from "@tanuki/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import fs from "node:fs";
import path from "node:path";
import { getDbPath, getJson, openDb, setJson } from "./db.js";

let db = openDb();
const app = new Hono();

function resolveWebDistAbs(): string | null {
  const candidates = [
    process.env.WEB_DIST_PATH,
    path.resolve(process.cwd(), "../web/dist"),
    path.resolve(process.cwd(), "../../apps/web/dist"),
    path.resolve(process.cwd(), "apps/web/dist"),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      if (fs.existsSync(path.join(p, "index.html"))) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const webDistAbs = resolveWebDistAbs();
const serveWeb = process.env.SERVE_WEB !== "0" && webDistAbs != null;

app.use(
  "*",
  cors({
    origin: [
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
  }),
);

function loadHousehold(): Household {
  const stored = getJson<Household>(db, "household");
  return stored ? mergeHousehold(defaultHousehold(), stored) : defaultHousehold();
}

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "tanuki",
    dbPath: getDbPath(),
    serveWeb,
  }),
);

app.get("/api/household", (c) => c.json(loadHousehold()));

app.put("/api/household", async (c) => {
  const body = (await c.req.json()) as Partial<Household>;
  const next = mergeHousehold(loadHousehold(), body);
  setJson(db, "household", next);
  return c.json(next);
});

app.get("/api/meta", (c) =>
  c.json({
    fy: "2026-27",
    caps: FY_2026_27,
    explainers: EXPLAINERS,
    disclaimer:
      "Estimates only. Not financial, tax, or investment advice.",
  }),
);

app.post("/api/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    household?: Partial<Household>;
    custom?: Allocation;
  };
  const household = body.household
    ? mergeHousehold(loadHousehold(), body.household)
    : loadHousehold();
  const extra = body.custom ? [customScenario(body.custom)] : [];
  const report = runHousehold(household, extra);
  return c.json(report);
});

if (serveWeb && webDistAbs) {
  const rel = path.relative(process.cwd(), webDistAbs) || ".";
  app.use(
    "/*",
    serveStatic({
      root: rel,
      rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p),
    }),
  );
  app.get("*", (c) => {
    const html = fs.readFileSync(path.join(webDistAbs, "index.html"), "utf8");
    return c.html(html);
  });
}

const port = Number(process.env.PORT ?? 8790);
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    `tanuki api http://${info.address}:${info.port}  db=${getDbPath()}${serveWeb ? "  (serving web)" : ""}`,
  );
});
