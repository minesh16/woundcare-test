import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The module API's pure core (segmentation build spec §6A) — no relative
 * imports, so `test:api` loads it under `node --experimental-strip-types`.
 *
 * Everything that DECIDES lives here: key format and hashing, scopes, the
 * response envelope, the error shape, canonical hashing, and the sandbox mask
 * watermark. `_http.ts` wires it to requests, Supabase and the handlers.
 */

export const API_VERSION = 'v1';

/**
 * Every response says this until ARTG inclusion (spec §6A, regulatory gate).
 * An API that returns a pathway or a referral is itself the medical device.
 */
export const REGULATORY_STATUS = 'investigational';

/** Module scopes a key can hold. `*` holds them all. */
export const SCOPES = [
  'segment',
  'approve',
  'measure',
  'tissue',
  'vlm',
  'evaluate',
  'report',
  'run',
  'baseline',
  'analyze',
] as const;
export type Scope = (typeof SCOPES)[number];

export type KeyEnvironment = 'sandbox' | 'production';

export type ApiKey = {
  id: string;
  orgId: string;
  name: string;
  scopes: string[];
  environment: KeyEnvironment;
  rateLimitPerMin: number;
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** `mw_sandbox_<32 base62>` or `mw_live_<32 base62>`. */
const KEY_PATTERN = /^mw_(sandbox|live)_[A-Za-z0-9]{32}$/;

/** Characters of the key kept in clear for lookup and display. */
export const KEY_PREFIX_LENGTH = 16;

/** Read a key from `x-api-key` or `Authorization: Bearer`. Null when absent or malformed. */
export function readApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const direct = one(headers['x-api-key'])?.trim();
  const bearer = one(headers.authorization)?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const key = direct || bearer || null;
  return key && KEY_PATTERN.test(key) ? key : null;
}

export function keyEnvironment(key: string): KeyEnvironment {
  return key.startsWith('mw_live_') ? 'production' : 'sandbox';
}

export function keyPrefix(key: string): string {
  return key.slice(0, KEY_PREFIX_LENGTH);
}

/** SHA-256 hex of a key. Keys are high-entropy random, so a fast hash is right here. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function hasScope(scopes: readonly string[], needed: Scope): boolean {
  return scopes.includes('*') || scopes.includes(needed);
}

/** Generate a new key from 32 random bytes → base62. */
export function generateKey(environment: KeyEnvironment, randomBytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let body = '';
  for (let i = 0; i < 32; i += 1) body += alphabet[randomBytes[i] % alphabet.length];
  return `mw_${environment === 'production' ? 'live' : 'sandbox'}_${body}`;
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/** Endpoints that call a billed frontier model or GPU, per minute, as a share of the key's limit. */
export const HEAVY_SHARE = 0.25;

export function limitFor(key: ApiKey, heavy: boolean): number {
  return heavy ? Math.max(1, Math.floor(key.rateLimitPerMin * HEAVY_SHARE)) : key.rateLimitPerMin;
}

// ---------------------------------------------------------------------------
// Envelope + errors (§6A.2)
// ---------------------------------------------------------------------------

export type Envelope = {
  request_id: string;
  api_version: string;
  engine_version: string;
  model_versions: Record<string, string | null>;
  regulatory_status: string;
  degraded?: boolean;
  reason?: string;
};

export function envelope(args: {
  requestId: string;
  engineVersion: string;
  models: Record<string, string | null>;
  degraded?: boolean;
  reason?: string;
}): Envelope {
  const out: Envelope = {
    request_id: args.requestId,
    api_version: API_VERSION,
    engine_version: args.engineVersion,
    model_versions: args.models,
    regulatory_status: REGULATORY_STATUS,
  };
  if (args.degraded) {
    out.degraded = true;
    if (args.reason) out.reason = args.reason;
  }
  return out;
}

export type ErrorCode =
  | 'method_not_allowed'
  | 'unauthorized'
  | 'forbidden_scope'
  | 'production_unavailable'
  | 'rate_limited'
  | 'invalid_json'
  | 'validation_error'
  | 'approval_required'
  | 'approval_invalid'
  | 'approval_mismatch'
  | 'idempotency_conflict'
  | 'unprocessable'
  | 'internal_error';

/** The one error shape (§6A.2). `message` is ours — never an upstream body (MW-13). */
export function errorBody(code: ErrorCode, message: string, requestId: string) {
  return { error: { code, message, request_id: requestId } };
}

/** Compact, user-facing summary of Zod issues (path: message; at most five). */
export function summariseIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(body)'}: ${i.message}`)
    .join('; ');
}

// ---------------------------------------------------------------------------
// Canonical hashing (docs/SECURITY_AUDIT.md MW-05)
// ---------------------------------------------------------------------------

/** Deterministic serialisation: keys sorted at EVERY level; undefined dropped. */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalise(value));
}

// ---------------------------------------------------------------------------
// Sandbox watermark on returned masks (§6A.2)
// ---------------------------------------------------------------------------

export const SANDBOX_WATERMARK = 'MendWise sandbox - investigational, not for clinical use';

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Add a PNG `tEXt` chunk (keyword "Comment") right after IHDR. The watermark is
 * METADATA, deliberately: a visible stamp would change which pixels are wound,
 * and every consumer of the mask measures pixels. Non-PNG input is returned
 * unchanged.
 */
export function watermarkPng(png: Uint8Array, text: string = SANDBOX_WATERMARK): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 33 || !signature.every((b, i) => png[i] === b)) return png;
  const ihdrEnd = 8 + 4 + 4 + 13 + 4; // signature + length + type + IHDR data + CRC
  const data = Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
  const type = Buffer.from('tEXt', 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Uint8Array.from(Buffer.concat([png.subarray(0, ihdrEnd), length, type, data, crc, png.subarray(ihdrEnd)]));
}

/** Watermark a PNG data URI; other references pass through. */
export function watermarkMaskRef(ref: string | null): string | null {
  if (!ref || !ref.startsWith('data:image/png;base64,')) return ref;
  const bytes = Buffer.from(ref.slice('data:image/png;base64,'.length), 'base64');
  return `data:image/png;base64,${Buffer.from(watermarkPng(bytes)).toString('base64')}`;
}

/** Read the first tEXt "Comment" chunk, if any — for tests and for integrators. */
export function readPngComment(png: Uint8Array): string | null {
  let offset = 8;
  const buf = Buffer.from(png);
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'tEXt') {
      const body = buf.subarray(offset + 8, offset + 8 + length);
      const nul = body.indexOf(0);
      if (nul > 0 && body.toString('latin1', 0, nul) === 'Comment') return body.toString('latin1', nul + 1);
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return null;
}
