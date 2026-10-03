/**
 * Offline tests for the segmentation wire formats.
 * Run: npm run test:segmentation
 *
 * What this covers, and why each one is here rather than being left to a live
 * probe: every assertion below is a failure that would otherwise appear as a
 * *plausible wound boundary* rather than as an error.
 *
 *  - A fractional point sent where fal expects pixels puts SAM 3's prompt in the
 *    top-left corner of the photo, and it still returns a mask.
 *  - `apply_mask: true` makes fal composite the mask onto the photograph; the
 *    HSI classifier would then measure the photo as if it were tissue.
 *  - A mask covering the whole frame segments the patient, not the wound, and
 *    every tissue percentage measured inside it is wrong by the same amount.
 *  - A FUSegNet response whose mask is under a key we don't read looks exactly
 *    like a model that found nothing.
 *
 * No network. `api/_segmentationParse.ts` is deliberately import-free so it can
 * be loaded directly under `node --experimental-strip-types`, the same
 * constraint `src/decision/engine.ts` is built to.
 */
import {
  buildFusegnetBody,
  buildSam3Input,
  confidenceFromScore,
  dataUrlToBytes,
  DEFAULT_PROVIDER_ORDER,
  describePlausibility,
  fusegnetHealthUrl,
  fusegnetRequest,
  fusegnetUrl,
  highestScoreIndex,
  imageSize,
  MAX_MASK_AREA_FRACTION,
  MIN_MASK_AREA_FRACTION,
  maskPlausibility,
  normaliseMaskRef,
  parseFusegnetResponse,
  parseProviderOrder,
  parseSam3Response,
  modalAuthHeaders,
  pointToPixels,
  sam3Request,
  SAM3_PROMPT_DEFAULT,
} from '../api/_segmentationParse.ts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : { actual, expected });
}

// ---------------------------------------------------------------------------
// Provider order
// ---------------------------------------------------------------------------

// SAM 3 leads: FUSegNet is the more specific model but its training set is
// chronic FOOT ulcers, so it is the preferred boundary for DFUs and an unknown
// quantity elsewhere. The general model goes first until the eval set says
// otherwise — and that decision is this env var, not a code change.
eq('default order is SAM 3 then FUSegNet', [...DEFAULT_PROVIDER_ORDER], ['sam3', 'fusegnet']);
eq('an unset env var gives the default order', parseProviderOrder(undefined), ['sam3', 'fusegnet']);
eq('an explicit order is honoured', parseProviderOrder('fusegnet,sam3'), ['fusegnet', 'sam3']);
eq('a single provider can be pinned', parseProviderOrder('fusegnet'), ['fusegnet']);
eq('whitespace and case are tolerated', parseProviderOrder(' SAM3 , FuseGNet '), ['sam3', 'fusegnet']);
eq('duplicates collapse', parseProviderOrder('fusegnet,fusegnet,sam3'), ['fusegnet', 'sam3']);
eq('an unknown name is dropped, not fatal', parseProviderOrder('sam4,sam3'), ['sam3']);
// SAM 2 was removed as a provider; naming it must not resurrect it, and must
// not take segmentation down either.
eq('the removed sam2 provider is not accepted', parseProviderOrder('sam2,sam3'), ['sam3']);
eq('sam2 alone falls back to the default rather than disabling segmentation', parseProviderOrder('sam2'), [
  'sam3',
  'fusegnet',
]);
eq(
  'an all-unknown value falls back to the default rather than disabling segmentation',
  parseProviderOrder('nonsense,garbage'),
  ['sam3', 'fusegnet'],
);
eq('an empty string falls back to the default', parseProviderOrder(''), ['sam3', 'fusegnet']);

// ---------------------------------------------------------------------------
// Image dimensions — needed to convert a fractional point to pixels
// ---------------------------------------------------------------------------

/** Minimal PNG header: signature + IHDR length/type + width/height. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.set([(width >> 24) & 255, (width >> 16) & 255, (width >> 8) & 255, width & 255], 16);
  bytes.set([(height >> 24) & 255, (height >> 16) & 255, (height >> 8) & 255, height & 255], 20);
  return bytes;
}

/**
 * Minimal JPEG: SOI, an APP0 segment that must be skipped by length, then SOF0
 * carrying the dimensions. The APP0 is the point — a reader that doesn't honour
 * segment lengths finds garbage.
 */
