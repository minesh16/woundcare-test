/** §21.8 — after an interrupted run, a resume skips the completed keys; --retry-failed re-runs failures. */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureFixtures } from './helpers.mts';
import type { T } from './run.mts';

export default async function (t: T) {
  await ensureFixtures(t);
  const runner = await t.load<typeof import('../src/runner')>('../src/runner.ts');
  const { EvalSink } = await t.load<typeof import('../src/sink')>('../src/sink.ts');
  const quiet = { sink: new EvalSink(null), quiet: true, log: () => {} };
  const cfg = {
    runId: 'run-resume-test',
    label: 'resume',
    datasets: ['fx-class', 'fx-folder'],
    seg: 'hsv' as const,
    boundaries: ['auto' as const],
    policy: 'image_only' as const,
    arms: ['hsv|auto|image_only'],
    seed: 9,
    sample: { total: null, perDataset: null, splits: null, allocation: {} },
    items: [],
    concurrency: 1,
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
  };

  // "Kill" after 4 results.
  const first = await runner.executeRun(cfg, { ...quiet, stopAfter: 4 });
  t.eq(first?.status, 'interrupted', 'stopped run is marked interrupted');
  t.eq(first?.done, 4, 'four results written before the stop');
  const total = first!.run.config.items.length;
  t.ok(total > 4, 'more items remained', total);

  const resumed = await runner.executeRun(cfg, { ...quiet, resume: runner.loadRun('run-resume-test') });
  t.eq(resumed?.skippedExisting, 4, 'resume skips the 4 completed keys');
  t.eq(resumed?.done, total - 4, 'resume runs only the rest');
  t.eq(resumed?.status, 'complete', 'resumed run completes');
  const rows = readFileSync(join(runner.runDir('run-resume-test'), 'results.jsonl'), 'utf8').trim().split('\n');
  t.eq(rows.length, total, 'no item ran twice');
  t.eq(new Set(rows.map((r) => JSON.parse(r).itemId)).size, total, 'every item exactly once');

  // A failed key: skipped on a plain resume, re-run with --retry-failed.
  const victim = JSON.parse(rows[0]) as { itemId: string; arm: string };
  appendFileSync(join(runner.runDir('run-resume-test'), 'results.jsonl'), `${JSON.stringify({ runId: 'run-resume-test', itemId: victim.itemId, arm: victim.arm, status: 'failed', prediction: null, error: 'simulated', at: new Date().toISOString() })}\n`);
  const plain = await runner.executeRun(cfg, { ...quiet, resume: runner.loadRun('run-resume-test') });
  t.eq(plain?.done, 0, 'plain resume does not re-run failed items');
  const retry = await runner.executeRun(cfg, { ...quiet, resume: runner.loadRun('run-resume-test'), retryFailed: true });
  t.eq(retry?.done, 1, '--retry-failed re-runs exactly the failed item');
  t.eq(runner.latestResults('run-resume-test').get(`${victim.itemId}\u0000${victim.arm}`)?.status, 'ok', 'and it is ok now');
  // A torn last line (crash mid-write) does not break reading.
  appendFileSync(join(runner.runDir('run-resume-test'), 'results.jsonl'), '{"runId":"run-resume-test","itemId":');
  t.eq(runner.readResults('run-resume-test').length, total + 2, 'a torn final line is ignored');
}
