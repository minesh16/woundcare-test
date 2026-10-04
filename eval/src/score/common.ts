/**
 * Shared scoring machinery (spec §14): scopes, the in-distribution tag, and
 * turning per-item values into aggregate rows with 95% CIs (§15).
 */
import type { Manifest } from '../manifest';
import type { EvalItem, MetricRow, Prediction, ResultRow } from '../schema';
import { bootstrap, mean, median, seedOf, wilson } from './stats';

export type ItemValue = number | boolean | null | undefined;

export type ScoredItem = {
  row: ResultRow;
  item: EvalItem;
  pred: Prediction | null;
  arm: string;
  boundary: 'auto' | 'gt-mask';
  policy: string;
  /** FUSegNet drew this boundary on data it was trained on (spec §14.9). */
  inDist: boolean;
  scopes: string[];
  /** Per-item metrics, keyed `<area>.<name>`. */
  m: Record<string, ItemValue>;
};

export type ScoreContext = {
  runId: string;
  manifests: Record<string, Manifest>;
  bootstrapResamples: number;
};

export function skinToneBand(item: EvalItem, pred: Prediction | null): string {
  const s = item.gt.skinTone;
  if (s?.scale === 'monk') return `monk_${s.value}`;
  if (s?.scale === 'fitzpatrick') return `fitzpatrick_${s.value}`;
  return pred?.skinToneProxy?.band ?? 'unknown';
}

export function scopesFor(item: EvalItem, pred: Prediction | null, inDist: boolean): string[] {
  const src = pred ? (pred.segmentation.model === 'ground_truth' ? 'gt' : (pred.segmentation.source ?? 'none')) : 'none';
  return [
    'overall',
    `dataset=${item.datasetId}`,
    `woundType=${item.gt.woundType ?? 'unknown'}`,
    `skinTone=${skinToneBand(item, pred)}`,
    `segSource=${src}`,
    `confidence=${pred?.segmentation.confidence ?? 'none'}`,
    `in_distribution=${inDist}`,
  ];
}

export type MetricDef = {
  area: string;
  /** Aggregate metric name; `.mean` / `.median` are appended for continuous kinds. */
  name: string;
  /** Per-item key in `ScoredItem.m`. */
  key: string;
  kind: 'rate' | 'mean' | 'median' | 'mean+median';
  /** Only items where this returns true are in the denominator (default: value is not undefined). */
  applies?: (s: ScoredItem) => boolean;
};

const isNum = (v: ItemValue): v is number => typeof v === 'number' && Number.isFinite(v);

export function aggregate(ctx: ScoreContext, arm: string, items: ScoredItem[], defs: MetricDef[], scopeFilter?: (scope: string) => boolean): MetricRow[] {
  const scopes = new Map<string, ScoredItem[]>();
  for (const s of items) for (const sc of s.scopes) if (!scopeFilter || scopeFilter(sc)) scopes.set(sc, [...(scopes.get(sc) ?? []), s]);
  const rows: MetricRow[] = [];
  for (const def of defs) {
    for (const [scope, members] of scopes) {
      const pool = members.filter((s) => (def.applies ? def.applies(s) : s.m[def.key] !== undefined));
      if (!pool.length) continue;
      const values = pool.map((s) => s.m[def.key]);
      const na = values.filter((v) => v === null || (typeof v === 'number' && !Number.isFinite(v))).length;
      const naRate = na / pool.length;
      const inDistribution = pool.some((s) => s.inDist);
      const base = { runId: ctx.runId, arm, area: def.area, scope, naRate, inDistribution };
      if (def.kind === 'rate') {
        const bools = values.filter((v): v is boolean => typeof v === 'boolean');
        if (!bools.length) continue;
        const w = wilson(bools.filter(Boolean).length, bools.length);
        rows.push({ ...base, metric: def.name, value: w.value, ciLow: w.low, ciHigh: w.high, n: bools.length });
        continue;
      }
      const nums = values.filter(isNum);
      if (!nums.length) continue;
      const seed = seedOf(`${arm}|${def.area}.${def.name}|${scope}`);
      if (def.kind === 'mean' || def.kind === 'mean+median') {
        const b = bootstrap(nums, mean, { resamples: ctx.bootstrapResamples, seed });
        rows.push({ ...base, metric: `${def.name}.mean`, value: b.value, ciLow: b.low, ciHigh: b.high, n: nums.length });
      }
      if (def.kind === 'median' || def.kind === 'mean+median') {
        const b = bootstrap(nums, median, { resamples: Math.min(ctx.bootstrapResamples, 1000), seed: seed + 1 });
        rows.push({ ...base, metric: `${def.name}.median`, value: b.value, ciLow: b.low, ciHigh: b.high, n: nums.length });
      }
    }
  }
  return rows;
}

/** A single computed value (κ, AUROC, a threshold …) as a metric row. */
export function single(
  ctx: ScoreContext,
  arm: string,
  area: string,
  metric: string,
  value: number | null,
  n: number,
  opts: { scope?: string; ciLow?: number | null; ciHigh?: number | null; inDistribution?: boolean; naRate?: number | null } = {},
): MetricRow {
  return {
    runId: ctx.runId,
    arm,
    area,
    metric,
    scope: opts.scope ?? 'overall',
    value: value !== null && Number.isFinite(value) ? value : null,
    ciLow: opts.ciLow ?? null,
    ciHigh: opts.ciHigh ?? null,
    n,
    naRate: opts.naRate ?? null,
    inDistribution: opts.inDistribution ?? false,
  };
}
