/**
 * §21.6–§21.7, §21.10 — the pipeline on the HSV fixture with the network
 * disabled; engine replay consistency; and no write to any non-eval_ table
 * during a full run + score (spied at the network layer: every Supabase REST
 * call is recorded by path).
 */
import { ensureFixtures, json } from './helpers.mts';
import type { T } from './run.mts';

export default async function (t: T) {
  await ensureFixtures(t);
  const { loadItems } = await t.load<typeof import('../src/ingest')>('../src/ingest.ts');
  const { runPipeline } = await t.load<typeof import('../src/pipeline')>('../src/pipeline.ts');
  const { applySegEnv } = await t.load<typeof import('../src/runner')>('../src/runner.ts');
  const { replayConsistent, gtPathway } = await t.load<typeof import('../src/score/engine')>('../src/score/engine.ts');
  const { dominantFromPct } = await t.load<typeof import('../src/vocab')>('../src/vocab.ts');

  applySegEnv('hsv', 'foot');
  const items = loadItems('fx-folder').filter((i) => !i.duplicateOf);
  const ctx = { runId: 'pipe-test', runDir: `${t.tmp}/pipe`, seg: 'hsv' as const, boundary: 'auto' as const, policy: 'image_only' as const };
  for (const item of items) {
    const out = await runPipeline(item, ctx);
    const p = out.row.prediction;
    t.eq(out.row.status, 'ok', `hsv pipeline ok (${item.key})`);
    t.eq(p?.errors, [], `no stage errors (${item.key})`);
    t.eq(p?.segmentation.source, 'hsv', `HSV fallback drew the boundary (${item.key})`);
    t.ok(p?.segmentation.attempts.some((a) => a.status === 'skipped'), `providers recorded as skipped (${item.key})`);
    t.ok(p?.tissuePct && !p.tissueSentinel, `tissue measured inside the mask (${item.key})`);
    t.ok(p?.engine.status === 'incomplete' && p.engine.gateCodes.includes('no_scale'), `image_only → incomplete with the no_scale gate (${item.key})`);
    t.ok(typeof p?.timings.segment === 'number' && typeof p?.timings.measure === 'number', 'stage timings recorded');
    t.ok(p?.maskPath?.endsWith('.png'), 'predicted mask written');
  }

  // gt-mask arm: segmentation skipped, the GT boundary measured; tissue % tracks the synthetic design.
  const withMask = items.find((i) => i.gt.woundMaskPath)!;
  const gtArm = await runPipeline(withMask, { ...ctx, boundary: 'gt-mask' });
  t.eq(gtArm.row.prediction?.segmentation.model, 'ground_truth', 'gt-mask arm uses the GT boundary');
  t.eq(gtArm.row.prediction?.segmentation.source, null, 'gt-mask arm: source null');
  const noMask = items.find((i) => !i.gt.woundMaskPath)!;
  t.eq((await runPipeline(noMask, { ...ctx, boundary: 'gt-mask' })).row.status, 'skipped', 'gt-mask arm skips an item with no GT mask');
  // fx-folder "a" is 70% granulation / 30% slough → engine precedence gives slough.
  const a = items.find((i) => i.key === 'train/images/a')!;
  const aOut = await runPipeline(a, { ...ctx, boundary: 'gt-mask' });
  t.eq(aOut.row.prediction?.dominantTissue, 'slough', 'GT boundary on a 70/30 wound → slough (engine precedence)');
  t.near(aOut.row.prediction?.tissuePct?.granulation ?? -1, 70, 12, 'granulation % close to the synthetic 70%');

  // label-axes policy: GT exudate/infection reach the engine; unlabelled items are skipped for decisions.
  const table = loadItems('fx-table');
  const t1 = table.find((i) => i.key === 't1')!;
  const la = await runPipeline(t1, { ...ctx, policy: 'label-axes' });
  t.eq([la.row.prediction?.exudate, la.row.prediction?.infection], ['moderate', 'no'], 'label-axes feeds GT exudate/infection to the engine');

  // Engine replay consistency: 100% on the fixtures that carry all three GT axes.
  const replay = table.map((i) => replayConsistent(i.gt)).filter((v) => v !== null);
  t.ok(replay.length >= 2 && replay.every(Boolean), 'engine replay consistency 100% on fixtures', replay);
  t.eq(gtPathway(t1.gt), 15, 'GT pathway from expectedPathwayId');
  t.eq(dominantFromPct({ granulation: 5, slough: 5, necrotic: 0, epithelial: 90, other: 0 }), 'epithelialising', 'dominantFromPct uses engine precedence');

  // --- No app writes: a full run + score with a Supabase that records every REST path.
  const runner = await t.load<typeof import('../src/runner')>('../src/runner.ts');
  const { scoreRun } = await t.load<typeof import('../src/score/index')>('../src/score/index.ts');
  const { EvalSink } = await t.load<typeof import('../src/sink')>('../src/sink.ts');
  const paths: string[] = [];
  const offline = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'spy.supabase.test') {
      paths.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`);
      return json(201, []);
    }
    return offline(input, init);
  }) as typeof fetch;
  process.env.SUPABASE_URL = 'https://spy.supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'spy-key';
  try {
    const sink = EvalSink.fromEnv();
    const out = await runner.executeRun(
      {
        runId: 'run-nowrite',
        label: 'nowrite',
        datasets: ['fx-folder', 'fx-neg'],
        seg: 'hsv',
        boundaries: ['auto', 'gt-mask'],
        policy: 'image_only',
        arms: ['hsv|auto|image_only', 'hsv|gt-mask|image_only'],
        seed: 3,
        sample: { total: null, perDataset: null, splits: null, allocation: {} },
        items: [],
        concurrency: 2,
        falRpm: 0,
        modalRpm: 0,
        fusegnetTrigger: 'foot',
        withVlm: false,
        withReport: false,
        withBaseline: false,
        repeat: 0,
        cache: { enabled: true, epoch: 'v1' },
        budgetUsd: 0,
        env: { segmentationProviders: null, tissueRelative: null, sam3Model: 'x', fusegnetModelLabel: null },
      },
      { sink, quiet: true, log: () => {} },
    );
    t.eq(out?.status, 'complete', 'hsv run over fixtures completes');
    const scored = await scoreRun('run-nowrite', { sink, bootstrapResamples: 200 });
    t.ok(scored.metrics.length > 20, 'scored into metric rows', scored.metrics.length);
    t.ok(scored.metrics.some((m) => m.area === 'seg' && m.metric === 'negatives_fp_rate'), 'negatives FP rate scored (fx-neg)');
    t.ok(scored.iouCrossCheck !== null && Math.abs(scored.iouCrossCheck.harness - (scored.iouCrossCheck.app ?? -1)) < 1e-9, 'IoU cross-check against compareMasks passes', scored.iouCrossCheck);
    const { writeReport } = await t.load<typeof import('../src/report')>('../src/report.ts');
    const files = writeReport('run-nowrite', scored);
    t.ok(files.md.endsWith('findings.md'), 'findings written');
  } finally {
    globalThis.fetch = offline;
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  }
  const tables = [...new Set(paths.map((p) => p.split(' ')[1].replace(/^\/rest\/v1\//, '')))];
  t.ok(paths.length > 0, 'the spy saw database traffic', paths.length);
  t.ok(tables.every((tb) => tb.startsWith('eval_')), 'only eval_* tables were touched', tables);
  for (const app of ['assessments', 'audit_log', 'segmentation_corrections', 'api_calls', 'approvals', 'wound_timeline']) {
    t.ok(!tables.includes(app), `no write to ${app}`);
  }
}
