import type {
  BucketId,
  PersonId,
  RisuLot,
  RisuTrade,
  SleeveKind,
} from "./types.js";

/**
 * How risu's portfolios map onto tanuki's owners and buckets. Tanuki only
 * reads risu through its HTTP API (`GET /api/lots`), never its database.
 */
export type RisuLink = {
  portfolios: {
    id: number;
    name?: string;
    personId: PersonId;
    /** Keep debt-recycled buys in their own portfolio — it is also what keeps the deduction traceable. */
    purpose: "taxable" | "debt_recycle";
  }[];
  /** "EXCHANGE:TICKER" or bare "TICKER" → sleeve. */
  tickers: Record<string, SleeveKind>;
};

/** Risu's `GET /api/lots?portfolioId=&asOf=&since=` response. */
export type RisuLotsResponse = {
  asOf: string;
  since: string | null;
  lots: {
    ticker: string;
    exchange: string;
    acquiredDate: string;
    quantity: number;
    costBaseAud: number;
    marketValueAud: number | null;
    valueAtCutoverAud: number | null;
  }[];
  buys: { ticker: string; exchange: string; date: string; costAud: number }[];
  disposals: {
    ticker: string;
    exchange: string;
    acquiredDate: string;
    disposedDate: string;
    proceedsAud: number | null;
  }[];
};

export type RisuMonth = {
  lots: RisuLot[];
  trades: RisuTrade[];
  /** Tickers with no sleeve set. The month can't be pulled until they are. */
  unmapped: string[];
  warnings: string[];
};

export function risuTickerKey(exchange: string, ticker: string): string {
  return `${exchange.toUpperCase()}:${ticker.toUpperCase()}`;
}

function bucketFor(
  personId: PersonId,
  purpose: "taxable" | "debt_recycle",
  kind: SleeveKind,
): BucketId {
  // Debt recycling is always in your name (the borrower's). A recycle
  // portfolio mapped to the spouse is treated as ordinary taxable shares.
  if (purpose === "debt_recycle" && personId === "you") {
    return kind === "growth" ? "debt_recycle_you_growth" : "debt_recycle_you_income";
  }
  return `taxable_${personId}_${kind}`;
}

/** Map one month of risu responses (one per linked portfolio) onto tanuki's buckets. */
export function mapRisuMonth(
  link: RisuLink,
  responses: { portfolioId: number; data: RisuLotsResponse }[],
): RisuMonth {
  const lots: RisuLot[] = [];
  const trades: RisuTrade[] = [];
  const unmapped = new Set<string>();
  const warnings: string[] = [];

  for (const { portfolioId, data } of responses) {
    const p = link.portfolios.find((x) => x.id === portfolioId);
    if (!p) continue;
    const sleeveOf = (exchange: string, ticker: string): SleeveKind | null => {
      const key = risuTickerKey(exchange, ticker);
      const kind = link.tickers[key] ?? link.tickers[ticker.toUpperCase()];
      if (!kind) unmapped.add(key);
      return kind ?? null;
    };

    for (const l of data.lots) {
      const kind = sleeveOf(l.exchange, l.ticker);
      if (!kind) continue;
      let value = l.marketValueAud;
      if (value == null) {
        value = l.costBaseAud;
        warnings.push(
          `${l.ticker} has no price in risu on ${data.asOf}; valued at cost.`,
        );
      }
      lots.push({
        portfolioId,
        personId: p.personId,
        purpose: p.purpose,
        sleeve: kind,
        ticker: l.ticker,
        cost: l.costBaseAud,
        value,
        acquiredDate: l.acquiredDate,
        valueAtCutover: l.valueAtCutoverAud,
      });
    }
    for (const b of data.buys) {
      const kind = sleeveOf(b.exchange, b.ticker);
      if (!kind) continue;
      trades.push({
        portfolioId,
        bucket: bucketFor(p.personId, p.purpose, kind),
        ticker: b.ticker,
        date: b.date,
        amount: b.costAud,
      });
    }
    for (const d of data.disposals) {
      const kind = sleeveOf(d.exchange, d.ticker);
      if (!kind) continue;
      if (d.proceedsAud == null) {
        warnings.push(`A ${d.ticker} sell on ${d.disposedDate} has no AUD proceeds in risu; skipped.`);
        continue;
      }
      trades.push({
        portfolioId,
        bucket: bucketFor(p.personId, p.purpose, kind),
        ticker: d.ticker,
        date: d.disposedDate,
        acquiredDate: d.acquiredDate,
        amount: -d.proceedsAud,
      });
    }
  }

  return { lots, trades, unmapped: [...unmapped].sort(), warnings: [...new Set(warnings)] };
}