function jpegHeader(width: number, height: number, marker = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [
    0xff,
    marker,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 255,
    height & 255,
    (width >> 8) & 255,
    width & 255,
    0x03,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof]);
}

eq('PNG dimensions are read from IHDR', imageSize(pngHeader(1280, 960)), { width: 1280, height: 960 });
eq('JPEG dimensions are read from SOF0, skipping APP0', imageSize(jpegHeader(4032, 3024)), {
  width: 4032,
  height: 3024,
});
eq('progressive JPEG (SOF2) is also read', imageSize(jpegHeader(800, 600, 0xc2)), {
  width: 800,
  height: 600,
});
check('a non-image returns null rather than a guess', imageSize(Uint8Array.from([1, 2, 3, 4])) === null);
check('a truncated JPEG returns null', imageSize(Uint8Array.from([0xff, 0xd8, 0xff])) === null);

eq('a fractional point maps to pixels', pointToPixels({ xPct: 0.5, yPct: 0.25 }, { width: 1000, height: 800 }), {
  x: 500,
  y: 200,
});
eq('a point on the far edge stays inside the frame', pointToPixels({ xPct: 1, yPct: 1 }, { width: 10, height: 10 }), {
  x: 9,
  y: 9,
});
eq('an out-of-range point is clamped, not sent as-is', pointToPixels({ xPct: 2, yPct: -1 }, { width: 10, height: 10 }), {
  x: 9,
  y: 0,
});

// ---------------------------------------------------------------------------
// SAM 3 request (fal-ai/sam-3/image)
// ---------------------------------------------------------------------------

const sam3Image = 'data:image/jpeg;base64,AAAA';
const sam3Plain = buildSam3Input({ imageDataUrl: sam3Image });

eq('the concept prompt defaults to "wound"', sam3Plain.prompt, SAM3_PROMPT_DEFAULT);
eq('the image goes in image_url, data uri and all', sam3Plain.image_url, sam3Image);
check(
  'apply_mask is false — a composited photo would be measured as tissue',
  sam3Plain.apply_mask === false,
  sam3Plain.apply_mask,
);
check('scores are requested so confidence is not invented', sam3Plain.include_scores === true);
check('multiple masks are requested so a wound can be picked out', sam3Plain.return_multiple_masks === true);
eq('the mask format is png', sam3Plain.output_format, 'png');
check('no point prompt is sent when dimensions are unknown', sam3Plain.point_prompts === undefined);

const sam3Pointed = buildSam3Input({
  imageDataUrl: sam3Image,
  point: { xPct: 0.25, yPct: 0.5 },
  size: { width: 400, height: 200 },
});
eq('the point prompt is in PIXELS, foreground-labelled', sam3Pointed.point_prompts, [{ x: 100, y: 100, label: 1 }]);

check(
  'a point with no size is dropped rather than sent as a fraction',
  buildSam3Input({ imageDataUrl: sam3Image, point: { xPct: 0.25, yPct: 0.5 } }).point_prompts === undefined,
);
eq('a custom prompt overrides the default', buildSam3Input({ imageDataUrl: sam3Image, prompt: 'ulcer' }).prompt, 'ulcer');
eq('a blank prompt falls back to the default', buildSam3Input({ imageDataUrl: sam3Image, prompt: '   ' }).prompt, 'wound');
eq('max_masks is clamped to fal\'s 1–32 range (high)', buildSam3Input({ imageDataUrl: sam3Image, maxMasks: 999 }).max_masks, 32);
eq('max_masks is clamped to fal\'s 1–32 range (low)', buildSam3Input({ imageDataUrl: sam3Image, maxMasks: 0 }).max_masks, 1);
eq('a non-numeric max_masks falls back to the default', buildSam3Input({ imageDataUrl: sam3Image, maxMasks: NaN }).max_masks, 4);

// ---------------------------------------------------------------------------
// SAM 3 response
// ---------------------------------------------------------------------------

