/** Segmentation scoring (spec §14.2). */
import type { MetricRow } from '../schema';
import { aggregate, single, type MetricDef, type ScoreContext, type ScoredItem } from './common';
import { maskMetrics } from './masks';
import { auroc, bestThreshold, calibrationBins, mean, pearson, spearman } from './stats';

/** Per-item segmentation metrics. `gt` / `pred` are 0/255 masks on the analysis grid (pred null = no mask). */
export function segItemMetrics(s: ScoredItem, gt: Uint8Array | null, pred: Uint8Array | null): void {
  const p = s.pred;
  if (!p || s.boundary !== 'auto') return;
  const src = p.segmentation.source;
  s.m['seg.fallback'] = src === 'hsv';
  s.m['seg.no_mask'] = src === null;
  s.m['seg.implausible'] = p.segmentation.plausibility !== 'plausible';
  s.m['seg.multi_region'] = p.segmentation.multipleRegions === true;
  s.m['seg.prompt_conflict'] = p.segmentation.promptConflict === true;
  s.m['seg.second_opinion_ok'] = p.segmentation.secondOpinion ? p.segmentation.secondOpinion.status === 'ok' : undefined;
  if (s.item.gt.woundPresent === false) s.m['seg.negative_fp'] = p.woundPresent;
  if (!gt) return;
  const { width: w, height: h } = s.item;
  const mm = maskMetrics(pred ?? new Uint8Array(w * h), gt, w, h);
  s.m['seg.dice'] = mm.dice;
  s.m['seg.iou'] = mm.iou;
  s.m['seg.precision'] = mm.precision;
  s.m['seg.recall'] = mm.recall;
  s.m['seg.hd95_px'] = mm.hd95Px;
  s.m['seg.hd95_pct_diag'] = mm.hd95PctDiag;
  s.m['seg.boundary_f1'] = mm.boundaryF1;
  s.m['seg.area_err_pct'] = mm.areaErrPct;
  s.m['seg.area_abs_pct_err'] = mm.areaErrPct === null ? null : Math.abs(mm.areaErrPct);
  s.m['seg.iou_ge_0_7'] = mm.iou >= 0.7;
}

const hasGt = (s: ScoredItem) => s.m['seg.dice'] !== undefined;

export const SEG_DEFS: MetricDef[] = [
  { area: 'seg', name: 'dice', key: 'seg.dice', kind: 'mean+median', applies: hasGt },
  { area: 'seg', name: 'iou', key: 'seg.iou', kind: 'mean+median', applies: hasGt },
  { area: 'seg', name: 'precision', key: 'seg.precision', kind: 'mean', applies: hasGt },
  { area: 'seg', name: 'recall', key: 'seg.recall', kind: 'mean', applies: hasGt },
  { area: 'seg', name: 'hd95_px', key: 'seg.hd95_px', kind: 'median', applies: hasGt },
  { area: 'seg', name: 'hd95_pct_diag', key: 'seg.hd95_pct_diag', kind: 'median', applies: hasGt },
  { area: 'seg', name: 'boundary_f1', key: 'seg.boundary_f1', kind: 'mean', applies: hasGt },
  { area: 'seg', name: 'area_abs_pct_err', key: 'seg.area_abs_pct_err', kind: 'median', applies: hasGt },
  { area: 'seg', name: 'area_err_pct', key: 'seg.area_err_pct', kind: 'mean', applies: hasGt },
  { area: 'seg', name: 'iou_ge_0_7_rate', key: 'seg.iou_ge_0_7', kind: 'rate', applies: hasGt },
  { area: 'seg', name: 'fallback_rate', key: 'seg.fallback', kind: 'rate' },
  { area: 'seg', name: 'no_mask_rate', key: 'seg.no_mask', kind: 'rate' },
  { area: 'seg', name: 'implausible_rate', key: 'seg.implausible', kind: 'rate' },
  { area: 'seg', name: 'multi_region_rate', key: 'seg.multi_region', kind: 'rate' },
  { area: 'seg', name: 'prompt_conflict_rate', key: 'seg.prompt_conflict', kind: 'rate' },
  { area: 'seg', name: 'second_opinion_ok_rate', key: 'seg.second_opinion_ok', kind: 'rate' },
  { area: 'seg', name: 'negatives_fp_rate', key: 'seg.negative_fp', kind: 'rate' },
];

/** Calibration and second-opinion value (overall scope; advisory only — the app is never changed). */
export function segSpecial(ctx: ScoreContext, arm: string, items: ScoredItem[]): MetricRow[] {
  const rows: MetricRow[] = [];
  const withGt = items.filter((s) => typeof s.m['seg.iou'] === 'number' && s.pred);
  const inDist = withGt.some((s) => s.inDist);

  // (b) IoU by score decile, (c) the score threshold that best separates IoU ≥ 0.7 (and ≥ 0.5).
  const scored = withGt.filter((s) => typeof s.pred!.segmentation.score === 'number');
  if (scored.length >= 10) {
    const x = scored.map((s) => s.pred!.segmentation.score as number);
    const y = scored.map((s) => s.m['seg.iou'] as number);
    const cal = calibrationBins(x, y, 10);
    cal.bins.forEach((b, i) =>
      rows.push(single(ctx, arm, 'seg', `calib.score_decile_${i + 1}.iou_mean`, b.meanY, b.n, { ciLow: b.lo, ciHigh: b.hi, inDistribution: inDist })),
    );
    rows.push(single(ctx, arm, 'seg', 'calib.score_iou_monotonic', cal.monotonic ? 1 : 0, scored.length, { inDistribution: inDist }));
    for (const [label, cut] of [['0_7', 0.7], ['0_5', 0.5]] as const) {
      const t = bestThreshold(x, y.map((v) => v >= cut));
      if (t) rows.push(single(ctx, arm, 'seg', `calib.advisory_threshold_iou_${label}`, t.t, scored.length, { ciLow: t.spec, ciHigh: t.sens, inDistribution: inDist }));
    }
  }

  // Second-opinion value: agreement IoU vs true IoU.
  const so = withGt.filter((s) => s.pred!.segmentation.secondOpinion?.status === 'ok' && typeof s.pred!.segmentation.secondOpinion.agreementIoU === 'number');
  if (so.length >= 5) {
    const a = so.map((s) => s.pred!.segmentation.secondOpinion!.agreementIoU as number);
    const t = so.map((s) => s.m['seg.iou'] as number);
    rows.push(single(ctx, arm, 'seg', 'second_opinion.pearson', pearson(a, t), so.length, { inDistribution: inDist }));
    rows.push(single(ctx, arm, 'seg', 'second_opinion.spearman', spearman(a, t), so.length, { inDistribution: inDist }));
    rows.push(
      single(ctx, arm, 'seg', 'second_opinion.auroc_iou_lt_0_5', auroc(a.map((v) => 1 - v), t.map((v) => v < 0.5)), so.length, { inDistribution: inDist }),
    );
    rows.push(single(ctx, arm, 'seg', 'second_opinion.agreement_iou.mean', mean(a), so.length, { inDistribution: inDist }));
  }
  return rows;
}

/** Aggregates for one arm. */
export function scoreSegmentation(ctx: ScoreContext, arm: string, items: ScoredItem[]): MetricRow[] {
  return [...aggregate(ctx, arm, items, SEG_DEFS), ...segSpecial(ctx, arm, items)];
}
