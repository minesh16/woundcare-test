/**
 * The segmentation chain with mocked backends (segmentation spec §3.1, §6.4).
 * Run: npm run test:chain   (tsx — the facade has extensionless imports)
 *
 *  - SAM 3 with several masks: the spec's selection rule, through the real facade
 *  - FUSegNet second opinion: agreement → confidence; 401 / 5xx / timeout →
 *    skipped, SAM 3 alone (never blocks the flow)
 *  - the trigger: a leg wound gets no second opinion by default
 *  - SAM 3 down → FUSegNet as the fallback; both down → HSV, source 'hsv'
 */
// tsx loads the api/ modules as CommonJS, so named ESM imports of them fail;
// a dynamic import's namespace (or its `default`) carries the exports.
const load = async <T,>(path: string): Promise<T> => {
  const mod = (await import(path)) as T & { default?: T };
  return (mod.default ?? mod) as T;
};
const { default: jpeg } = (await import('jpeg-js')) as { default: typeof import('jpeg-js') };
const { normaliseImage } = await load<typeof import('../api/_image')>('../api/_image.ts');
const { toPngDataUri } = await load<typeof import('../api/_maskIO')>('../api/_maskIO.ts');
const { runSegmentation } = await load<typeof import('../api/_segmentation')>('../api/_segmentation.ts');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// A 200 × 160 photo: grey background, a red "wound" disc at (130, 80).
const W = 200;
const H = 160;
const rgba = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const o = (y * W + x) * 4;
    const inWound = (x - 130) ** 2 + (y - 80) ** 2 < 30 ** 2;
    // Granulation red at hue ≈ 8° (the legacy HSV band is 0–70°; a 357° red wraps out of it).
    rgba[o] = inWound ? 190 : 120;
    rgba[o + 1] = inWound ? 60 : 120;
    rgba[o + 2] = inWound ? 40 : 120;
    rgba[o + 3] = 255;
  }
}
const photo = jpeg.encode({ data: rgba, width: W, height: H }, 90).data.toString('base64');
const image = normaliseImage(photo);

function disc(cx: number, cy: number, r: number): string {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) m[y * W + x] = 255;
  return toPngDataUri(m, W, H);
}
const woundMask = disc(130, 80, 30);
const coinMask = disc(40, 80, 20);
const bigMask = disc(100, 80, 70); // wound + surroundings

type Route = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>;
let samRoute: Route;
let fuseRoute: Route;
const calls: { url: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ url, body });
  if (url.includes('fal.run')) return samRoute(body, init?.signal ?? undefined);
  if (url.includes('fuse.example')) return fuseRoute(body, init?.signal ?? undefined);
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const fuseOk = (mask: string) => async () =>
  json(200, {
    mask_png_b64: mask.split(',')[1],
    mean_prob: 0.93,
    regions: { regions_found: 1, regions_kept: 1, regions_dropped: 0, multiple_regions: false },
    model: 'fusegnet-effb7-pscse',
    latency_ms: 812,
  });

process.env.FAL_KEY = 'test';
process.env.FUSEGNET_MODAL_URL = 'https://fuse.example';
process.env.FUSEGNET_TIMEOUT_MS = '150';
delete process.env.SEGMENTATION_PROVIDERS;

// --- SAM 3 selection through the facade --------------------------------------
samRoute = async () => json(200, { masks: [{ url: coinMask }, { url: woundMask }, { url: bigMask }], scores: [0.95, 0.7, 0.8] });
fuseRoute = fuseOk(woundMask);
const noTap = await runSegmentation({ image, bodyZone: 'lower_leg_left' });
check('no taps: the top-scoring mask is taken (here: the coin — why taps exist)', noTap.score === 0.95);
const tapped = await runSegmentation({
  image,
  prompts: { points: [{ xPct: 130 / W, yPct: 80 / H, label: 1 }, { xPct: 60 / W, yPct: 80 / H, label: 0 }] },
  bodyZone: 'lower_leg_left',
});
check('ACCEPTANCE: one positive tap yields a mask containing the tap point', tapped.score === 0.7 && !tapped.promptConflict, tapped.score);
const sentPoints = calls.filter((c) => c.url.includes('fal.run')).at(-1)?.body.point_prompts as { x: number; label: number; object_id: number }[];
check('taps reach SAM 3 as pixels with labels and one object id', sentPoints?.length === 2 && sentPoints[0].x === 130 && sentPoints[1].label === 0 && sentPoints.every((p) => p.object_id === 1), sentPoints);
check('a leg wound gets no second opinion by default', tapped.secondOpinion === null && /not triggered/.test(tapped.secondOpinionReason ?? ''));
check('SAM 3 alone: confidence is from its score (0.7 → medium)', tapped.confidence === 'medium');

