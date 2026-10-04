/**
 * Engine and decision scoring (spec §14.6).
 *
 * Every policy: completion, withheld, gate codes, incomplete reasons. Under
 * `image_only` the engine CORRECTLY withholds without exudate/infection — that
 * is reported as gate behaviour, never as failure. Decision metrics (axes,
 * pathway, urgent referral, unsafe-confident) need `image+vlm` or `label-axes`.
 */
import { clinicalFlags, evaluate, lookupPathway, molnlyckeFlags } from '../../../src/decision/engine';
import type { TissueType } from '../../../src/decision/engine.types';
import type { GroundTruth, MetricRow } from '../schema';
import { aggregate, single, type MetricDef, type ScoreContext, type ScoredItem } from './common';
import { wilson } from './stats';

/** code → urgency, read off the engine itself by firing every trigger once. */
export const URGENCY_BY_CODE: Record<string, string> = (() => {
  const flags = [
    ...molnlyckeFlags(
      { probeToBone: true, systemicInfection: true, spreadingErythemaOver2cm: true, abpi: 0.4, hardToHeal: true, lossOfProtectiveSensation: true },
      'necrotic',
    ),
    ...molnlyckeFlags({ abpi: 1.5 }),
    ...molnlyckeFlags({ diabetes: true }),
    ...clinicalFlags(
      { underminingTunnelling: 'yes' },
      {
        infectionSigns: { erythema: 'absent', warmth: 'absent', purulent: 'absent', malodour: 'absent', friableGranulation: 'absent' },
        deepStructuresVisible: 'present',
        edgeType: 'healthy',
        visualExudate: 'low',
        tissueCorroboration: 'agrees',
        imageFlags: [],
      },
    ),
  ];
  return Object.fromEntries(flags.map((f) => [f.code, f.urgency]));
})();

function gtTissueType(gt: GroundTruth): TissueType | null {
  if (!gt.dominantTissue) return null;
  if (gt.dominantTissue === 'necrotic') return gt.ischaemia === 'yes' ? 'necrotic_ischaemic' : 'necrotic';
  return gt.dominantTissue;
}

/** The ground-truth pathway: given, or looked up from GT tissue × exudate × infection. */
export function gtPathway(gt: GroundTruth): number | null {
  if (gt.expectedPathwayId) return gt.expectedPathwayId;
  const t = gtTissueType(gt);
  if (t && gt.exudate && gt.infection) return lookupPathway(t, gt.exudate, gt.infection)?.id ?? null;
  return null;
}

/**
 * Does the ground truth imply an urgent referral? From `expectedReferralCodes`
 * when given; otherwise from the engine's own Mölnlycke triggers on what GT
 * can derive. Public GT derives none of the urgent triggers (no probe-to-bone,
 * ABPI or spreading-erythema labels), so this is `null` (unknown) without codes.
 */
export function gtUrgent(gt: GroundTruth): boolean | null {
  if (gt.expectedReferralCodes) return gt.expectedReferralCodes.some((c) => URGENCY_BY_CODE[c] === 'urgent');
  const derived = molnlyckeFlags({}, gtTissueType(gt));
  return derived.some((f) => f.urgency === 'urgent') ? true : null;
}

/** Engine replay (§14.6): evaluate on GT axes alone must reproduce lookupPathway. Null when GT lacks an axis. */
export function replayConsistent(gt: GroundTruth): boolean | null {
  const t = gtTissueType(gt);
  if (!gt.dominantTissue || !t || !gt.exudate || !gt.infection) return null;
  const expected = lookupPathway(t, gt.exudate, gt.infection)?.id ?? null;
  const r = evaluate({
    tissue: { necrosis: 0, slough: 0, granulation: 0, epithelial: 0, other: 0 },
    tissueOverride: gt.dominantTissue,
    perfusion: gt.ischaemia === 'yes' ? 'ischaemic' : gt.ischaemia === 'no' ? 'non_ischaemic' : 'unknown',
    exudate: gt.exudate,
    infection: gt.infection,
    markerFound: true,
    cvConfidence: 'high',
  });
  return r.cwcsPathwayId === expected;
}

