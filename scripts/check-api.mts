/**
 * Live acceptance checks for the module API (segmentation spec §6A.3), against
 * a running server (`vercel dev` or `npm run dev:api`).
 *
 *   set -a; . ./.env.local; set +a
 *   npm run check:api -- --image=path/to/photo.jpg [--base=http://localhost:3000]
 *
 * Mints three short-lived test keys (scoped, rate-limited, production) straight
 * into `api_keys`, and REVOKES them at the end. Uses the app key
 * (MENDWISE_APP_KEY) for the happy path. The photo must be synthetic or public.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

import { generateKey, hashKey, keyPrefix, readPngComment } from '../api/_apiCore.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]));
const BASE = args.base ?? 'http://localhost:3000';
const APP_KEY = process.env.MENDWISE_APP_KEY ?? '';
if (!args.image || !APP_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Usage: npm run check:api -- --image=photo.jpg  (with MENDWISE_APP_KEY and SUPABASE_* in the environment)');
  process.exit(1);
}
const image = readFileSync(args.image).toString('base64');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : '');
  }
}

type Reply = { status: number; json: Record<string, any>; headers: Headers; ms: number };
async function post(path: string, body: unknown, key: string | null = APP_KEY, extra: Record<string, string> = {}): Promise<Reply> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers, ms: Date.now() - t0 };
}

// --- Test keys ------------------------------------------------------------------
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const minted: string[] = [];
async function mint(scopes: string[], env: 'sandbox' | 'production', limit = 60): Promise<string> {
  const key = generateKey(env, randomBytes(32));
  const { data, error } = await db
    .from('api_keys')
    .insert({ org_id: 'check-api', name: `check:api ${scopes.join(',')}`, key_prefix: keyPrefix(key), key_hash: hashKey(key), scopes, environment: env, rate_limit_per_min: limit })
    .select('id')
    .single();
  if (error) throw new Error(`could not mint a test key: ${error.message}`);
  minted.push(data.id as string);
  return key;
}

try {
  const segmentOnly = await mint(['segment'], 'sandbox');
  const limited = await mint(['evaluate'], 'sandbox', 2);
  const production = await mint(['*'], 'production');

  // --- 1. Rejected without a key; reachable with one ----------------------------
  const modules = ['segment', 'mask', 'approve', 'measure', 'tissue', 'vlm-features', 'evaluate', 'report', 'run', 'correction', 'create', 'baseline'];
  for (const m of modules) {
    const r = await post(`/api/v1/assessments/${m}`, {}, null);
    check(`${m}: 401 without a key, in the one error shape`, r.status === 401 && r.json.error?.code === 'unauthorized' && Boolean(r.json.error?.request_id), r);
  }
  const legacy = await post('/api/segment', {}, null);
  check('/api/segment alias: 401 without a key', legacy.status === 401);
  const badKey = await post('/api/v1/assessments/evaluate', {}, `mw_sandbox_${'x'.repeat(32)}`);
  check('an unknown key is 401', badKey.status === 401);

  // --- 2. Scope + production gate ------------------------------------------------
  const outOfScope = await post('/api/v1/assessments/approve', {}, segmentOnly);
  check('a segment-only key cannot approve (403 forbidden_scope)', outOfScope.status === 403 && outOfScope.json.error?.code === 'forbidden_scope', outOfScope.json);
  const prod = await post('/api/v1/assessments/evaluate', {}, production);
  check('a production key is refused until ARTG (403)', prod.status === 403 && prod.json.error?.code === 'production_unavailable', prod.json);

  // --- 3. Validation at the door (MW-12) -----------------------------------------
  const evalInputs = { tissue: { necrosis: 0, slough: 17, granulation: 82, epithelial: 1, other: 0 }, exudate: 'moderate', infection: 'yes', markerFound: true };
  const notJson = await post('/api/v1/assessments/evaluate', '{nope', APP_KEY);
  check('invalid JSON is 400 invalid_json', notJson.status === 400 && notJson.json.error?.code === 'invalid_json', notJson.json);
  const stringBool = await post('/api/v1/assessments/evaluate', { inputs: { ...evalInputs, molnlycke: { diabetes: 'no' } } });
  check(
    "REGRESSION: the string 'no' for a boolean is a 400, not a silent referral",
    stringBool.status === 400 && /molnlycke\.diabetes/.test(stringBool.json.error?.message ?? ''),
    stringBool.json,
  );
  const unknownField = await post('/api/v1/assessments/evaluate', { inputs: { ...evalInputs, pathway: 3 } });
  check('an unknown engine field is rejected (strict contract)', unknownField.status === 400, unknownField.json);

  // --- 4. Envelope + idempotency + rate limit -------------------------------------
  const evaluated = await post('/api/v1/assessments/evaluate', { inputs: evalInputs });
  check('evaluate works with a sandbox key', evaluated.status === 200 && evaluated.json.result?.axes?.tissue === 'slough', evaluated.json);
  check(
    'every response carries the envelope',
    evaluated.json.request_id && evaluated.json.api_version === 'v1' && evaluated.json.engine_version?.startsWith('cwcs') && evaluated.json.regulatory_status === 'investigational' && typeof evaluated.json.model_versions === 'object',
    evaluated.json,
  );
  check('the server minted the record id (MW-02)', /^asmt-[0-9a-f-]{36}$/.test(evaluated.json.assessment_id ?? ''), evaluated.json.assessment_id);
  const idem = { 'Idempotency-Key': `check-${Date.now()}` };
  const first = await post('/api/v1/assessments/evaluate', { inputs: evalInputs }, APP_KEY, idem);
  const replay = await post('/api/v1/assessments/evaluate', { inputs: evalInputs }, APP_KEY, idem);
  check('Idempotency-Key replays the original response', replay.headers.get('idempotent-replayed') === 'true' && replay.json.request_id === first.json.request_id, { first: first.json.request_id, replay: replay.json.request_id });
  const conflict = await post('/api/v1/assessments/evaluate', { inputs: { ...evalInputs, exudate: 'low' } }, APP_KEY, idem);
  check('the same key with a different body is 422 idempotency_conflict', conflict.status === 422 && conflict.json.error?.code === 'idempotency_conflict', conflict.json);

  const r1 = await post('/api/v1/assessments/evaluate', { inputs: evalInputs }, limited);
  const r2 = await post('/api/v1/assessments/evaluate', { inputs: evalInputs }, limited);
  const r3 = await post('/api/v1/assessments/evaluate', { inputs: evalInputs }, limited);
  check('a 2/min key gets two calls, then 429 with Retry-After', r1.status === 200 && r2.status === 200 && r3.status === 429 && Number(r3.headers.get('retry-after')) > 0, [r1.status, r2.status, r3.status, r3.headers.get('retry-after')]);

  // --- 5. The flow: segment → approve → measure → run -----------------------------
  const seg = await post('/api/v1/assessments/segment', { base64: image, body_zone: 'lower_leg_left' });
  check('segment: 200 with a draft outline', seg.status === 200 && Boolean(seg.json.mask) && (seg.json.outline?.length ?? 0) >= 3, { status: seg.status, source: seg.json.source, err: seg.json.error });
  console.log(`  segment: ${seg.json.source} score=${seg.json.score} confidence=${seg.json.confidence} ${seg.ms} ms (model ${seg.json.latencyMs} ms)`);
  check('segment: source/score/box/confidence/model/latency per spec §3.2', ['sam3', 'fusegnet', 'hsv'].includes(seg.json.source) && 'score' in seg.json && 'box' in seg.json && typeof seg.json.latencyMs === 'number');
  check('segment: the returned mask carries the sandbox watermark', readPngComment(Buffer.from(String(seg.json.mask).split(',')[1] ?? '', 'base64'))?.includes('sandbox') === true);
  check('segment: model versions name the boundary model', seg.json.model_versions?.segmentation === seg.json.model, seg.json.model_versions);

  const tissueNoApproval = await post('/api/v1/assessments/tissue', { base64: image, mask: seg.json.mask });
  check('ACCEPTANCE: /tissue without an approval_id is 403', tissueNoApproval.status === 403 && tissueNoApproval.json.error?.code === 'approval_required', tissueNoApproval.json);
  const runNoApproval = await post('/api/v1/assessments/run', { base64: image, mask: seg.json.mask, inputs: evalInputs });
  check('/run without an approval is 403 — no auto-approval', runNoApproval.status === 403, runNoApproval.json);

  const assessmentId = `check-api-${Date.now()}`;
  const approved = await post('/api/v1/assessments/approve', {
    base64: image,
    assessment_id: assessmentId,
    approval: 'approved',
    final_mask: seg.json.mask,
    ai_mask: seg.json.mask,
    clinician_id: 'check-api',
    provider: seg.json.source,
    model: seg.json.model,
    confidence: seg.json.confidence,
    score: seg.json.score,
    image_source: 'synthetic',
    body_zone: 'lower_leg_left',
  });
  check('approve: 200 with an approval_id and a correction row (IoU 1)', approved.status === 200 && Boolean(approved.json.approval_id) && approved.json.iou === 1, approved.json);
  const approvalId = approved.json.approval_id;

  const wrongImage = await post('/api/v1/assessments/tissue', { base64: image.slice(0, -8) + 'AAAAAAA=', mask: seg.json.mask, approval_id: approvalId });
  check('a different image under the same approval is 403 approval_mismatch', wrongImage.status === 403 && wrongImage.json.error?.code === 'approval_mismatch', wrongImage.json);
  const otherMask = await post('/api/v1/assessments/mask', { polygon: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.2, y: 0.3 }] });
  const wrongMask = await post('/api/v1/assessments/tissue', { base64: image, mask: otherMask.json.mask, approval_id: approvalId });
  check('a different mask under the same approval is 403 approval_mismatch', wrongMask.status === 403 && wrongMask.json.error?.code === 'approval_mismatch', wrongMask.json);
  const fakeApproval = await post('/api/v1/assessments/tissue', { base64: image, mask: seg.json.mask, approval_id: '00000000-0000-0000-0000-000000000000' });
  check('an unknown approval is 403 approval_invalid', fakeApproval.status === 403 && fakeApproval.json.error?.code === 'approval_invalid', fakeApproval.json);

  const measured = await post('/api/v1/assessments/measure', { base64: image, mask: seg.json.mask, approval_id: approvalId });
  const m = measured.json.measurement;
  check('measure: 200 with geometry, scale, white balance and both classifiers', measured.status === 200 && m?.geometry && 'scale' in m && m?.whiteBalance && m?.comparison?.absolute, measured.json.error ?? m);
  console.log(
    `  measure: ${m?.scale ? `${m.scale.pxPerCm.toFixed(1)} px/cm` : 'no scale'}, ${m?.geometry?.areaCm2 ?? '—'} cm², ${m?.geometry?.lengthCm ?? '—'} × ${m?.geometry?.widthCm ?? '—'} cm, perimeter ${m?.geometry?.perimeterCm ?? '—'} cm, WB ${m?.whiteBalance?.applied ? 'applied' : m?.whiteBalance?.reason}, tissue abs ${JSON.stringify(m?.comparison?.absolute)} rel ${JSON.stringify(m?.comparison?.relative)}`,
  );

  const tissue = await post('/api/v1/assessments/tissue', { base64: image, mask: seg.json.mask, approval_id: approvalId });
  check('tissue: 200 under a valid approval', tissue.status === 200 && tissue.json.tissue?.maskSource === 'model', tissue.json.error ?? tissue.json.tissue);

  const correction = await post('/api/v1/assessments/correction', { correction_id: approved.json.correction_id, tissue_auto: 'slough', tissue_final: 'granulating', monk_tone: 3 });
  check('correction: the tissue override joins the approval row', correction.status === 200 && correction.json.tissue_override === true, correction.json);

  const run = await post('/api/v1/assessments/run', {
    base64: image,
    mask: seg.json.mask,
    approval_id: approvalId,
    inputs: { ...evalInputs, tissueOverride: 'granulating' },
    px_per_cm: m?.scale?.pxPerCm ?? null,
    area_cm2: m?.geometry?.areaCm2 ?? null,
    body_zone_label: 'Left lower leg',
  });
  const frames = String(run.json.raw ?? '')
    .split('\n\n')
    .filter(Boolean)
    .map((f) => ({ event: /event: (\w+)/.exec(f)?.[1], data: /data: (.*)/s.exec(f)?.[1] }));
  const events = frames.map((f) => f.event);
  check('run: streams meta → steps → decision → result', events[0] === 'meta' && events.includes('decision') && events.at(-1) === 'result', events);
  const decision = JSON.parse(frames.find((f) => f.event === 'decision')?.data ?? '{}');
  check('run: the confirmed tissue drives the decision', decision.result?.axes?.tissue === 'granulating', decision.result?.axes);
  const result = JSON.parse(frames.find((f) => f.event === 'result')?.data ?? '{}');
  check('run: the result carries the envelope and the approval id', result.regulatory_status === 'investigational' && result.segment?.approvalId === approvalId, { reg: result.regulatory_status, approval: result.segment?.approvalId });
  console.log(`  run: ${run.ms} ms, pathway ${decision.result?.cwcsPathwayId}, referrals ${decision.result?.referrals?.map((r: { code: string }) => r.code).join(', ')}`);

  // --- 6. OpenAPI ---------------------------------------------------------------
  const openapi = await fetch(`${BASE}/api/v1/openapi`).then((r) => r.json());
  check('GET /api/v1/openapi is an OpenAPI 3.1 document of every module', openapi.openapi === '3.1.0' && Object.keys(openapi.paths ?? {}).length >= 12);

  // --- 7. The audit trail ----------------------------------------------------------
  await new Promise((r) => setTimeout(r, 1500));
  const { data: calls } = await db.from('api_calls').select('endpoint, status, approval_id, image_sha256, regulatory_status:api_version').eq('approval_id', approvalId);
  check('api_calls logs approval-bound requests with the image hash, no image', (calls?.length ?? 0) >= 3 && calls!.every((c) => /^[0-9a-f]{64}$/.test(String(c.image_sha256))), calls);
} finally {
  if (minted.length) await db.from('api_keys').update({ revoked_at: new Date().toISOString() }).in('id', minted);
}

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All live API checks passed.');
