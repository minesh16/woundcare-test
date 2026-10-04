/**
 * Tissue composition and dominant tissue (spec §14.4, §14.5).
 *
 * MAE is scored over the classes the dataset can label only, with both sides
 * renormalised over those classes plus `other`, so a dataset without an
 * epithelial class is not penalised for a prediction that has one.
 */
import type { MetricRow } from '../schema';
import { DOMINANT_TISSUE, TISSUE_CLASSES, type TissueClass } from '../vocab';
import { aggregate, single, type MetricDef, type ScoreContext, type ScoredItem } from './common';
import { cohensKappa, macroF1 } from './stats';

type Pct = Record<TissueClass, number>;

/** Renormalise onto `classes` (labelled + other): anything outside is folded into `other`. */
export function renormalise(p: Pct, classes: readonly TissueClass[]): Partial<Pct> {
  const keep = new Set<TissueClass>([...classes, 'other']);
  const out: Partial<Pct> = {};
  let otherExtra = 0;
  for (const c of TISSUE_CLASSES) {
    if (keep.has(c)) out[c] = p[c];
    else otherExtra += p[c];
  }
  out.other = (out.other ?? 0) + otherExtra;
  const total = Object.values(out).reduce((a, b) => a + (b ?? 0), 0);
  if (total > 0) for (const k of Object.keys(out) as TissueClass[]) out[k] = (100 * (out[k] ?? 0)) / total;
  return out;
}

export function tissueItemMetrics(s: ScoredItem): void {
  const p = s.pred;
  if (!p) return;
  if (p.tissuePct) s.m['tissue.sentinel'] = p.tissueSentinel;
  const gt = s.item.gt.tissuePct as Pct | undefined;
  const labelled = (s.item.gt.tissueClassesLabelled ?? TISSUE_CLASSES.filter((c) => c !== 'other')) as TissueClass[];
  if (gt) {
    const g = renormalise(gt, labelled);
    for (const [prefix, pred] of [
      ['tissue', p.tissuePct],
      ['tissue_rel', p.tissuePctRelative],
    ] as const) {
      if (!pred) {
        s.m[`${prefix}.mae_mean`] = null;
        continue;
      }
      const q = renormalise(pred as Pct, labelled);
      const errs: number[] = [];
      for (const c of Object.keys(g) as TissueClass[]) {
        const e = Math.abs((q[c] ?? 0) - (g[c] ?? 0));
        s.m[`${prefix}.mae_${c}`] = e;
        errs.push(e);
      }
      s.m[`${prefix}.mae_mean`] = errs.reduce((a, b) => a + b, 0) / errs.length;
    }
  }
  const gtDom = s.item.gt.dominantTissue;
  if (gtDom) {
    s.m['dom.abstained'] = p.dominantTissue === null;
    s.m['dom.correct'] = p.dominantTissue === null ? undefined : p.dominantTissue === gtDom;
  }
}

const TISSUE_DEFS: MetricDef[] = [
  ...(['tissue', 'tissue_rel'] as const).flatMap((prefix) => [
    { area: 'tissue', name: `${prefix === 'tissue' ? 'absolute' : 'relative'}.mae_mean`, key: `${prefix}.mae_mean`, kind: 'mean' as const },
    ...TISSUE_CLASSES.map((c) => ({ area: 'tissue', name: `${prefix === 'tissue' ? 'absolute' : 'relative'}.mae_${c}`, key: `${prefix}.mae_${c}`, kind: 'mean' as const })),
  ]),
  { area: 'tissue', name: 'sentinel_rate', key: 'tissue.sentinel', kind: 'rate' },
  { area: 'tissue', name: 'dominant_accuracy', key: 'dom.correct', kind: 'rate' },
  { area: 'tissue', name: 'dominant_abstain_rate', key: 'dom.abstained', kind: 'rate' },
];

export function dominantConfusion(items: ScoredItem[]): { labels: string[]; matrix: Record<string, Record<string, number>> } {
  const cols = [...DOMINANT_TISSUE, 'abstain'];
  const matrix: Record<string, Record<string, number>> = Object.fromEntries(DOMINANT_TISSUE.map((r) => [r, Object.fromEntries(cols.map((c) => [c, 0]))]));
  for (const s of items) {
    const g = s.item.gt.dominantTissue;
    if (!g || !s.pred) continue;
    matrix[g][s.pred.dominantTissue ?? 'abstain'] += 1;
  }
  return { labels: cols, matrix };
}

export function scoreTissue(ctx: ScoreContext, arm: string, items: ScoredItem[]): MetricRow[] {
  const rows = aggregate(ctx, arm, items, TISSUE_DEFS);
  const pairs = items.filter((s) => s.item.gt.dominantTissue && s.pred?.dominantTissue);
  if (pairs.length >= 2) {
    const truth = pairs.map((s) => s.item.gt.dominantTissue as string);
    const pred = pairs.map((s) => s.pred!.dominantTissue as string);
    const inDistribution = pairs.some((s) => s.inDist);
    rows.push(single(ctx, arm, 'tissue', 'dominant_kappa', cohensKappa(truth, pred), pairs.length, { inDistribution }));
    rows.push(single(ctx, arm, 'tissue', 'dominant_macro_f1', macroF1(truth, pred, DOMINANT_TISSUE), pairs.length, { inDistribution }));
  }
  return rows;
}
