/**
 * VLM, report and baseline scoring (spec §14.7) — opt-in arms only.
 *
 * The baseline's free text is stored, never scored for correctness and never
 * sent to an LLM judge. The only thing measured about it is how often it names
 * a specific dressing or product — the contrast with MendWise's grounded output.
 */
import type { VlmFeatures } from '../../../src/decision/engine.types';
import type { MetricRow } from '../schema';
import { aggregate, single, type MetricDef, type ScoreContext, type ScoredItem } from './common';

/** Dressing / product words the baseline is checked for (a simple keyword list, by design). */
export const DRESSING_KEYWORDS = [
  'hydrocolloid',
  'alginate',
  'hydrogel',
  'foam',
  'hydrofiber',
  'hydrofibre',
  'silver',
  'iodine',
  'cadexomer',
  'honey',
  'mepilex',
  'aquacel',
  'allevyn',
  'duoderm',
  'kaltostat',
  'intrasite',
  'tegaderm',
  'polyurethane film',
  'silicone',
  'negative pressure',
  'npwt',
  'paraffin gauze',
  'non-adherent',
  'zinc',
  'compression',
];

export function namesDressing(text: string): boolean {
  const t = text.toLowerCase();
  return DRESSING_KEYWORDS.some((k) => t.includes(k));
}

const SIGNS = ['erythema', 'warmth', 'purulent', 'malodour', 'friableGranulation'] as const;
const FIELDS = ['edgeType', 'visualExudate', 'tissueCorroboration', 'deepStructuresVisible'] as const;

function visualToLevel(v: string): string | null {
  if (v === 'none' || v === 'low') return 'low';
  if (v === 'moderate') return 'moderate';
  if (v === 'high' || v === 'very_high') return 'high';
  return null;
}

export function vlmItemMetrics(s: ScoredItem): void {
  const p = s.pred;
  if (!p) return;
  if (p.vlm) {
    s.m['vlm.unavailable'] = p.vlm.source !== 'gateway';
    if (p.vlm.source === 'gateway') {
      s.m['vlm.schema_violation'] = p.vlm.schemaValid === false || !p.vlm.features;
      const f = p.vlm.features as VlmFeatures | null;
      if (f) {
        for (const sign of SIGNS) s.m[`vlm.uncertain.${sign}`] = f.infectionSigns[sign] === 'uncertain';
        for (const field of FIELDS) s.m[`vlm.uncertain.${field}`] = (f as Record<string, unknown>)[field] === 'uncertain';
        const gi = s.item.gt.infection;
        if (gi) {
          for (const sign of SIGNS) {
            const v = f.infectionSigns[sign];
            if (gi === 'yes') s.m[`vlm.sign_sens.${sign}`] = v === 'present';
            else s.m[`vlm.sign_spec.${sign}`] = v === 'absent';
            if (v === 'uncertain') s.m[`vlm.sign_uncertain_given_gt.${sign}`] = true;
          }
        }
        if (s.item.gt.exudate) {
          const lvl = visualToLevel(f.visualExudate);
          s.m['vlm.exudate_agree'] = lvl === null ? null : lvl === s.item.gt.exudate;
        }
      }
    }
  }
  if (p.report) s.m['report.cage_violation'] = p.report.cageViolation;
  if (p.baseline?.text) s.m['baseline.names_dressing'] = namesDressing(p.baseline.text);
}

const VLM_DEFS: MetricDef[] = [
  { area: 'vlm', name: 'schema_violation_rate', key: 'vlm.schema_violation', kind: 'rate' },
  { area: 'vlm', name: 'unavailable_rate', key: 'vlm.unavailable', kind: 'rate' },
  { area: 'vlm', name: 'exudate_agreement', key: 'vlm.exudate_agree', kind: 'rate' },
  ...SIGNS.flatMap((sign) => [
    { area: 'vlm', name: `infection_sign_sensitivity.${sign}`, key: `vlm.sign_sens.${sign}`, kind: 'rate' as const },
    { area: 'vlm', name: `infection_sign_specificity.${sign}`, key: `vlm.sign_spec.${sign}`, kind: 'rate' as const },
  ]),
  ...[...SIGNS, ...FIELDS].map((f) => ({ area: 'vlm', name: `uncertain_rate.${f}`, key: `vlm.uncertain.${f}`, kind: 'rate' as const })),
  { area: 'vlm', name: 'report_cage_violation_rate', key: 'report.cage_violation', kind: 'rate' },
  { area: 'vlm', name: 'baseline_names_dressing_rate', key: 'baseline.names_dressing', kind: 'rate' },
];

export function scoreVlm(ctx: ScoreContext, arm: string, items: ScoredItem[]): MetricRow[] {
  return aggregate(ctx, arm, items, VLM_DEFS, (scope) => scope === 'overall' || scope.startsWith('dataset='));
}

/** Field-level agreement between two VLM passes on the same items (`--repeat`). */
export function vlmDeterminism(ctx: ScoreContext, arm: string, pairs: [VlmFeatures, VlmFeatures][]): MetricRow[] {
  if (!pairs.length) return [];
  const flat = (f: VlmFeatures) => ({ ...f.infectionSigns, deep: f.deepStructuresVisible, edge: f.edgeType, exudate: f.visualExudate, corroboration: f.tissueCorroboration, flags: f.imageFlags.join(',') });
  const keys = Object.keys(flat(pairs[0][0]));
  return keys.map((k) => {
    const agree = pairs.filter(([a, b]) => (flat(a) as Record<string, unknown>)[k] === (flat(b) as Record<string, unknown>)[k]).length;
    return single(ctx, arm, 'vlm', `determinism.${k}`, agree / pairs.length, pairs.length);
  });
}
