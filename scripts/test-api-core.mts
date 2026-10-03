/**
 * Offline tests for the module API's pure core (segmentation spec §6A).
 * Run: npm run test:api
 *
 * Keys, scopes, the envelope, the error shape, canonical hashing (MW-05) and the
 * sandbox mask watermark. The request-path behaviour (401/403/429, approval
 * binding) is exercised live by `npm run check:api` against a running server.
 */
import { PNG } from 'pngjs';

import {
  API_VERSION,
  canonicalHash,
  canonicalise,
  digestsEqual,
  envelope,
  errorBody,
  generateKey,
  hashKey,
  hasScope,
  keyEnvironment,
  keyPrefix,
  limitFor,
  readApiKey,
  readPngComment,
  REGULATORY_STATUS,
  SANDBOX_WATERMARK,
  summariseIssues,
  watermarkMaskRef,
  watermarkPng,
} from '../api/_apiCore.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// --- Keys -------------------------------------------------------------------
const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256);
const sandbox = generateKey('sandbox', bytes);
const live = generateKey('production', bytes);
check('sandbox keys look like mw_sandbox_<32>', /^mw_sandbox_[A-Za-z0-9]{32}$/.test(sandbox), sandbox);
check('production keys look like mw_live_<32>', /^mw_live_[A-Za-z0-9]{32}$/.test(live), live);
check('the environment is read from the key', keyEnvironment(sandbox) === 'sandbox' && keyEnvironment(live) === 'production');
check('the stored prefix is 16 characters', keyPrefix(sandbox).length === 16);

check('x-api-key is read', readApiKey({ 'x-api-key': sandbox }) === sandbox);
check('Authorization: Bearer is read', readApiKey({ authorization: `Bearer ${sandbox}` }) === sandbox);
check('a missing key is null', readApiKey({}) === null);
check('a malformed key is null, not looked up', readApiKey({ 'x-api-key': 'mw_sandbox_short' }) === null);
check('a key with a stray suffix is rejected', readApiKey({ 'x-api-key': `${sandbox}x` }) === null);

check('a key hash is stable and 64 hex chars', hashKey(sandbox) === hashKey(sandbox) && /^[0-9a-f]{64}$/.test(hashKey(sandbox)));
check('digests compare equal', digestsEqual(hashKey(sandbox), hashKey(sandbox)));
check('different digests compare unequal', !digestsEqual(hashKey(sandbox), hashKey(live)));
check('an empty digest never matches', !digestsEqual('', ''));

check('a scoped key has its scope', hasScope(['segment', 'approve'], 'approve'));
check('a scoped key lacks the others', !hasScope(['segment'], 'run'));
check('* holds every scope', hasScope(['*'], 'measure'));

const key = { id: 'k', orgId: 'o', name: 'n', scopes: ['*'], environment: 'sandbox' as const, rateLimitPerMin: 60 };
check('standard endpoints get the full limit', limitFor(key, false) === 60);
check('heavy endpoints get a quarter', limitFor(key, true) === 15);
check('heavy is never zero', limitFor({ ...key, rateLimitPerMin: 2 }, true) === 1);

// --- Envelope + errors --------------------------------------------------------
const env = envelope({ requestId: 'r1', engineVersion: 'cwcs-x', models: { vlm: 'm' } });
check('the envelope carries version, engine, models and regulatory status', env.api_version === API_VERSION && env.engine_version === 'cwcs-x' && env.model_versions.vlm === 'm');
check('regulatory status is investigational until ARTG', env.regulatory_status === 'investigational' && REGULATORY_STATUS === 'investigational');
check('a clean response does not claim degradation', env.degraded === undefined);
const degraded = envelope({ requestId: 'r', engineVersion: 'e', models: {}, degraded: true, reason: 'vlm down' });
check('a degraded response says so, with the reason', degraded.degraded === true && degraded.reason === 'vlm down');
const err = errorBody('approval_required', 'Need approval', 'r2');
check('one error shape: { error: { code, message, request_id } }', err.error.code === 'approval_required' && err.error.request_id === 'r2');
check(
  'validation issues are summarised by path',
  summariseIssues([{ path: ['inputs', 'molnlycke', 'diabetes'], message: 'Expected boolean' }]) === 'inputs.molnlycke.diabetes: Expected boolean',
);

// --- Canonical hashing (MW-05) ------------------------------------------------
check('key order does not change the hash', canonicalHash({ a: 1, b: { c: 2, d: 3 } }) === canonicalHash({ b: { d: 3, c: 2 }, a: 1 }));
check(
  'REGRESSION: nested fields DO change the hash (the old replacer dropped them)',
  canonicalHash({ tissue: { slough: 17 } }) !== canonicalHash({ tissue: { slough: 77 } }),
);
check('undefined fields are ignored', canonicalise({ a: 1, b: undefined }) === canonicalise({ a: 1 }));
check('array order matters', canonicalHash([1, 2]) !== canonicalHash([2, 1]));

// --- Sandbox watermark ----------------------------------------------------------
const png = new PNG({ width: 4, height: 4 });
png.data.fill(255);
const raw = Uint8Array.from(PNG.sync.write(png));
const marked = watermarkPng(raw);
check('the watermark is readable from the PNG', readPngComment(marked) === SANDBOX_WATERMARK);
const reread = PNG.sync.read(Buffer.from(marked));
check('the watermarked PNG still decodes to the same pixels', reread.width === 4 && Buffer.compare(reread.data, png.data) === 0);
check('non-PNG bytes pass through untouched', watermarkPng(Uint8Array.from([1, 2, 3])).length === 3);
const ref = `data:image/png;base64,${Buffer.from(raw).toString('base64')}`;
const markedRef = watermarkMaskRef(ref)!;
check('a mask data URI is watermarked', readPngComment(Buffer.from(markedRef.split(',')[1], 'base64')) === SANDBOX_WATERMARK);
check('a URL mask passes through', watermarkMaskRef('https://v3.fal.media/x.png') === 'https://v3.fal.media/x.png');

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All API-core checks passed.');
