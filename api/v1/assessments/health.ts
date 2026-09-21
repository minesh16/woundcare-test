import type { VercelRequest, VercelResponse } from '@vercel/node';

import { isGatewayConfigured, resolveModelCandidates } from './_gateway';
import { isStoreConfigured } from './_store';

/**
 * GET /api/v1/assessments/health — which capabilities this deployment has.
 *
 * Every degradable step in the pipeline fails quietly on purpose: an AI outage
 * or a missing database must never block a clinical result. The cost of that is
 * you cannot tell "not configured" from "configured but failing" from outside,
 * which is exactly the question you need answered when a write silently doesn't
 * land. This endpoint answers it.
 *
 * Reports booleans and the presence of env var NAMES only — never a value, and
 * never anything derived from one.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const gateway = isGatewayConfigured();
  const store = isStoreConfigured();

  // Which of the vars each capability needs are actually present. Names only.
  const env = {
    AI_GATEWAY_API_KEY: Boolean(process.env.AI_GATEWAY_API_KEY),
    VERCEL_OIDC_TOKEN: Boolean(process.env.VERCEL_OIDC_TOKEN),
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    REPLICATE_API_TOKEN: Boolean(process.env.REPLICATE_API_TOKEN),
  };

  let vlmCandidates: string[] = [];
  let llmCandidates: string[] = [];
  if (gateway && req.query.models === 'true') {
    // Listing costs a gateway round-trip, so it is opt-in.
    vlmCandidates = await resolveModelCandidates('vlm');
    llmCandidates = await resolveModelCandidates('llm');
  }

  res.status(200).json({
    ok: true,
    capabilities: {
      // What each of these means when false:
      gateway,      // → the caged VLM pass and report LLM degrade to "unavailable"
      store,        // → assessments are returned but not persisted; audit goes to stdout
      segmentation: Boolean(process.env.REPLICATE_API_TOKEN), // → falls back to the HSV mask
    },
    env,
    models: { vlm: vlmCandidates, llm: llmCandidates },
    engine: 'always available — the deterministic decision never depends on any of the above',
  });
}
