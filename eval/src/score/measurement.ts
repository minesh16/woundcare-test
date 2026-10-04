/**
 * Measurement scoring (spec §14.3). Public datasets rarely carry a coin or a
 * cm measurement, so most of this is N/A until team data is onboarded.
 */
import type { MetricRow } from '../schema';
import { aggregate, single, type MetricDef, type ScoreContext, type ScoredItem } from './common';
import { blandAltman } from './stats';

const relErr = (pred: number | null | undefined, gt: number | undefined) =>
  typeof pred === 'number' && typeof gt === 'number' && gt > 0 ? ((pred - gt) / gt) * 100 : undefined;

export function measItemMetrics(s: ScoredItem): void {
  const p = s.pred;
  if (!p) return;
  const m = p.measurement;
  const gt = s.item.gt;
  if (gt.markerPresent === true) s.m['meas.coin_found_given_marker'] = Boolean(m?.markerFound);
  if (gt.markerPresent === false) s.m['meas.coin_false_detection'] = Boolean(m?.markerFound);
  if (m) {
    s.m['meas.wb_applied'] = m.whiteBalanced;
    s.m['meas.no_scale'] = !m.markerFound;
  }
  for (const [k, pv, gv] of [
    ['area', m?.areaCm2, gt.areaCm2],
    ['length', m?.lengthCm, gt.lengthCm],
    ['width', m?.widthCm, gt.widthCm],
  ] as const) {
    if (gv === undefined) continue;
    const e = relErr(pv, gv);
    s.m[`meas.${k}_pct_err`] = e ?? null;
    s.m[`meas.${k}_abs_pct_err`] = e === undefined ? null : Math.abs(e);
  }
}

export const MEAS_DEFS: MetricDef[] = [
  { area: 'meas', name: 'coin_sensitivity', key: 'meas.coin_found_given_marker', kind: 'rate' },
  { area: 'meas', name: 'coin_false_detection_rate', key: 'meas.coin_false_detection', kind: 'rate' },
  { area: 'meas', name: 'wb_applied_rate', key: 'meas.wb_applied', kind: 'rate' },
  { area: 'meas', name: 'no_scale_rate', key: 'meas.no_scale', kind: 'rate' },
  { area: 'meas', name: 'area_abs_pct_err', key: 'meas.area_abs_pct_err', kind: 'median' },
  { area: 'meas', name: 'area_pct_err', key: 'meas.area_pct_err', kind: 'mean' },
  { area: 'meas', name: 'length_abs_pct_err', key: 'meas.length_abs_pct_err', kind: 'median' },
  { area: 'meas', name: 'width_abs_pct_err', key: 'meas.width_abs_pct_err', kind: 'median' },
];

export function scoreMeasurement(ctx: ScoreContext, arm: string, items: ScoredItem[]): MetricRow[] {
  const rows = aggregate(ctx, arm, items, MEAS_DEFS);
  const pairs = items.filter((s) => typeof s.pred?.measurement?.areaCm2 === 'number' && typeof s.item.gt.areaCm2 === 'number');
  if (pairs.length >= 3) {
    const ba = blandAltman(
      pairs.map((s) => s.item.gt.areaCm2 as number),
      pairs.map((s) => s.pred!.measurement!.areaCm2 as number),
    );
    rows.push(single(ctx, arm, 'meas', 'area_bland_altman_bias_cm2', ba.bias, ba.n, { ciLow: ba.low, ciHigh: ba.high, inDistribution: pairs.some((s) => s.inDist) }));
  }
  return rows;
}
