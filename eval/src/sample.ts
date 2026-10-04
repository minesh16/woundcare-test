/**
 * Seeded stratified sampler (spec §10). Same seed + same item set → same list,
 * which the runner stores in `eval_runs.config.items` so a run can be replayed.
 */
import type { Manifest } from './manifest';
import type { EvalItem } from './schema';
import { rng, seedOf } from './score/stats';

/** Spec §10 default target, capped by availability (inaccessible sets simply drop out). */
export const DEFAULT_TARGET: Record<string, number> = {
  fuseg2021: 400,
  'azh-woundclass': 400,
  medetec: 200,
  dfutissue: 110,
  woundcarevqa: 150,
  'synthetic-negatives': 50,
};

export type SampleSpec = {
  datasets: string[];
  /** Total items; absent → every eligible item (or DEFAULT_TARGET with `useDefaultTarget`). */
  sample?: number;
  perDataset?: Record<string, number>;
  splits?: string[];
  seed: number;
  useDefaultTarget?: boolean;
};

export type Allocation = Record<string, { available: number; chosen: number }>;

/** Largest-remainder apportionment of `total` over `weights`, each capped at `caps`. */
export function apportion(total: number, weights: number[], caps: number[]): number[] {
  const out = weights.map(() => 0);
  let remaining = Math.min(total, caps.reduce((a, b) => a + b, 0));
  // Repeat until everything is placed: a capped bucket hands its excess to the others.
  while (remaining > 0) {
    const open = weights.map((w, i) => (out[i] < caps[i] && w > 0 ? i : -1)).filter((i) => i >= 0);
    if (open.length === 0) break;
    const wsum = open.reduce((a, i) => a + weights[i], 0);
    const shares = open.map((i) => ({ i, exact: (remaining * weights[i]) / wsum }));
    let placed = 0;
    for (const s of shares) {
      const take = Math.min(Math.floor(s.exact), caps[s.i] - out[s.i]);
      out[s.i] += take;
      placed += take;
    }
    const left = remaining - placed;
    const byRemainder = shares
      .map((s) => ({ i: s.i, r: s.exact - Math.floor(s.exact) }))
      .sort((a, b) => b.r - a.r || a.i - b.i)
      .filter((s) => out[s.i] < caps[s.i]);
    for (let k = 0; k < Math.min(left, byRemainder.length); k += 1) out[byRemainder[k].i] += 1;
    const placedNow = placed + Math.min(left, byRemainder.length);
    if (placedNow === 0) break;
    remaining -= placedNow;
  }
  return out;
}

function shuffled<T>(xs: T[], seed: number): T[] {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function eligible(items: EvalItem[], splits?: string[]): EvalItem[] {
  return items.filter((i) => !i.duplicateOf && (!splits?.length || (i.split !== null && splits.includes(i.split))));
}

/** Stratified pick of `k` items from one dataset (woundType + the manifest's strata fields). */
export function pickStratified(items: EvalItem[], k: number, strata: string[], seed: number, datasetId: string): EvalItem[] {
  if (k >= items.length) return [...items].sort((a, b) => a.id.localeCompare(b.id));
  const keyOf = (i: EvalItem) => ['woundType', ...strata.filter((s) => s !== 'woundType')].map((s) => `${s}=${i.strata[s] ?? 'unknown'}`).join('|');
  const groups = new Map<string, EvalItem[]>();
  for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id))) groups.set(keyOf(it), [...(groups.get(keyOf(it)) ?? []), it]);
  const names = [...groups.keys()].sort();
  const sizes = names.map((n) => groups.get(n)!.length);
  const quota = apportion(k, sizes, sizes);
  const picked = names.flatMap((n, gi) => shuffled(groups.get(n)!, seedOf(`${datasetId}|${n}`, seed)).slice(0, quota[gi]));
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}

export function sampleItems(
  itemsByDataset: Record<string, EvalItem[]>,
  manifests: Record<string, Pick<Manifest, 'sample_weight' | 'strata'>>,
  spec: SampleSpec,
): { items: EvalItem[]; allocation: Allocation } {
  const ids = spec.datasets.filter((d) => itemsByDataset[d]);
  const pools = ids.map((d) => eligible(itemsByDataset[d], spec.splits));
  const available = pools.map((p) => p.length);

  let counts: number[];
  if (spec.perDataset && Object.keys(spec.perDataset).length) {
    counts = ids.map((d, i) => Math.min(available[i], spec.perDataset![d] ?? 0));
  } else if (spec.sample !== undefined) {
    const floors = available.map((a) => Math.min(30, a));
    const floorSum = floors.reduce((a, b) => a + b, 0);
    if (spec.sample <= floorSum) {
      counts = apportion(spec.sample, floors, floors);
    } else {
      const weights = ids.map((d, i) => (manifests[d]?.sample_weight ?? 1) * (available[i] - floors[i]));
      const extra = apportion(spec.sample - floorSum, weights, available.map((a, i) => a - floors[i]));
      counts = floors.map((f, i) => f + extra[i]);
    }
  } else if (spec.useDefaultTarget) {
    counts = ids.map((d, i) => Math.min(available[i], DEFAULT_TARGET[d] ?? available[i]));
  } else {
    counts = available;
  }

  const allocation: Allocation = {};
  const items = ids.flatMap((d, i) => {
    allocation[d] = { available: available[i], chosen: counts[i] };
    return pickStratified(pools[i], counts[i], manifests[d]?.strata ?? [], spec.seed, d);
  });
  return { items, allocation };
}

/** `a:400,b:400` → { a: 400, b: 400 } */
export function parsePerDataset(raw: string | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  return Object.fromEntries(
    raw.split(',').map((pair) => {
      const [id, n] = pair.split(':');
      return [id.trim(), Number(n)];
    }),
  );
}
