import { concessionalRoom, nccRoom } from "./caps.js";
import type { Allocation, BucketId, Household, ScenarioDef } from "./types.js";

export type SuperFill = "none" | "you" | "spouse" | "you_then_spouse";

export const SUPER_FILLS: SuperFill[] = [
  "none",
  "you",
  "spouse",
  "you_then_spouse",
];

export const REST_BUCKETS = [
  "offset",
  "extra_repay",
  "taxable_you_growth",
  "taxable_you_income",
  "taxable_spouse_growth",
  "taxable_spouse_income",
  "debt_recycle_you_growth",
  "debt_recycle_you_income",
] as const satisfies readonly BucketId[];

const REST_TAIL: Record<(typeof REST_BUCKETS)[number], string> = {
  offset: "rest offset",
  extra_repay: "rest pay down loan",
  taxable_you_growth: "rest your growth shares",
  taxable_you_income: "rest your dividend shares",
  taxable_spouse_growth: "rest spouse growth shares",
  taxable_spouse_income: "rest spouse dividend shares",
  debt_recycle_you_growth: "rest recycled, growth",
  debt_recycle_you_income: "rest recycled, income",
};

function roundAmt(n: number): number {
  return Math.round(n * 100) / 100;
}

function take(
  alloc: Allocation,
  bucket: BucketId,
  want: number,
  remaining: number,
): number {
  const n = Math.min(remaining, Math.max(0, want));
  if (n > 0.5) alloc[bucket] = roundAmt((alloc[bucket] ?? 0) + n);
  return remaining - n;
}

function fillPerson(
  alloc: Allocation,
  remaining: number,
  mode: SuperFill,
  youBucket: BucketId,
  spouseBucket: BucketId,
  youRoom: number,
  spouseRoom: number,
): number {
  if (mode === "none") return remaining;
  if (mode === "you") return take(alloc, youBucket, youRoom, remaining);
  if (mode === "spouse") return take(alloc, spouseBucket, spouseRoom, remaining);
  remaining = take(alloc, youBucket, youRoom, remaining);
  return take(alloc, spouseBucket, spouseRoom, remaining);
}

export function stackAllocation(
  h: Household,
  cc: SuperFill,
  ncc: SuperFill,
  rest: BucketId,
): Allocation {
  const alloc: Allocation = {};
  let remaining = h.lumpSum;
  remaining = fillPerson(
    alloc,
    remaining,
    cc,
    "super_cc_you",
    "super_cc_spouse",
    concessionalRoom(h.you, h.assumptions),
    concessionalRoom(h.spouse, h.assumptions),
  );
  remaining = fillPerson(
    alloc,
    remaining,
    ncc,
    "super_ncc_you",
    "super_ncc_spouse",
    nccRoom(h.you, h.assumptions, h.assumptions.useNccBringForward),
    nccRoom(h.spouse, h.assumptions, h.assumptions.useNccBringForward),
  );
  if (remaining > 0.5) alloc[rest] = roundAmt(remaining);
  return alloc;
}

export function allocationKey(a: Allocation): string {
  return Object.entries(a)
    .filter(([, v]) => v != null && v > 0.5)
    .map(([k, v]) => [k, Math.round(v as number)] as const)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
}

function stackLabel(
  cc: SuperFill,
  ncc: SuperFill,
  rest: BucketId | null,
): string {
  const bits: string[] = [];
  if (cc === "you" || cc === "you_then_spouse") bits.push("your tax-cut");
  if (cc === "spouse" || cc === "you_then_spouse") bits.push("spouse tax-cut");
  if (ncc === "you" || ncc === "you_then_spouse") bits.push("your after-tax");
  if (ncc === "spouse" || ncc === "you_then_spouse") bits.push("spouse after-tax");
  if (rest && rest in REST_TAIL) bits.push(REST_TAIL[rest as keyof typeof REST_TAIL]);
  return bits.join(", ");
}

export function stackId(cc: SuperFill, ncc: SuperFill, rest: BucketId): string {
  return `stack:${cc}:${ncc}:${rest}`;
}

export function restBucketFromStackId(id: string): BucketId | null {
  if (!id.startsWith("stack:")) return null;
  const dest = id.slice("stack:".length).split(":").slice(2).join(":");
  return (REST_BUCKETS as readonly string[]).includes(dest)
    ? (dest as BucketId)
    : null;
}

export function buildStacks(h: Household): ScenarioDef[] {
  const seen = new Set<string>();
  const out: ScenarioDef[] = [];
  for (const cc of SUPER_FILLS) {
    for (const ncc of SUPER_FILLS) {
      const prefix = stackAllocation(h, cc, ncc, "offset");
      const prefixWithoutRest = { ...prefix };
      delete prefixWithoutRest.offset;
      const used = Object.values(prefixWithoutRest).reduce(
        (s, n) => s + (n ?? 0),
        0,
      );
      const leftover = h.lumpSum - used;
      const dests: BucketId[] =
        leftover > 0.5 ? [...REST_BUCKETS] : ["offset"];
      for (const rest of dests) {
        const allocation =
          leftover > 0.5
            ? stackAllocation(h, cc, ncc, rest)
            : prefixWithoutRest;
        if (!Object.keys(allocation).length) continue;
        const key = allocationKey(allocation);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: stackId(cc, ncc, leftover > 0.5 ? rest : "offset"),
          label: stackLabel(cc, ncc, leftover > 0.5 ? rest : null),
          summary:
            "Fill in that order. Super stops at this year's remaining room. Leftover all goes to the last bucket.",
          group: "mix",
          allocation,
        });
      }
    }
  }
  return out;
}

export function pickDisplayedResults<T extends { id: string }>(
  ranked: T[],
  always: Iterable<string>,
  maxTopStacks = 3,
): T[] {
  const keep = new Set(always);
  const stacks = ranked.filter((r) => r.id.startsWith("stack:"));
  for (const r of stacks.slice(0, maxTopStacks)) keep.add(r.id);
  const seenRest = new Set<string>();
  for (const r of stacks) {
    const dest = restBucketFromStackId(r.id);
    if (!dest || seenRest.has(dest)) continue;
    seenRest.add(dest);
    keep.add(r.id);
  }
  return ranked.filter((r) => keep.has(r.id));
}
