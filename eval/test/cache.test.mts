/** §21.11 — the provider response cache, against a mocked fal / Modal that counts calls. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { json, mockProviders } from './helpers.mts';
import type { T } from './run.mts';

function walk(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  } catch {
    return [];
  }
}

export default async function (t: T) {
  const cache = await t.load<typeof import('../src/providerCache')>('../src/providerCache.ts');
  const io = await t.load<typeof import('../src/io')>('../src/io.ts');
  const { synthImage } = await t.load<typeof import('../src/synth')>('../src/synth.ts');
  const { runPipeline } = await t.load<typeof import('../src/pipeline')>('../src/pipeline.ts');
  const { applySegEnv } = await t.load<typeof import('../src/runner')>('../src/runner.ts');
  const { runSegmentation } = await t.load<typeof import('../../api/_segmentation')>('../../api/_segmentation.ts');
  const { fusegnetRequest } = await t.load<typeof import('../../api/_segmentationParse')>('../../api/_segmentationParse.ts');

  const s = synthImage({ width: 200, height: 150, seed: 77 });
  const img = io.normaliseImage(Buffer.from(io.encodeJpeg({ data: s.rgba, width: 200, height: 150 }, 90)).toString('base64'));
  const maskUri = io.maskDataUri(s.woundMask, 200, 150);
  const MODAL = 'https://fuse.example.modal.run';
  const net = mockProviders({ maskUri: () => maskUri, modalOrigin: MODAL });
  const cacheDir = join(t.tmp, 'httpcache');
  process.env.FAL_KEY = 'fal-secret-key-123';
  process.env.FUSEGNET_MODAL_URL = MODAL;
  process.env.FUSEGNET_AUTH_TOKEN = 'modal-secret-token-456';
  cache.installProviderCache({ enabled: true, epoch: 'test', dir: cacheDir, realFetch: net.fetch });
  cache.resetCounters();
  t.ok(cache.isInstalled(), 'cache wrapper installed on globalThis.fetch');

  const item = { id: 'cache:1', datasetId: 'x', key: '1', split: null, imageSha256: img.sha256, dhash: '', relPath: '', normPath: '', width: img.width, height: img.height, gt: { rawLabels: {}, bodyZone: 'lower_leg_left' }, strata: {}, duplicateOf: null };
  const ctx = (seg: 'chain' | 'sam3') => ({ runId: 'cache-test', runDir: join(t.tmp, 'cache-run'), seg, boundary: 'auto' as const, policy: 'image_only' as const });

  // --- Two arms on the same image make ONE SAM 3 call.
  applySegEnv('chain', 'foot');
  const a = await cache.itemContext.run({ itemId: item.id, imageSha: item.imageSha256, cacheEnabled: true }, () => runPipeline(item, ctx('chain'), { image: img, writeMask: false }));
  applySegEnv('sam3', 'foot');
  const b = await cache.itemContext.run({ itemId: item.id, imageSha: item.imageSha256, cacheEnabled: true }, () => runPipeline(item, ctx('sam3'), { image: img, writeMask: false }));
  t.eq(net.falCalls(), 1, 'chain then sam3 on one image → one SAM 3 call');
  t.eq(cache.counters().hits.fal, 1, 'the second arm is a cache hit');
  t.eq(a.row.prediction?.segmentation.source, 'sam3', 'first arm used SAM 3');
  t.eq(b.row.prediction?.segmentation.score, a.row.prediction?.segmentation.score, "a hit returns a Response the app's parser accepts unchanged");
  t.eq(b.row.prediction?.segmentation.areaPx, a.row.prediction?.segmentation.areaPx, 'same mask from the cached response');

  // --- FUSegNet with a box and without get different keys.
  const withBox = fusegnetRequest(process.env, img.dataUrl, [10, 10, 80, 80])!;
  const noBox = fusegnetRequest(process.env, img.dataUrl, null)!;
  t.ok(cache.keyForRequest('modal', withBox) !== cache.keyForRequest('modal', noBox), 'FUSegNet box / no-box requests have different keys');
  // A second opinion (foot) and a standalone fallback both reach Modal once each, then hit.
  delete process.env.SEGMENTATION_PROVIDERS;
  await cache.itemContext.run({ itemId: 'foot', imageSha: 'foot-sha', cacheEnabled: true }, () => runSegmentation({ image: img, bodyZone: 'foot_left' }));
  const modalAfterSecond = net.modalCalls();
  await cache.itemContext.run({ itemId: 'foot', imageSha: 'foot-sha', cacheEnabled: true }, () => runSegmentation({ image: img, bodyZone: 'foot_left' }));
  t.eq(net.modalCalls(), modalAfterSecond, 'a repeated second opinion is served from cache');
  t.ok(cache.indexedKey('foot-sha', 'fusegnet_second', 'modal') !== null, 'the second-opinion key is indexed for the estimator');

  // --- Secrets never reach a key or a stored file.
  const files = walk(cacheDir);
  t.ok(files.length >= 2, 'entries written', files.length);
  const blob = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  t.ok(!blob.includes('fal-secret-key-123') && !blob.includes('modal-secret-token-456') && !/Authorization/i.test(blob), 'no Authorization header or secret in any stored file');
  t.ok(net.calls.some((c) => c.headers.Authorization?.includes('fal-secret-key-123')), '(the real request did carry the header)');

  // --- Non-2xx and timeouts are not cached.
  const s2 = synthImage({ width: 200, height: 150, seed: 78 });
  const img2 = io.normaliseImage(Buffer.from(io.encodeJpeg({ data: s2.rgba, width: 200, height: 150 }, 90)).toString('base64'));
  applySegEnv('sam3', 'foot');
  let failCount = 0;
  net.setFal(async () => {
    failCount += 1;
    return json(500, { detail: 'boom' });
  });
  await runSegmentation({ image: img2, bodyZone: 'lower_leg_left' });
  await runSegmentation({ image: img2, bodyZone: 'lower_leg_left' });
  t.eq(failCount, 2, 'a 500 is not cached: the next call goes to the network again');
  process.env.SAM3_TIMEOUT_MS = '50';
  let timeouts = 0;
  net.setFal(
    (_b) =>
      new Promise<Response>((_res, reject) => {
        timeouts += 1;
        setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 60);
      }),
  );
  await runSegmentation({ image: img2, bodyZone: 'lower_leg_left' });
  await runSegmentation({ image: img2, bodyZone: 'lower_leg_left' });
  t.eq(timeouts, 2, 'a timeout is not cached');
  delete process.env.SAM3_TIMEOUT_MS;

  // --- Transient errors retry with backoff (up to 3 attempts).
  let attempts = 0;
  net.setFal(async () => {
    attempts += 1;
    return attempts < 3 ? json(503, {}) : json(200, { masks: [{ url: maskUri }], scores: [0.8] });
  });
  const retried = await runSegmentation({ image: img2, bodyZone: 'lower_leg_left' });
  t.ok(attempts === 3 && retried.source === 'sam3', 'two 503s then success: retried, not degraded', { attempts, source: retried.source });

  // --- --no-cache bypasses it entirely.
  net.setFal(async () => json(200, { masks: [{ url: maskUri }], scores: [0.9] }));
  cache.setCacheEnabled(false);
  const before = net.falCalls();
  await runSegmentation({ image: img, bodyZone: 'lower_leg_left' });
  await runSegmentation({ image: img, bodyZone: 'lower_leg_left' });
  t.eq(net.falCalls() - before, 2, '--no-cache: every call reaches the provider');
  cache.setCacheEnabled(true);

  // --- Non-provider hosts pass straight through, uncounted.
  const hitsBefore = JSON.stringify(cache.counters());
  try {
    await fetch('https://example.com/x');
  } catch {
    /* the mock throws for unknown hosts */
  }
  t.eq(JSON.stringify(cache.counters()), hitsBefore, 'other hosts are not intercepted');
  t.eq(cache.classify('https://gateway.ai.vercel.app/v1', 'POST'), null, 'the gateway is never cached');

  // --- cache stats / clear
  const stats = cache.cacheStats();
  t.ok(stats['fal.run']?.entries >= 1, 'cache stats per host', stats);
  t.ok(cache.cacheClear({ host: 'modal' }) >= 1, 'cache clear --host=modal');
  t.eq(cache.cacheStats()['fuse.example.modal.run'], undefined, 'modal entries gone');

  for (const k of ['FAL_KEY', 'FUSEGNET_MODAL_URL', 'FUSEGNET_AUTH_TOKEN']) process.env[k] = '';
  delete process.env.SEGMENTATION_PROVIDERS;
  // Back to an offline network (not by importing run.mts: that is the entry module, still mid-evaluation).
  cache.installProviderCache({
    dir: '',
    realFetch: (async (input: unknown) => {
      throw new Error(`network disabled in tests: ${String(input)}`);
    }) as typeof fetch,
  });
}
