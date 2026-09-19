const aud0 = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const aud2 = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

export function money(n: number, cents = false): string {
  return (cents ? aud2 : aud0).format(Math.round(n * (cents ? 100 : 1)) / (cents ? 100 : 1));
}

export function pct(decimal: number, digits = 1): string {
  return `${(decimal * 100).toFixed(digits)}%`;
}

export function numInput(n: number): string {
  return Number.isFinite(n) ? String(n) : "";
}

export function parseNum(raw: string): number {
  return parseNumLoose(raw) ?? 0;
}

export function parseNumLoose(raw: string): number | null {
  const t = raw.replace(/[$,\s]/g, "").trim();
  if (t === "" || t === "-" || t === "." || t === "-.") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parsePct(raw: string): number {
  const t = raw.replace(/%/g, "").trim();
  const n = Number(t);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}