const sam3Response = parseSam3Response({
  masks: [
    { url: 'https://fal.media/mask-a.png', content_type: 'image/png' },
    { url: 'https://fal.media/mask-b.png' },
  ],
  scores: [0.41, 0.93],
  image: { url: 'https://fal.media/preview.png' },
});
eq('fal Image objects are unwrapped to urls', sam3Response.masks, [
  'https://fal.media/mask-a.png',
  'https://fal.media/mask-b.png',
]);
eq('per-mask scores come through', sam3Response.scores, [0.41, 0.93]);
eq('the highest score is found', highestScoreIndex(sam3Response.scores), 1);

eq(
  'a single-mask response that only populated `image` still yields a mask',
  parseSam3Response({ masks: [], image: { url: 'https://fal.media/only.png' } }).masks,
  ['https://fal.media/only.png'],
);
eq(
  'scores carried in `metadata` are found',
  parseSam3Response({ masks: [{ url: 'https://fal.media/m.png' }], metadata: [{ score: 0.7 }] }).scores,
  [0.7],
);
eq('a response with no scores reports null, not zeros', parseSam3Response({ masks: [{ url: 'https://x/m.png' }] }).scores, null);
// Scores pick the mask, so a ragged array must be discarded, not re-indexed:
// dropping a null mid-array shifts every later score onto the wrong mask.
eq(
  'scores with a null in the middle are discarded, not compacted onto the wrong masks',
  parseSam3Response({
    masks: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png' }, { url: 'https://x/c.png' }],
    scores: [0.9, null, 0.2],
  }).scores,
  null,
);
eq(
  'a scores array shorter than masks is discarded',
  parseSam3Response({ masks: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png' }], scores: [0.9] }).scores,
  null,
);
eq(
  'aligned scores are kept',
  parseSam3Response({ masks: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png' }], scores: [0.9, 0.2] }).scores,
  [0.9, 0.2],
);
eq('a malformed response is empty rather than throwing', parseSam3Response('nope').masks, []);
eq('a null response is empty rather than throwing', parseSam3Response(null).masks, []);
check('highestScoreIndex of nothing is null', highestScoreIndex(null) === null);

eq('a score at the threshold is high confidence', confidenceFromScore(0.5), 'high');
eq('a score under the threshold is medium', confidenceFromScore(0.49), 'medium');
eq('a MISSING score is medium, never high', confidenceFromScore(null), 'medium');
eq('a NaN score is medium, never high', confidenceFromScore(NaN), 'medium');

// ---------------------------------------------------------------------------
// FUSegNet request + response
// ---------------------------------------------------------------------------

// The deployed endpoint's own OpenAPI schema names this field `image_b64`.
eq('the image field defaults to `image_b64`', buildFusegnetBody({ imageDataUrl: 'data:image/png;base64,AA' }), {
  image_b64: 'data:image/png;base64,AA',
});
eq(
  'the image field can be renamed without a code change',
  buildFusegnetBody({ imageDataUrl: 'X', imageField: 'image' }),
  { image: 'X' },
);
// `box` is [x0,y0,x1,y1] in pixels; the endpoint documents it as coming from SAM 3.
eq('a box is rounded to integer pixels', buildFusegnetBody({ imageDataUrl: 'X', box: [1.4, 2.6, 30.2, 40.8] }).box, [
  1, 3, 30, 41,
]);
check('a box of the wrong length is dropped', buildFusegnetBody({ imageDataUrl: 'X', box: [1, 2, 3] }).box === undefined);
check(
  'a box containing NaN is dropped rather than sent',
  buildFusegnetBody({ imageDataUrl: 'X', box: [1, 2, NaN, 4] }).box === undefined,
);
check('no box key at all when none is given', buildFusegnetBody({ imageDataUrl: 'X' }).box === undefined);
eq('size is passed through as an integer', buildFusegnetBody({ imageDataUrl: 'X', size: 512 }).size, 512);
check('a zero size is dropped so the endpoint keeps its own default', buildFusegnetBody({ imageDataUrl: 'X', size: 0 }).size === undefined);
check('debug is omitted unless asked for', buildFusegnetBody({ imageDataUrl: 'X' }).debug === undefined);

// The bare *.modal.run origin 404s: the FastAPI app mounts /health and /segment
// beneath it. This is what made the first live probe fail.
eq('the segment route is appended to a bare origin', fusegnetUrl('https://x--app.modal.run', '/segment'), 'https://x--app.modal.run/segment');
eq('a trailing slash does not double up', fusegnetUrl('https://x--app.modal.run/', '/segment'), 'https://x--app.modal.run/segment');
eq(
  'a URL that already has a path is left alone, so one var can pin the endpoint',
  fusegnetUrl('https://x--app.modal.run/v2/infer', '/segment'),
  'https://x--app.modal.run/v2/infer',
);
eq('surrounding whitespace is trimmed', fusegnetUrl('  https://x--app.modal.run  ', '/segment'), 'https://x--app.modal.run/segment');
eq('the health url is derived from the same origin', fusegnetHealthUrl({ FUSEGNET_MODAL_URL: 'https://x--app.modal.run' }), 'https://x--app.modal.run/health');
check('no health url without a configured origin', fusegnetHealthUrl({}) === null);

const longBase64 = 'A'.repeat(120);

// The real response, as read off a live authenticated call. `mask_png_b64` is the
// key the deployed endpoint actually uses — it was NOT in the first version of
// the tolerance list, which is exactly the mismatch the live probe surfaced.
const liveShape = parseFusegnetResponse({
  mask_png_b64: longBase64,
  area_px: 3346,
  regions: { regions_found: 3, regions_kept: 1, regions_dropped: 2, multiple_regions: false, min_region_px: 50 },
  mean_prob: 0.9507441520690918,
  width: 256,
  height: 256,
  crop: [0, 0, 256, 256],
  size: 512,
  model: 'fusegnet-effb7-pscse',
  latency_ms: 1162,
});
eq('the live response shape yields a mask', liveShape.mask, `data:image/png;base64,${longBase64}`);
eq('…its mean_prob as the score', liveShape.score, 0.9507441520690918);
eq('…its area_px', liveShape.areaPx, 3346);
eq('…the weights it says it ran, for the audit log', liveShape.model, 'fusegnet-effb7-pscse');
eq('…and whether it saw more than one region', liveShape.multipleRegions, false);
eq(
  'multiple_regions true is carried through',
  parseFusegnetResponse({ mask_png_b64: longBase64, regions: { multiple_regions: true } }).multipleRegions,
  true,
);
eq(
  'a missing regions block is null, not false — "not reported" is not "one region"',
  parseFusegnetResponse({ mask_png_b64: longBase64 }).multipleRegions,
  null,
);
eq('a missing model is null, so the audit falls back rather than inventing one', parseFusegnetResponse({ mask_png_b64: longBase64 }).model, null);

eq(
  'a bare-base64 mask is normalised to a png data uri',
  parseFusegnetResponse({ mask: longBase64 }).mask,
  `data:image/png;base64,${longBase64}`,
);
eq(
  'a data-uri mask is passed through untouched',
  parseFusegnetResponse({ mask: 'data:image/png;base64,QUJD' }).mask,
  'data:image/png;base64,QUJD',
);
eq(
  'an http mask url is passed through untouched',
  parseFusegnetResponse({ mask_url: 'https://modal.example/mask.png' }).mask,
  'https://modal.example/mask.png',
);
eq(
  'a mask under an alternative key is still found',
  parseFusegnetResponse({ mask_png_base64: longBase64 }).mask,
  `data:image/png;base64,${longBase64}`,
);
eq(
  'a single-element list is unwrapped',
  parseFusegnetResponse({ masks: ['https://modal.example/m.png'] }).mask,
  'https://modal.example/m.png',
);
eq(
  'an explicit FUSEGNET_MASK_FIELD wins over the known keys',
  parseFusegnetResponse({ mask: 'https://wrong/a.png', wound: 'https://right/b.png' }, 'wound').mask,
  'https://right/b.png',
);
eq('a score is read when present', parseFusegnetResponse({ mask: longBase64, confidence: 0.88 }).score, 0.88);
eq('an alternative score key is read', parseFusegnetResponse({ mask: longBase64, mean_prob: 0.4 }).score, 0.4);
eq('a pre-counted area is read', parseFusegnetResponse({ mask: longBase64, area_px: 1234 }).areaPx, 1234);
eq('a missing score is null, not 0', parseFusegnetResponse({ mask: longBase64 }).score, null);

const unknownShape = parseFusegnetResponse({ segmentation_result: longBase64, meta: 1 });
eq('an unrecognised response yields no mask', unknownShape.mask, null);
eq(
  'and names the keys it did get, so a contract mismatch is diagnosable',
  unknownShape.keys,
  ['segmentation_result', 'meta'],
);

eq('a non-object response yields no mask', parseFusegnetResponse(42).mask, null);
eq('an empty-string mask is rejected', parseFusegnetResponse({ mask: '' }).mask, null);
eq('a short string is not treated as an image', parseFusegnetResponse({ mask: 'ok' }).mask, null);
eq(
  'a string with non-base64 characters is rejected rather than wrapped in a data uri',
  normaliseMaskRef(`${'A'.repeat(70)}<script>`),
  null,
);
check('dataUrlToBytes decodes a data uri', (dataUrlToBytes('data:image/png;base64,QUJD') ?? []).length === 3);
check('dataUrlToBytes rejects non-base64', dataUrlToBytes('data:image/png;base64,!!!') === null);

// ---------------------------------------------------------------------------
// Request assembly + auth. These are the shared builders the adapters AND
// `npm run check:segmentation` both use, so the probe cannot verify a request
// the pipeline doesn't send.
// ---------------------------------------------------------------------------

eq(
  'Modal proxy auth sends the Key/Secret pair when both halves are present',
  modalAuthHeaders({ MODAL_KEY: 'wk-1', MODAL_SECRET: 'ws-2' }),
  { 'Modal-Key': 'wk-1', 'Modal-Secret': 'ws-2' },
);
eq(
  'a lone MODAL_KEY is not sent as half a pair',
  modalAuthHeaders({ MODAL_KEY: 'wk-1' }),
  {},
);
eq(
  'a bearer token is used when there is no Modal pair',
  modalAuthHeaders({ FUSEGNET_AUTH_TOKEN: 'tok' }),
  { Authorization: 'Bearer tok' },
);
eq('the Modal pair wins over a bearer token', modalAuthHeaders({ MODAL_KEY: 'k', MODAL_SECRET: 's', FUSEGNET_AUTH_TOKEN: 't' }), {
  'Modal-Key': 'k',
  'Modal-Secret': 's',
});
eq('an unauthenticated endpoint sends no auth header', modalAuthHeaders({}), {});

check(
  'no FUSegNet request is built without a url (provider is simply not configured)',
  fusegnetRequest({}, 'data:image/png;base64,AA') === null,
);

const fusegReq = fusegnetRequest(
  { FUSEGNET_MODAL_URL: 'https://x--fusegnet.modal.run', MODAL_KEY: 'k', MODAL_SECRET: 's' },
  'data:image/jpeg;base64,AAAA',
);
eq('the FUSegNet request posts to the segment route', fusegReq?.url, 'https://x--fusegnet.modal.run/segment');
eq('with the Modal auth pair', fusegReq?.headers['Modal-Key'], 'k');
eq('and json content-type', fusegReq?.headers['Content-Type'], 'application/json');
eq('carrying the image in the default field', JSON.parse(fusegReq!.body), { image_b64: 'data:image/jpeg;base64,AAAA' });
eq(
  'the segment route can be overridden',
  fusegnetRequest({ FUSEGNET_MODAL_URL: 'https://x--f.modal.run', FUSEGNET_SEGMENT_PATH: '/infer' }, 'd')?.url,
  'https://x--f.modal.run/infer',
);
eq(
  'FUSEGNET_SIZE reaches the body when set',
  JSON.parse(fusegnetRequest({ FUSEGNET_MODAL_URL: 'https://x', FUSEGNET_SIZE: '384' }, 'd')!.body).size,
  384,
);
check(
  'and no size key when unset, so the endpoint keeps its own 512 default',
  JSON.parse(fusegnetRequest({ FUSEGNET_MODAL_URL: 'https://x' }, 'd')!.body).size === undefined,
);
eq(
  'a box passed by a caller reaches the body',
  JSON.parse(fusegnetRequest({ FUSEGNET_MODAL_URL: 'https://x' }, 'd', [10, 20, 30, 40])!.body).box,
  [10, 20, 30, 40],
);
eq('with the default timeout', fusegReq?.timeoutMs, 60_000);
eq(
  'a configured timeout is honoured',
  fusegnetRequest({ FUSEGNET_MODAL_URL: 'https://x', FUSEGNET_TIMEOUT_MS: '5000' }, 'd')?.timeoutMs,
  5000,
);
eq(
  'a nonsense timeout falls back to the default rather than aborting instantly',
  fusegnetRequest({ FUSEGNET_MODAL_URL: 'https://x', FUSEGNET_TIMEOUT_MS: 'soon' }, 'd')?.timeoutMs,
  60_000,
);

check('no SAM 3 request is built without FAL_KEY', sam3Request({}, { imageDataUrl: 'd' }) === null);

const sam3Req = sam3Request({ FAL_KEY: 'fal-secret' }, { imageDataUrl: sam3Image });
eq('the SAM 3 request goes to the fal sync endpoint', sam3Req?.url, 'https://fal.run/fal-ai/sam-3/image');
eq("fal's auth scheme is `Key`, not `Bearer`", sam3Req?.headers.Authorization, 'Key fal-secret');
eq(
  'a pinned fal model is honoured',
  sam3Request({ FAL_KEY: 'k', SAM3_FAL_MODEL: 'fal-ai/sam-3/image/alt' }, { imageDataUrl: 'd' })?.url,
  'https://fal.run/fal-ai/sam-3/image/alt',
);
eq(
  'SAM3_PROMPT overrides the concept prompt',
  JSON.parse(sam3Request({ FAL_KEY: 'k', SAM3_PROMPT: 'pressure injury' }, { imageDataUrl: 'd' })!.body).prompt,
  'pressure injury',
);

// The whole reason `imageBytes` is threaded through: a real header means a real
// pixel coordinate. Without bytes there is no point prompt at all.
const sam3WithBytes = sam3Request(
  { FAL_KEY: 'k' },
  { imageDataUrl: 'd', point: { xPct: 0.5, yPct: 0.5 }, imageBytes: jpegHeader(640, 480) },
);
eq('a point prompt is placed from the real image dimensions', JSON.parse(sam3WithBytes!.body).point_prompts, [
  { x: 320, y: 240, label: 1 },
]);
check(
  'and omitted when the image header could not be read',
  JSON.parse(
    sam3Request({ FAL_KEY: 'k' }, { imageDataUrl: 'd', point: { xPct: 0.5, yPct: 0.5 }, imageBytes: Uint8Array.from([1, 2]) })!
      .body,
  ).point_prompts === undefined,
);

// ---------------------------------------------------------------------------
// Mask plausibility — the guard that stops a mask of the whole leg being measured
// ---------------------------------------------------------------------------

const frame = 1_000_000;
eq('a 5% mask is plausible', maskPlausibility(50_000, frame), 'plausible');
eq('an empty mask is rejected', maskPlausibility(0, frame), 'empty');
eq('a negative area is rejected', maskPlausibility(-1, frame), 'empty');
eq('a 0.01% mask is too small', maskPlausibility(100, frame), 'too_small');
eq('a 90% mask is too large', maskPlausibility(900_000, frame), 'too_large');
eq('exactly at the lower bound is plausible', maskPlausibility(MIN_MASK_AREA_FRACTION * frame, frame), 'plausible');
eq('exactly at the upper bound is plausible', maskPlausibility(MAX_MASK_AREA_FRACTION * frame, frame), 'plausible');
eq('a zero-pixel frame is rejected rather than dividing by zero', maskPlausibility(10, 0), 'empty');
check('every verdict has a human-readable reason', describePlausibility('too_large').length > 10);

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All segmentation wire-format checks passed.');
