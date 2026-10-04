/**
 * Run-vs-run comparison (spec §17).
 *
 *   npx tsx eval/cli.mts compare --base=<runId> --head=<runId>
 *
 * Pairs the two runs on item (and arm boundary/policy where they match),
 * reports paired deltas with CIs / p-values, lists flipped items, and exits 2
 * if any gate that PASSed in base FAILs in head — usable as a regression check.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { outDir } from './env';
import type { ScoredItem } from './score/common';
import { scoreRun, type ScoreResult } from './score/index';
import { mcnemarExact, pairedBootstrap, seedOf } from './score/stats';

type Paired = { base: ScoredItem; head: ScoredItem };

const HEADLINES: { name: string; key: string; kind: 'continuous' | 'binary'; better: 'higher' | 'lower' }[] = [
  { name: 'seg.dice', key: 'seg.dice', kind: 'continuous', better: 'higher' },
  { name: 'seg.iou', key: 'seg.iou', kind: 'continuous', better: 'higher' },
  { name: 'tissue.absolute.mae_mean', key: 'tissue.mae_mean', kind: 'continuous', better: 'lower' },
  { name: 'tissue.dominant_accuracy', key: 'dom.correct', kind: 'binary', better: 'higher' },
  { name: 'seg.negatives_fp_rate', key: 'seg.negative_fp', kind: 'binary', better: 'lower' },
  { name: 'engine.completion_rate', key: 'engine.complete', kind: 'binary', better: 'higher' },
  { name: 'engine.pathway_exact_match', key: 'engine.pathway_correct', kind: 'binary', better: 'higher' },
  { name: 'engine.urgent_referral_sensitivity', key: 'engine.urgent_detected', kind: 'binary', better: 'higher' },
];

/** `<seg>|<boundary>|<policy>` → `<boundary>|<policy>`, so a chain run pairs with a sam3 run. */
const armTail = (arm: string) => arm.split('|').slice(1).join('|');

export function pairRuns(base: ScoreResult, head: ScoreResult): Paired[] {
  const headBy = new Map(head.items.map((s) => [`${s.item.id}\u0000${s.arm}`, s]));
  const headByTail = new Map(head.items.map((s) => [`${s.item.id}\u0000${armTail(s.arm)}`, s]));
  const out: Paired[] = [];
  for (const b of base.items) {
    const h = headBy.get(`${b.item.id}\u0000${b.arm}`) ?? headByTail.get(`${b.item.id}\u0000${armTail(b.arm)}`);
    if (h) out.push({ base: b, head: h });
  }
  return out;
}

export function comparePairs(pairs: Paired[]) {
  const deltas = HEADLINES.map((h) => {
    const both = pairs.filter((p) => p.base.m[h.key] !== undefined && p.base.m[h.key] !== null && p.head.m[h.key] !== undefined && p.head.m[h.key] !== null);
    if (!both.length) return { metric: h.name, n: 0, base: null, head: null, delta: null, ci: null, p: null, test: null };
    if (h.kind === 'continuous') {
      const a = both.map((p) => p.base.m[h.key] as number);
      const b = both.map((p) => p.head.m[h.key] as number);
      const pb = pairedBootstrap(a, b, { seed: seedOf(h.name) });
      const meanA = a.reduce((x, y) => x + y, 0) / a.length;
      return { metric: h.name, n: both.length, base: meanA, head: meanA + pb.value, delta: pb.value, ci: [pb.low, pb.high] as [number, number], p: null, shareAbove0: pb.shareAbove0, test: 'paired bootstrap' };
    }
    const a = both.map((p) => Boolean(p.base.m[h.key]));
    const b = both.map((p) => Boolean(p.head.m[h.key]));
    let bOnly = 0;
    let cOnly = 0;
    a.forEach((x, i) => {
      if (x && !b[i]) bOnly += 1;
      if (!x && b[i]) cOnly += 1;
    });
    const rateA = a.filter(Boolean).length / a.length;
    const rateB = b.filter(Boolean).length / b.length;
    return { metric: h.name, n: both.length, base: rateA, head: rateB, delta: rateB - rateA, ci: null, p: mcnemarExact(bOnly, cOnly).p, discordant: { baseOnly: bOnly, headOnly: cOnly }, test: 'McNemar exact' };
  });

  const flipped = pairs
    .map((p) => {
      const why: string[] = [];
      const pa = p.base.pred?.engine.cwcsPathwayId ?? null;
      const pb = p.head.pred?.engine.cwcsPathwayId ?? null;
      if (pa !== pb) why.push(`pathway ${pa ?? '—'} → ${pb ?? '—'}`);
      const da = p.base.m['seg.dice'];
      const db = p.head.m['seg.dice'];
      if (typeof da === 'number' && typeof db === 'number' && Math.abs(db - da) > 0.2) why.push(`dice ${da.toFixed(2)} → ${db.toFixed(2)}`);
      const ua = new Set((p.base.pred?.engine.referrals ?? []).map((r) => r.code));
      const ub = new Set((p.head.pred?.engine.referrals ?? []).map((r) => r.code));
      for (const c of ub) if (!ua.has(c)) why.push(`referral gained: ${c}`);
      for (const c of ua) if (!ub.has(c)) why.push(`referral lost: ${c}`);
      const sa = p.base.pred?.segmentation.source ?? null;
      const sb = p.head.pred?.segmentation.source ?? null;
      return { item: p.base.item.id, baseArm: p.base.arm, headArm: p.head.arm, why, source: `${sa ?? '—'} → ${sb ?? '—'}` };
    })
    .filter((f) => f.why.length);
  return { deltas, flipped };
}

