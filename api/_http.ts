import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { z } from 'zod';

import { CWCS_RULES_VERSION } from '../src/decision/engine';
import {
  canonicalHash,
  envelope,
  errorBody,
  hasScope,
  limitFor,
  readApiKey,
  sha256Hex,
  summariseIssues,
  watermarkMaskRef,
  type ApiKey,
  type ErrorCode,
  type Scope,
} from './_apiCore';
import {
  idempotencyGet,
  idempotencyPut,
  loadApproval,
  logApiCall,
  rateLimitHit,
  verifyKey,
  type ApprovalRecord,
} from './_apiStore';
import { imageSha256 } from './_image';
import { loadMaskPixels, maskSha256 } from './_maskIO';

/**
 * Every module endpoint goes through `endpoint()` (segmentation build spec §6A).
 * In order:
 *
 *   request id → method → API key → scope → production gate → rate limit →
 *   JSON + Zod validation → idempotency replay → approval binding → handler →
 *   envelope (+ sandbox watermark) → idempotency store → request log
 *
 * so no handler can forget a step, and the app — which calls these same
 * endpoints — has no private side door (§6A.3).
 */

export type HandlerContext = {
  requestId: string;
  key: ApiKey;
  /** Present on `requiresApproval` endpoints: the verified clinician sign-off. */
  approval: ApprovalRecord | null;
  /** SHA-256 of `input.base64`, when the request carries an image. */
  imageSha256: string | null;
  req: VercelRequest;
  res: VercelResponse;
  /** For streaming handlers: the envelope fields to put in the stream. */
  meta: () => ReturnType<typeof envelope>;
};

export type HandlerResult<O> = {
  status?: number;
  body?: O;
  error?: { code: ErrorCode; message: string };
  degraded?: boolean;
  reason?: string;
  /** Model versions this call actually used, merged over the configured ones. */
  models?: Record<string, string | null>;
  /** Small, de-identified summary for the request log. */
  outcome?: Record<string, unknown>;
  /** The handler wrote the response itself (streaming). */
  streamed?: boolean;
};

/** Configured model versions — the handler adds the ones it actually resolved. */
export function configuredModels(): Record<string, string | null> {
  return {
    segmentation: process.env.FAL_KEY ? process.env.SAM3_FAL_MODEL ?? 'fal-ai/sam-3/image' : null,
    second_opinion: process.env.FUSEGNET_MODAL_URL ? process.env.FUSEGNET_MODEL_LABEL ?? 'fusegnet-effb7-pscse' : null,
    vlm: null,
    llm: null,
  };
}

function clientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

