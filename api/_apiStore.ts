import { randomUUID } from 'node:crypto';

import { digestsEqual, hashKey, keyEnvironment, keyPrefix, type ApiKey } from './_apiCore';
import { db } from './_supabase';

/**
 * The module API's state: keys, rate limits, idempotency, approvals and the
 * request log (segmentation build spec §6A.2). Supabase when configured.
 *
 * Fallbacks are in-memory and per-instance, which is right for local dev and a
 * degraded database — but on serverless, a memory fallback is NOT a shared
 * limit or a durable approval. `/health` reports `store: false` when that is
 * what is running.
 */

// ===========================================================================
// Keys
// ===========================================================================

/**
 * The app's own key. The app calls the same API as integrators (§6A.3: "one API
 * and no private side door"), so it needs a key — and a key in an Expo bundle is
 * public by definition. This is a demo gate that makes drive-by abuse visible
 * and rate-limited, NOT an identity (docs/SECURITY_AUDIT.md MW-01, P1).
 */
function appKey(raw: string): ApiKey | null {
  const configured = process.env.MENDWISE_APP_KEY;
  if (!configured || !digestsEqual(hashKey(raw), hashKey(configured))) return null;
  return {
    id: 'app',
    orgId: 'mendwise',
    name: 'MendWise app',
    scopes: ['*'],
    environment: keyEnvironment(raw),
    rateLimitPerMin: Number(process.env.MENDWISE_APP_RATE_LIMIT ?? 240),
  };
}

const keyCache = new Map<string, { key: ApiKey | null; at: number }>();
const KEY_CACHE_MS = 60_000;

/** Verify a well-formed key. Null when unknown or revoked. */
export async function verifyKey(raw: string): Promise<ApiKey | null> {
  const app = appKey(raw);
  if (app) return app;

  const hash = hashKey(raw);
  const cached = keyCache.get(hash);
  if (cached && Date.now() - cached.at < KEY_CACHE_MS) return cached.key;

  const client = db();
  if (!client) return null;
  const { data, error } = await client
    .from('api_keys')
    .select('id, org_id, name, key_hash, scopes, environment, rate_limit_per_min, revoked_at')
    .eq('key_prefix', keyPrefix(raw))
    .maybeSingle();
  let key: ApiKey | null = null;
  if (!error && data && !data.revoked_at && digestsEqual(hash, data.key_hash as string)) {
    key = {
      id: data.id as string,
      orgId: data.org_id as string,
      name: data.name as string,
      scopes: (data.scopes as string[]) ?? [],
      environment: data.environment as ApiKey['environment'],
      rateLimitPerMin: data.rate_limit_per_min as number,
    };
    // Best-effort; never on the request's critical path.
    void client.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id).then(() => undefined);
  }
  keyCache.set(hash, { key, at: Date.now() });
  return key;
}

// ===========================================================================
// Rate limits
// ===========================================================================

const memoryWindows = new Map<string, { windowStart: number; hits: number }>();

export async function rateLimitHit(
  bucket: string,
  limit: number,
): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }> {
  const client = db();
  if (client) {
    const { data, error } = await client.rpc('api_rate_limit_hit', { p_bucket: bucket, p_limit: limit, p_window_seconds: 60 });
    const row = Array.isArray(data) ? data[0] : data;
    if (!error && row) {
      return { allowed: Boolean(row.allowed), remaining: Number(row.remaining), resetSeconds: Number(row.reset_seconds) };
    }
  }
  const now = Date.now();
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const entry = memoryWindows.get(bucket);
  const hits = entry && entry.windowStart === windowStart ? entry.hits + 1 : 1;
  memoryWindows.set(bucket, { windowStart, hits });
  return { allowed: hits <= limit, remaining: Math.max(0, limit - hits), resetSeconds: Math.ceil((windowStart + 60_000 - now) / 1000) };
}

// ===========================================================================
// Idempotency
// ===========================================================================

type StoredResponse = { requestHash: string; status: number; response: unknown };
const memoryIdem = new Map<string, StoredResponse & { at: number }>();
const IDEM_TTL_MS = 24 * 60 * 60 * 1000;

