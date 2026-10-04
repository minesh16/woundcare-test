/** §21.2, §21.9, §21.10 — IoU parity with the app, production guard, eval_-only sink, no app writes. */
import type { T } from './run.mts';

export default async function (t: T) {
  const env = await t.load<typeof import('../src/env')>('../src/env.ts');
  const { EvalSink, assertEvalTable } = await t.load<typeof import('../src/sink')>('../src/sink.ts');
  const masks = await t.load<typeof import('../src/score/masks')>('../src/score/masks.ts');
  const { appIoU } = await t.load<typeof import('../src/pipeline')>('../src/pipeline.ts');

  // --- Production guard
  await t.throws(() => env.productionGuard({ VERCEL: '1' } as NodeJS.ProcessEnv), 'production guard trips with VERCEL=1', /refuses/);
  await t.throws(() => env.productionGuard({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), 'production guard trips with NODE_ENV=production', /refuses/);
  env.productionGuard({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  t.ok(true, 'production guard passes in a dev environment');
  await t.throws(() => env.assertDataLocation(`${env.REPO_ROOT}/eval/data`), 'data inside the repo is refused', /outside the repo/);
  await t.throws(() => env.assertDataLocation('/Users/x/Library/CloudStorage/OneDrive-Foo/data'), 'data in OneDrive is refused', /OneDrive/);

  // --- Sink allow-list with a mocked client
  const touched: string[] = [];
  const mock = {
    from(table: string) {
      touched.push(table);
      return {
        upsert: async () => ({ error: null }),
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    },
  };
  const sink = new EvalSink(mock as never);
  await sink.upsert('eval_runs', [{ id: 'x' }], 'id');
  t.eq(touched, ['eval_runs'], 'sink writes an eval_ table');
  for (const bad of ['assessments', 'audit_log', 'segmentation_corrections', 'api_calls', 'eval_secret', 'evaluations']) {
    await t.throws(() => sink.upsert(bad as never, [{}], 'id'), `sink refuses ${bad}`, /refuses/);
  }
  t.eq(touched, ['eval_runs'], 'refused writes never reach the client');
  await t.throws(() => assertEvalTable('assessment_images'), 'assertEvalTable refuses app tables');

  // --- IoU parity: the harness IoU equals the app's compareMasks IoU.
  const W = 37;
  const H = 23;
  for (let trial = 0; trial < 5; trial += 1) {
    const a = new Uint8Array(W * H);
    const b = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) {
      a[i] = (i * 7 + trial) % 5 < 2 ? 255 : 0;
      b[i] = (i * 3 + trial) % 4 < 2 ? 255 : 0;
    }
    t.near(masks.maskMetrics(a, b, W, H).iou, appIoU(a, b, W, H) ?? NaN, 1e-12, `harness IoU = compareMasks IoU (trial ${trial})`);
  }
}
