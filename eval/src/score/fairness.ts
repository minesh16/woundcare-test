/**
 * Fairness (spec §14.8): headline metrics per skin-tone band and the largest
 * gap between bands, with a bootstrap CI. Bands with n < 10 are suppressed and
 * flagged. The ITA° value is an image-derived PROXY, not a clinical skin-tone
 * measure, and it is affected by lighting — every row says so via its scope.
 */
import type { MetricRow } from '../schema';
import { single, type ScoreContext, type ScoredItem } from './common';
import { mean, rng, seedOf, quantile } from './stats';

export const ITA_NOTE = 'image-derived proxy, not a clinical skin-tone measure; affected by lighting';
export const MIN_BAND_N = 10;

/** Headline metrics, as per-item keys: [metric name, item key, kind]. */
export const HEADLINES: [string, string, 'mean' | 'rate'][] = [
  ['seg.dice', 'seg.dice', 'mean'],
  ['tissue.absolute.mae_mean', 'tissue.mae_mean', 'mean'],
  ['tissue.dominant_accuracy', 'dom.correct', 'rate'],
  ['meas.coin_sensitivity', 'meas.coin_found_given_marker', 'rate'],
  ['engine.urgent_referral_sensitivity', 'engine.urgent_detected', 'rate'],
  ['seg.negatives_fp_rate', 'seg.negative_fp', 'rate'],
];

const toNum = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' && Number.isFinite(v) ? v : null);

export function scoreFairness(ctx: ScoreContext, arm: string, items: ScoredItem[]): { rows: MetricRow[]; maxGap: Record<string, number | null>; suppressed: Record<string, string[]> } {
  const rows: MetricRow[] = [];
  const maxGap: Record<string, number | null> = {};
  const suppressed: Record<string, string[]> = {};
  const bands = new Map<string, ScoredItem[]>();
  for (const s of items) {
    const b = s.scopes.find((sc) => sc.startsWith('skinTone='))!.slice('skinTone='.length);
    if (b === 'unknown') continue;
    bands.set(b, [...(bands.get(b) ?? []), s]);
  }
  for (const [name, key] of HEADLINES) {
    const per = [...bands.entries()]
      .map(([band, ss]) => ({ band, xs: ss.map((s) => toNum(s.m[key])).filter((v): v is number => v !== null) }))
      .filter((b) => b.xs.length > 0);
    const kept = per.filter((b) => b.xs.length >= MIN_BAND_N);
    suppressed[name] = per.filter((b) => b.xs.length < MIN_BAND_N).map((b) => `${b.band} (n=${b.xs.length})`);
    if (kept.length < 2) {
      maxGap[name] = null;
      continue;
    }
    const means = kept.map((b) => ({ ...b, m: mean(b.xs) })).sort((a, b) => a.m - b.m);
    const lo = means[0];
    const hi = means[means.length - 1];
    // Bootstrap the gap: resample each band independently.
    const r = rng(seedOf(`${arm}|fairness|${name}`));
    const gaps: number[] = [];
    for (let k = 0; k < Math.min(ctx.bootstrapResamples, 2000); k += 1) {
      const rs = (xs: number[]) => {
        let s = 0;
        for (let i = 0; i < xs.length; i += 1) s += xs[Math.floor(r() * xs.length)];
        return s / xs.length;
      };
      gaps.push(rs(hi.xs) - rs(lo.xs));
    }
    const gap = hi.m - lo.m;
    maxGap[name] = gap;
    rows.push(
      single(ctx, arm, 'fairness', `max_gap.${name}`, gap, lo.xs.length + hi.xs.length, {
        scope: `skinTone=${hi.band}-vs-${lo.band}`,
        ciLow: quantile(gaps, 0.025),
        ciHigh: quantile(gaps, 0.975),
        inDistribution: [...bands.values()].flat().some((s) => s.inDist),
      }),
    );
  }
  return { rows, maxGap, suppressed };
}
