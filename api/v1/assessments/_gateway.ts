import { gateway } from 'ai';

/**
 * Vercel AI Gateway adapter — the single door the frontier models come through.
 *
 * Two jobs:
 *  1. Resolve a model id at runtime via `getAvailableModels()` rather than
 *     hardcoding one, so a deprecated model never silently breaks the pipeline.
 *  2. Degrade conservatively. If the gateway is unconfigured, slow or failing,
 *     callers get `unavailable` and the deterministic engine carries on without
 *     the VLM axis. An AI outage must never take the assessment down with it.
 *
 * Auth is OIDC in production (no keys in code); `vercel env pull` locally.
 */

/**
 * Hard ceiling on a single model call, so the SSE orchestrator can't hang.
 *
 * 45s, not 20s: a reasoning model doing a vision pass measured ~28s on a real
 * wound-sized image, so a 20s ceiling aborted work that would have succeeded.
 * The orchestrator streams per-step progress, so a slow step is visible rather
 * than silent — but see the model preference order below, which puts fast
 * non-reasoning models ahead of slow ones for exactly this reason.
 */
export const GATEWAY_TIMEOUT_MS = 45_000;

/**
 * Preference order, most capable first. These are *preferences*, not a
 * hardcoded choice: only models the gateway actually lists are considered, the
 * env override beats the list, and a model the account cannot call is skipped
 * at call time (see `callGateway`).
 *
 * The tail of each list is deliberately reachable on a free Vercel AI Gateway
 * tier, so the pipeline works before any credits are added and upgrades itself
 * to the models at the head of the list once they are. Verify with
 * `npm run check:gateway`, which probes real access rather than trusting the
 * model listing.
 */
const VLM_PREFERENCES = [
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-5',
  'google/gemini-2.5-pro',
  // Reachable on the free tier. Gemini Flash is ahead of GPT-5 deliberately:
  // GPT-5 is a reasoning model, which took ~28s on a vision pass and *ignores*
  // `temperature`, so it is both slower and less reproducible for this role.
  // It stays in the list as a last resort.
  'google/gemini-2.5-flash',
  'openai/gpt-5-mini',
  'openai/gpt-5',
];

const LLM_PREFERENCES = [
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5',
  // Reachable on the free tier:
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'google/gemini-2.5-flash',
];

export type ModelRole = 'vlm' | 'llm';

/**
 * A note on `temperature: 0`, which the caged VLM pass sets.
 *
 * Most models honour it and return identical JSON for identical input. Reasoning
 * models (the GPT-5 family, for instance) silently ignore it — the AI SDK logs a
 * warning and proceeds. So temperature 0 is a best effort, not a guarantee.
 *
 * The cage does not depend on it. What makes the VLM safe is structural: the Zod
 * schema admits only enums, so a varying answer is still a valid, bounded
 * observation that the deterministic engine reconciles under fixed rules. What
 * temperature 0 buys is *reproducibility*, which is why the model id is recorded
 * in the audit log alongside the features it produced.
 */

export function isGatewayConfigured(): boolean {
  return Boolean(
    process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN ||
      // Set by the Vercel runtime; OIDC auth is available in deployed functions.
      process.env.VERCEL,
  );
}

let modelCache: Promise<string[]> | null = null;

/** Language-model ids available through the gateway, fetched once per warm container. */
async function availableModelIds(): Promise<string[]> {
  if (!modelCache) {
    modelCache = (async () => {
      const available = await gateway.getAvailableModels();
      return available.models
        // `modelType` is optional; when it's absent we keep the entry rather
        // than filtering out a model that may well be usable.
        .filter((m) => m.modelType == null || m.modelType === 'language')
        .map((m) => m.id);
    })().catch((error) => {
      // Don't poison the cache — a transient listing failure should be retried.
      modelCache = null;
      throw error;
    });
  }
  return modelCache;
}