export async function idempotencyGet(keyId: string, idemKey: string, endpoint: string): Promise<StoredResponse | null> {
  const client = db();
  if (client) {
    const { data } = await client
      .from('idempotency_records')
      .select('request_hash, status, response, created_at')
      .eq('key_id', keyId)
      .eq('idem_key', idemKey)
      .eq('endpoint', endpoint)
      .maybeSingle();
    if (data && Date.now() - new Date(data.created_at as string).getTime() < IDEM_TTL_MS) {
      return { requestHash: data.request_hash as string, status: data.status as number, response: data.response };
    }
    return null;
  }
  const hit = memoryIdem.get(`${keyId}|${idemKey}|${endpoint}`);
  return hit && Date.now() - hit.at < IDEM_TTL_MS ? hit : null;
}

export async function idempotencyPut(
  keyId: string,
  idemKey: string,
  endpoint: string,
  record: StoredResponse,
): Promise<void> {
  const client = db();
  if (client) {
    await client.from('idempotency_records').upsert({
      key_id: keyId,
      idem_key: idemKey,
      endpoint,
      request_hash: record.requestHash,
      status: record.status,
      response: record.response,
      created_at: new Date().toISOString(),
    });
    return;
  }
  memoryIdem.set(`${keyId}|${idemKey}|${endpoint}`, { ...record, at: Date.now() });
}

// ===========================================================================
// Approvals (§6A.1)
// ===========================================================================

export type ApprovalRecord = {
  id: string;
  keyId: string;
  orgId: string;
  assessmentId: string;
  imageSha256: string;
  maskSha256: string;
  approval: 'approved' | 'adjusted' | 'drawn';
  clinicianId: string | null;
  provider: string | null;
  model: string | null;
  correctionId: string | null;
  expiresAt: string;
};

const memoryApprovals = new Map<string, ApprovalRecord>();
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export async function createApproval(record: Omit<ApprovalRecord, 'id' | 'expiresAt'>): Promise<ApprovalRecord> {
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const client = db();
  if (client) {
    const { data, error } = await client
      .from('approvals')
      .insert({
        key_id: record.keyId,
        org_id: record.orgId,
        assessment_id: record.assessmentId,
        image_sha256: record.imageSha256,
        mask_sha256: record.maskSha256,
        approval: record.approval,
        clinician_id: record.clinicianId,
        provider: record.provider,
        model: record.model,
        correction_id: record.correctionId,
        expires_at: expiresAt,
      })
      .select('id')
      .single();
    if (!error && data) return { ...record, id: data.id as string, expiresAt };
    console.warn('Approval write failed — holding it in memory for this instance only.', error?.message);
  }
  const approval = { ...record, id: randomUUID(), expiresAt };
  memoryApprovals.set(approval.id, approval);
  return approval;
}

export async function loadApproval(id: string): Promise<ApprovalRecord | null> {
  const memory = memoryApprovals.get(id);
  if (memory) return memory;
  const client = db();
  if (!client || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await client.from('approvals').select('*').eq('id', id).maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    keyId: data.key_id as string,
    orgId: data.org_id as string,
    assessmentId: data.assessment_id as string,
    imageSha256: data.image_sha256 as string,
    maskSha256: data.mask_sha256 as string,
    approval: data.approval as ApprovalRecord['approval'],
    clinicianId: (data.clinician_id as string) ?? null,
    provider: (data.provider as string) ?? null,
    model: (data.model as string) ?? null,
    correctionId: (data.correction_id as string) ?? null,
    expiresAt: data.expires_at as string,
  };
}

// ===========================================================================
// Request log (§6A.2 audit log)
// ===========================================================================

export type ApiCallRecord = {
  request_id: string;
  key_id: string | null;
  org_id: string | null;
  environment: string | null;
  endpoint: string;
  status: number;
  latency_ms: number;
  input_sha256: string | null;
  image_sha256: string | null;
  approval_id: string | null;
  api_version: string;
  engine_version: string;
  model_versions: Record<string, string | null>;
  degraded: boolean;
  outcome: Record<string, unknown> | null;
};

export async function logApiCall(record: ApiCallRecord): Promise<void> {
  const client = db();
  if (!client) {
    console.log('[api]', JSON.stringify(record));
    return;
  }
  const { error } = await client.from('api_calls').insert(record);
  if (error) console.log('[api]', JSON.stringify(record));
}
