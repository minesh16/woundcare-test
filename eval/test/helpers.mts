/** Shared test helpers: ingested fixtures (once per process) and a mock fal / Modal backend. */
import type { T } from './run.mts';

let ready: Promise<{ info: ReturnType<typeof import('./makeFixtures.mts').makeFixtures> }> | null = null;

/** Generate and ingest every fixture dataset once; later callers reuse it. */
export function ensureFixtures(t: T) {
  ready ??= (async () => {
    const { makeFixtures } = await import('./makeFixtures.mts');
    const info = makeFixtures(process.env.EVAL_DATA_DIR!, process.env.EVAL_DATASETS_DIR!);
    const { ingestDataset } = await t.load<typeof import('../src/ingest')>('../src/ingest.ts');
    const { loadManifest } = await t.load<typeof import('../src/manifest')>('../src/manifest.ts');
    for (const id of info.ids) await ingestDataset(loadManifest(id), { log: () => {} });
    return { info };
  })();
  return ready;
}

export const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export type MockCall = { url: string; method: string; body: string; headers: Record<string, string> };

/**
 * A fake network: fal.run answers with one mask covering the centre of the
 * frame, the Modal origin with the same mask; anything else throws. Routes can
 * be swapped per test. Every call is recorded (headers included, so a test can
 * prove they never reach the cache).
 */
export function mockProviders(opts: { maskUri: () => string; modalOrigin: string }) {
  const calls: MockCall[] = [];
  let fal: (body: Record<string, unknown>) => Promise<Response> = async () =>
    json(200, { masks: [{ url: opts.maskUri() }], scores: [0.9], boxes: [[0.5, 0.5, 0.4, 0.4]] });
  let modal: (body: Record<string, unknown>) => Promise<Response> = async () =>
    json(200, { mask_png_b64: opts.maskUri().split(',')[1], mean_prob: 0.9, regions: { regions_found: 1, regions_kept: 1, regions_dropped: 0, multiple_regions: false }, model: 'fusegnet-test', latency_ms: 4000 });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body, headers });
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    if (url.startsWith('https://fal.run/')) return fal(parsed);
    if (url.startsWith(opts.modalOrigin)) return modal(parsed);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    falCalls: () => calls.filter((c) => c.url.startsWith('https://fal.run/')).length,
    modalCalls: () => calls.filter((c) => c.url.startsWith(opts.modalOrigin)).length,
    setFal: (f: typeof fal) => (fal = f),
    setModal: (f: typeof modal) => (modal = f),
  };
}
