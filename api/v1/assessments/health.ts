import type { VercelRequest, VercelResponse } from '@vercel/node';

import { CWCS_RULES_VERSION } from '../../../src/decision/engine';
import { API_VERSION, REGULATORY_STATUS } from '../../_apiCore';
import { providerStatus } from '../../_segmentation';
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

  // The boundary chain, in the order it will actually be tried. This is the
  // question worth answering from outside: not "is segmentation on" but "which
  // backend will answer", because a deployment silently running on the third
  // fallback produces worse boundaries while looking entirely healthy.
  const providers = providerStatus();

  // Which of the vars each capability needs are actually present. Names only.
  const env = {
    AI_GATEWAY_API_KEY: Boolean(process.env.AI_GATEWAY_API_KEY),
    VERCEL_OIDC_TOKEN: Boolean(process.env.VERCEL_OIDC_TOKEN),
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    // SAM 3 on fal.ai — the first boundary provider.
    FAL_KEY: Boolean(process.env.FAL_KEY),
    // FUSegNet on Modal — proxy auth is either the Modal-Key/Secret pair or a
    // bearer token, so neither being present is legal (a public endpoint).
    FUSEGNET_MODAL_URL: Boolean(process.env.FUSEGNET_MODAL_URL),
    MODAL_KEY: Boolean(process.env.MODAL_KEY),
    MODAL_SECRET: Boolean(process.env.MODAL_SECRET),
    FUSEGNET_AUTH_TOKEN: Boolean(process.env.FUSEGNET_AUTH_TOKEN),
    MENDWISE_APP_KEY: Boolean(process.env.MENDWISE_APP_KEY),
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
      segmentation: providers.some((p) => p.configured), // → falls back to the HSV mask
    },
    env,
    /** In try-order. The first `configured: true` is the backend that will draw boundaries. */
    segmentation: {
      order: providers.map((p) => p.provider),
      providers,
      active: providers.find((p) => p.configured)?.provider ?? null,
    },
    models: { vlm: vlmCandidates, llm: llmCandidates },
    /** The module API (spec §6A). */
    api: {
      version: API_VERSION,
      engine_version: CWCS_RULES_VERSION,
      regulatory_status: REGULATORY_STATUS,
      // Keys, approvals and rate limits live in Supabase; without it they fall
      // back to per-instance memory, which is not a shared limit or durable.
      durable_state: store,
      app_key_configured: Boolean(process.env.MENDWISE_APP_KEY),
      second_opinion_trigger: process.env.FUSEGNET_TRIGGER ?? 'foot',
      tissue_classifier: process.env.TISSUE_RELATIVE === '1' ? 'relative' : 'absolute',
      openapi: '/api/v1/openapi',
    },
    engine: 'always available — the deterministic decision never depends on any of the above',
  });
}
