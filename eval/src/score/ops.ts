/** Ops metrics (spec §14.10): latency percentiles, error / degraded rates, throughput, calls vs cache hits, cost. */
import type { MetricRow } from '../schema';
import { single, type ScoreContext, type ScoredItem } from './common';
import { quantile, wilson } from './stats';

const STAGES = ['segment', 'measure', 'tissue_run', 'vlm', 'evaluate', 'report', 'baseline', 'total'];

export function scoreOps(ctx: ScoreContext, arm: string, items: ScoredItem[], runCounts: Record<string, unknown> | null): MetricRow[] {
  const rows: MetricRow[] = [];
  const preds = items.filter((s) => s.pred);
  for (const stage of STAGES) {
    const xs = preds.map((s) => s.pred!.timings[stage]).filter((v): v is number => typeof v === 'number');
    if (!xs.length) continue;
    for (const q of [0.5, 0.9, 0.99]) rows.push(single(ctx, arm, 'ops', `latency_ms.${stage}.p${Math.round(q * 100)}`, quantile(xs, q), xs.length));
    const errs = preds.filter((s) => s.pred!.errors.some((e) => e.stage === stage || (stage === 'segment' && e.stage === 'segment'))).length;
    const w = wilson(errs, preds.length);
    rows.push(single(ctx, arm, 'ops', `error_rate.${stage}`, w.value, preds.length, { ciLow: w.low, ciHigh: w.high }));
  }
  // Degraded: a model arm that ended on the HSV fallback, or a VLM that was unavailable.
  const degradedSeg = preds.filter((s) => s.boundary === 'auto' && s.pred!.segmentation.source === 'hsv').length;
  if (preds.some((s) => s.boundary === 'auto')) {
    const n = preds.filter((s) => s.boundary === 'auto').length;
    const w = wilson(degradedSeg, n);
    rows.push(single(ctx, arm, 'ops', 'degraded_rate.segment', w.value, n, { ciLow: w.low, ciHigh: w.high }));
  }
  const failed = items.filter((s) => s.row.status === 'failed').length;
  const fw = wilson(failed, items.length);
  rows.push(single(ctx, arm, 'ops', 'item_failure_rate', fw.value, items.length, { ciLow: fw.low, ciHigh: fw.high }));
  if (runCounts) {
    const c = runCounts as { throughput_per_min?: number; fal_calls?: number; modal_calls?: number; cache_hits?: { fal?: number; modal?: number }; est_usd?: Record<string, number> };
    if (typeof c.throughput_per_min === 'number') rows.push(single(ctx, arm, 'ops', 'throughput_items_per_min', c.throughput_per_min, items.length));
    rows.push(single(ctx, arm, 'ops', 'calls.fal', c.fal_calls ?? 0, items.length));
    rows.push(single(ctx, arm, 'ops', 'calls.modal', c.modal_calls ?? 0, items.length));
    rows.push(single(ctx, arm, 'ops', 'cache_hits.fal', c.cache_hits?.fal ?? 0, items.length));
    rows.push(single(ctx, arm, 'ops', 'cache_hits.modal', c.cache_hits?.modal ?? 0, items.length));
    const usd = Object.values(c.est_usd ?? {}).reduce((a, b) => a + (b ?? 0), 0);
    rows.push(single(ctx, arm, 'ops', 'est_usd.total', usd, items.length));
  }
  return rows;
}