/** Add the sandbox watermark to any `mask` data URI in the response (two levels deep). */
function watermark(value: unknown, depth = 0): unknown {
  if (depth > 3 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => watermark(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = k === 'mask' && typeof v === 'string' ? watermarkMaskRef(v) : watermark(v, depth + 1);
  }
  return out;
}

export function endpoint<S extends z.ZodType>(spec: {
  name: string;
  scope: Scope;
  input: S;
  method?: 'POST';
  /** Calls a billed frontier model or GPU: a quarter of the key's per-minute limit. */
  heavy?: boolean;
  /** Requires `approval_id` bound to `base64` + `mask` (§6A.1). */
  requiresApproval?: boolean;
  /** Streaming handlers write their own response; idempotency does not apply. */
  stream?: boolean;
  handle: (input: z.infer<S>, ctx: HandlerContext) => Promise<HandlerResult<unknown>>;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    res.setHeader('X-Request-Id', requestId);

    let key: ApiKey | null = null;
    let status = 500;
    let degraded = false;
    let models = configuredModels();
    let approval: ApprovalRecord | null = null;
    let inputSha: string | null = null;
    let imageSha: string | null = null;
    let outcome: Record<string, unknown> | null = null;

    const meta = () => envelope({ requestId, engineVersion: CWCS_RULES_VERSION, models, degraded });
    const fail = (code: ErrorCode, message: string, httpStatus: number) => {
      status = httpStatus;
      if (!res.headersSent) res.status(httpStatus).json(errorBody(code, message, requestId));
    };

    try {
      if (req.method !== (spec.method ?? 'POST')) return fail('method_not_allowed', 'Method not allowed.', 405);

      // --- Authentication + authorisation -----------------------------------
      const raw = readApiKey(req.headers);
      key = raw ? await verifyKey(raw) : null;
      if (!key) return fail('unauthorized', 'A valid API key is required (x-api-key header).', 401);
      if (!hasScope(key.scopes, spec.scope)) return fail('forbidden_scope', `This key is not scoped for "${spec.scope}".`, 403);
      if (key.environment === 'production') {
        return fail(
          'production_unavailable',
          'Production access starts after ARTG inclusion. Use a sandbox key (synthetic or public images only).',
          403,
        );
      }

      // --- Rate limit (per key; per key + IP for the shared app key) --------
      const bucket = `${key.id}:${key.id === 'app' ? clientIp(req) : 'all'}:${spec.heavy ? 'heavy' : 'std'}`;
      const limit = limitFor(key, Boolean(spec.heavy));
      const rate = await rateLimitHit(bucket, limit);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.resetSeconds));
        return fail('rate_limited', `Rate limit reached. Retry after ${rate.resetSeconds}s.`, 429);
      }

      // --- Body: JSON, then the contract ------------------------------------
      let body: unknown;
      try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
      } catch {
        return fail('invalid_json', 'The request body is not valid JSON.', 400);
      }
      const parsed = spec.input.safeParse(body);
      if (!parsed.success) return fail('validation_error', summariseIssues(parsed.error.issues), 400);
      const input = parsed.data as z.infer<S> & { base64?: string; mask?: string; approval_id?: string };
      inputSha = canonicalHash(body);
      if (typeof input.base64 === 'string') imageSha = imageSha256(input.base64);

      // --- Idempotency -------------------------------------------------------
      const idemHeader = req.headers['idempotency-key'];
      const idemKey = typeof idemHeader === 'string' && idemHeader.length <= 200 ? idemHeader : null;
      if (idemKey && !spec.stream) {
        const stored = await idempotencyGet(key.id, idemKey, spec.name);
        if (stored) {
          if (stored.requestHash !== inputSha) {
            return fail('idempotency_conflict', 'This Idempotency-Key was used with a different request body.', 422);
          }
          status = stored.status;
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(stored.status).json(stored.response);
          return;
        }
      }

      // --- Approval binding (§6A.1) ------------------------------------------
      if (spec.requiresApproval) {
        if (!input.approval_id) return fail('approval_required', 'Clinician approval is required (approval_id).', 403);
        approval = await loadApproval(input.approval_id);
        if (!approval || approval.orgId !== key.orgId || Date.parse(approval.expiresAt) < Date.now()) {
          return fail('approval_invalid', 'The approval is unknown, expired, or belongs to another organisation.', 403);
        }
        if (imageSha !== approval.imageSha256) {
          return fail('approval_mismatch', 'This image is not the one that was approved.', 403);
        }
        const mask = input.mask ? await loadMaskPixels(input.mask) : null;
        if (!mask) return fail('unprocessable', 'The mask could not be read.', 422);
        if (maskSha256(mask) !== approval.maskSha256) {
          return fail('approval_mismatch', 'This mask is not the one that was approved.', 403);
        }
      }

      // --- The handler ---------------------------------------------------------
      const result = await spec.handle(input, { requestId, key, approval, imageSha256: imageSha, req, res, meta });
      if (result.models) models = { ...models, ...result.models };
      degraded = Boolean(result.degraded);
      outcome = result.outcome ?? null;

      if (result.streamed) {
        status = res.statusCode || 200;
        return;
      }
      if (result.error) return fail(result.error.code, result.error.message, result.status ?? 400);

      status = result.status ?? 200;
      const payload = {
        ...((key.environment === 'sandbox' ? watermark(result.body) : result.body) as Record<string, unknown>),
        ...envelope({ requestId, engineVersion: CWCS_RULES_VERSION, models, degraded, reason: result.reason }),
      };
      if (idemKey && !spec.stream && status < 500) {
        await idempotencyPut(key.id, idemKey, spec.name, { requestHash: inputSha, status, response: payload });
      }
      res.status(status).json(payload);
    } catch (error) {
      // Our message, never the upstream one (MW-13); the detail goes to the log.
      console.error(`[${spec.name}] ${requestId} failed:`, error);
      if (res.headersSent) {
        status = 500;
        res.end();
      } else {
        fail('internal_error', 'The request could not be completed.', 500);
      }
    } finally {
      void logApiCall({
        request_id: requestId,
        key_id: key?.id ?? null,
        org_id: key?.orgId ?? null,
        environment: key?.environment ?? null,
        endpoint: spec.name,
        status,
        latency_ms: Date.now() - started,
        input_sha256: inputSha,
        image_sha256: imageSha,
        approval_id: approval?.id ?? null,
        api_version: 'v1',
        engine_version: CWCS_RULES_VERSION,
        model_versions: models,
        degraded,
        outcome,
      });
    }
  };
}

/** A content hash for callers that need one outside the wrapper. */
export { sha256Hex };