/**
 * Model ids to try for a role, in order: env override, else every listed
 * preference. The list is ordered, not filtered by capability — the gateway's
 * listing carries no vision flag, so there is no way to confirm a model can
 * read an image. That is why the VLM role never falls back to an arbitrary id:
 * sending a wound photo to a model that silently ignores it would produce
 * confident-looking features from nothing.
 *
 * The report role is different — any language model can narrate decided facts —
 * so it may fall back to whatever the gateway offers.
 */
export async function resolveModelCandidates(role: ModelRole): Promise<string[]> {
  const override = role === 'vlm' ? process.env.MENDWISE_VLM_MODEL : process.env.MENDWISE_LLM_MODEL;
  if (override) return [override];

  let ids: string[];
  try {
    ids = await availableModelIds();
  } catch (error) {
    console.warn('AI Gateway model listing failed.', error);
    return [];
  }

  const preferences = role === 'vlm' ? VLM_PREFERENCES : LLM_PREFERENCES;
  const candidates = preferences.filter((id) => ids.includes(id));

  if (candidates.length === 0 && role === 'llm' && ids[0]) {
    return [ids[0]];
  }
  return candidates;
}

/** The model this role would use first. Reporting only — prefer the candidate list. */
export async function resolveModel(role: ModelRole): Promise<string | null> {
  return (await resolveModelCandidates(role))[0] ?? null;
}

export type GatewayOutcome<T> =
  | { source: 'gateway'; value: T; model: string; latencyMs: number }
  | { source: 'unavailable'; reason: string; latencyMs: number };

/**
 * True for errors where trying again cannot help: auth, restricted model, bad
 * request. The AI SDK marks these `isRetryable: false`; retrying a 403 just
 * doubles the latency before we degrade, and on a metered gateway it can double
 * the cost of a failure too.
 */
function isPermanentFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { isRetryable?: boolean; statusCode?: number; cause?: unknown };
  if (e.isRetryable === false) return true;
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) return true;
  // Gateway errors wrap the provider's APICallError, which carries the status.
  if (e.cause && e.cause !== error) return isPermanentFailure(e.cause);
  return false;
}

/**
 * Run a model call with a timeout and a single retry, and turn every failure
 * into an `unavailable` outcome rather than an exception. Callers are expected
 * to have a non-AI path for that case.
 */
export async function callGateway<T>(
  role: ModelRole,
  run: (model: string, signal: AbortSignal) => Promise<T>,
): Promise<GatewayOutcome<T>> {
  const started = Date.now();

  if (!isGatewayConfigured()) {
    return { source: 'unavailable', reason: 'AI Gateway not configured.', latencyMs: 0 };
  }

  const candidates = await resolveModelCandidates(role);
  if (candidates.length === 0) {
    return {
      source: 'unavailable',
      reason:
        role === 'vlm'
          ? 'No vision-capable model matched through the gateway — set MENDWISE_VLM_MODEL to pin one.'
          : 'No model available through the gateway.',
      latencyMs: Date.now() - started,
    };
  }

  let lastError: unknown = null;

  // Walk the candidates: a model the account cannot call (no credits, tier
  // restriction) is a fact about the account, not about the request, so we move
  // on to the next preference rather than failing the whole pass. This is what
  // lets the pipeline run on a free tier today and pick up a better model the
  // moment credits are added, with no code change.
  for (const model of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      try {
        const value = await run(model, controller.signal);
        return { source: 'gateway', value, model, latencyMs: Date.now() - started };
      } catch (error) {
        lastError = error;
        if (isPermanentFailure(error)) {
          break; // try the next candidate model
        }
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : 'Model call failed.';
  // A permanent failure is a configuration fact (no credits, restricted model,
  // bad key) — log the message, not a stack trace, so it reads as actionable.
  if (isPermanentFailure(lastError)) {
    console.warn(`AI Gateway unavailable for role "${role}": ${reason}`);
  } else {
    console.warn(`AI Gateway call failed for role "${role}".`, lastError);
  }
  return { source: 'unavailable', reason, latencyMs: Date.now() - started };
}