export async function compareRuns(baseId: string, headId: string) {
  const [base, head] = [await scoreRun(baseId, { sink: null, persist: false }), await scoreRun(headId, { sink: null, persist: false })];
  const pairs = pairRuns(base, head);
  const { deltas, flipped } = comparePairs(pairs);
  const gateRegressions = base.gates
    .filter((g) => g.status === 'PASS')
    .map((g) => ({ base: g, head: head.gates.find((h) => h.id === g.id && armTail(h.arm) === armTail(g.arm)) }))
    .filter((x) => x.head?.status === 'FAIL')
    .map((x) => ({ gate: x.base.id, baseArm: x.base.arm, headArm: x.head!.arm, base: x.base.value, head: x.head!.value }));
  return { base: { id: base.run.id, arms: base.run.config.arms, gitSha: base.run.gitSha }, head: { id: head.run.id, arms: head.run.config.arms, gitSha: head.run.gitSha }, pairs: pairs.length, deltas, flipped, gateRegressions, gates: { base: base.gates, head: head.gates } };
}

const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v.toFixed(d)).toString());

export async function compareCommand(args: Record<string, unknown>): Promise<number> {
  const baseId = typeof args.base === 'string' ? args.base : null;
  const headId = typeof args.head === 'string' ? args.head : null;
  if (!baseId || !headId) {
    console.error('usage: npx tsx eval/cli.mts compare --base=<runId> --head=<runId>');
    return 2;
  }
  const c = await compareRuns(baseId, headId);
  const dir = join(outDir(), 'compare');
  mkdirSync(dir, { recursive: true });
  const stem = `compare-${baseId}-vs-${headId}`;
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify(c, null, 2));
  const L = [
    `# Compare — \`${baseId}\` (base) vs \`${headId}\` (head)`,
    '',
    `Base arms: ${c.base.arms.join(', ')} · head arms: ${c.head.arms.join(', ')} · ${c.pairs} paired item×arm results.`,
    '',
    '| metric | n | base | head | Δ (head − base) | 95% CI / p | test |',
    '|---|---|---|---|---|---|---|',
    ...c.deltas.map((d) => `| ${d.metric} | ${d.n} | ${f(d.base)} | ${f(d.head)} | ${f(d.delta)} | ${d.ci ? `[${f(d.ci[0])}, ${f(d.ci[1])}]` : d.p !== null ? (d.p < 1e-4 ? 'p < 0.0001' : `p = ${f(d.p, 4)}`) : '—'} | ${d.test ?? '—'} |`),
    '',
    `## Gate regressions (PASS in base → FAIL in head): ${c.gateRegressions.length}`,
    '',
    ...(c.gateRegressions.length ? c.gateRegressions.map((g) => `- **${g.gate}**: ${f(g.base)} → ${f(g.head)}`) : ['None.']),
    '',
    `## Flipped items (${c.flipped.length})`,
    '',
    ...c.flipped.slice(0, 200).map((x) => `- \`${x.item}\` (${x.source}): ${x.why.join('; ')}`),
    '',
  ];
  writeFileSync(join(dir, `${stem}.md`), L.join('\n'));
  console.log(`compare → ${join(dir, `${stem}.md`)}`);
  for (const d of c.deltas.filter((x) => x.n)) console.log(`  ${d.metric.padEnd(36)} n=${String(d.n).padStart(5)}  ${f(d.base)} → ${f(d.head)}  Δ ${f(d.delta)}`);
  console.log(`  flipped items: ${c.flipped.length}; gate regressions: ${c.gateRegressions.length}`);
  return c.gateRegressions.length ? 2 : 0;
}