export function engineItemMetrics(s: ScoredItem): void {
  const p = s.pred;
  if (!p) return;
  const e = p.engine;
  s.m['engine.complete'] = e.status === 'complete';
  s.m['engine.withheld'] = e.pathwayWithheld;
  s.m['engine.any_urgent'] = e.referrals.some((r) => r.urgency === 'urgent');
  if (s.policy === 'image_only') return;
  const gt = s.item.gt;
  if (gt.exudate) s.m['engine.exudate_correct'] = p.exudate === null ? false : p.exudate === gt.exudate;
  if (gt.infection) s.m['engine.infection_correct'] = p.infection === null ? false : p.infection === gt.infection;
  const pathway = gtPathway(gt);
  if (pathway !== null) {
    s.m['engine.pathway_correct'] = e.cwcsPathwayId === pathway;
    s.m['engine.unsafe_confident'] = e.status === 'complete' && e.confidence === 'high' && e.cwcsPathwayId !== pathway;
  }
  const urgent = gtUrgent(gt);
  const predUrgent = e.referrals.some((r) => r.urgency === 'urgent');
  if (urgent === true) s.m['engine.urgent_detected'] = predUrgent;
  if (urgent === false) s.m['engine.over_referral'] = predUrgent;
}

const ENGINE_DEFS: MetricDef[] = [
  { area: 'engine', name: 'completion_rate', key: 'engine.complete', kind: 'rate' },
  { area: 'engine', name: 'withheld_rate', key: 'engine.withheld', kind: 'rate' },
  { area: 'engine', name: 'any_urgent_referral_rate', key: 'engine.any_urgent', kind: 'rate' },
  { area: 'engine', name: 'exudate_accuracy', key: 'engine.exudate_correct', kind: 'rate' },
  { area: 'engine', name: 'infection_accuracy', key: 'engine.infection_correct', kind: 'rate' },
  { area: 'engine', name: 'pathway_exact_match', key: 'engine.pathway_correct', kind: 'rate' },
  { area: 'engine', name: 'urgent_referral_sensitivity', key: 'engine.urgent_detected', kind: 'rate' },
  { area: 'engine', name: 'over_referral_rate', key: 'engine.over_referral', kind: 'rate' },
  { area: 'engine', name: 'unsafe_confident_rate', key: 'engine.unsafe_confident', kind: 'rate' },
];

export function scoreEngine(ctx: ScoreContext, arm: string, items: ScoredItem[]): MetricRow[] {
  const rows = aggregate(ctx, arm, items, ENGINE_DEFS);
  const preds = items.filter((s) => s.pred);
  const n = preds.length;
  const inDistribution = preds.some((s) => s.inDist);
  if (n) {
    const gates = new Map<string, number>();
    const reasons = new Map<string, number>();
    for (const s of preds) {
      for (const g of new Set(s.pred!.engine.gateCodes)) gates.set(g, (gates.get(g) ?? 0) + 1);
      for (const r of new Set(s.pred!.engine.incompleteReasons)) reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    for (const [g, k] of gates) {
      const w = wilson(k, n);
      rows.push(single(ctx, arm, 'engine', `gate_rate.${g}`, w.value, n, { ciLow: w.low, ciHigh: w.high, inDistribution }));
    }
    [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([r, k]) => {
        const w = wilson(k, n);
        rows.push(single(ctx, arm, 'engine', `incomplete_reason:${r}`, w.value, n, { ciLow: w.low, ciHigh: w.high, inDistribution }));
      });
  }
  // Replay consistency is a property of the ground truth + engine, not of the arm's predictions.
  const replay = items.map((s) => replayConsistent(s.item.gt)).filter((v): v is boolean => v !== null);
  if (replay.length) {
    const w = wilson(replay.filter(Boolean).length, replay.length);
    rows.push(single(ctx, arm, 'engine', 'replay_consistency', w.value, replay.length, { ciLow: w.low, ciHigh: w.high }));
  }
  return rows;
}