const conflict = await runSegmentation({ image, prompts: { points: [{ xPct: 0.02, yPct: 0.02, label: 1 }] } });
check('a tap no mask contains → conflict, low confidence', conflict.promptConflict && conflict.confidence === 'low');

// --- Second opinion -------------------------------------------------------------
samRoute = async () => json(200, { masks: [{ url: woundMask }], scores: [0.9], boxes: [[130 / W, 80 / H, 60 / W, 60 / H]] });
fuseRoute = fuseOk(woundMask);
const agreed = await runSegmentation({ image, bodyZone: 'foot_left' });
check('foot wound: FUSegNet runs', agreed.secondOpinion?.status === 'ok');
check('agreement IoU 1 → high', agreed.secondOpinion?.status === 'ok' && agreed.secondOpinion.agreementIoU === 1 && agreed.confidence === 'high');
const fuseBody = calls.filter((c) => c.url.includes('fuse.example')).at(-1)?.body;
check('FUSegNet gets SAM 3\'s box as integer pixels', JSON.stringify(fuseBody?.box) === JSON.stringify([100, 50, 160, 110]), fuseBody?.box);

fuseRoute = fuseOk(disc(115, 80, 30));
const partial = await runSegmentation({ image, bodyZone: 'foot_left' });
check('partial agreement → medium, and both outlines are returned', partial.confidence === 'medium' && partial.secondOpinion?.status === 'ok' && Boolean(partial.secondOpinion.outline));

for (const [label, route] of [
  ['401', async () => json(401, { detail: 'bad token' })],
  ['5xx', async () => json(503, { detail: 'cold start' })],
  [
    'timeout',
    (_: unknown, signal?: AbortSignal) =>
      new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  ],
] as [string, Route][]) {
  fuseRoute = route;
  const outcome = await runSegmentation({ image, bodyZone: 'foot_left' });
  check(
    `FUSegNet ${label} → second opinion skipped, SAM 3 alone, flow not blocked`,
    outcome.source === 'sam3' && outcome.secondOpinion?.status === 'unavailable' && outcome.confidence === 'high',
    { source: outcome.source, opinion: outcome.secondOpinion },
  );
}

// --- Fallbacks ------------------------------------------------------------------
samRoute = async () => json(500, {});
fuseRoute = fuseOk(woundMask);
const fallback = await runSegmentation({ image, bodyZone: 'lower_leg_left' });
check('SAM 3 down → FUSegNet draws the boundary', fallback.source === 'fusegnet' && fallback.attempts[0].status === 'failed');
check('FUSegNet alone is at most medium (it has no abstain)', fallback.confidence === 'medium');

delete process.env.FAL_KEY;
delete process.env.FUSEGNET_MODAL_URL;
const hsv = await runSegmentation({ image });
check('no model configured → source hsv, with an editable outline', hsv.source === 'hsv' && Boolean(hsv.mask) && (hsv.outline?.length ?? 0) >= 3, { source: hsv.source, mask: Boolean(hsv.mask), outline: hsv.outline?.length, attempts: hsv.attempts, area: hsv.areaPx });
check('the HSV fallback is low confidence and says why', hsv.confidence === 'low' && /colour estimate/.test(hsv.reason ?? ''));

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All segmentation-chain checks passed.');
