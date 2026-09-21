import { generateObject } from 'ai';
import type { VercelRequest, VercelResponse } from '@vercel/node';

import { VLM_SYSTEM_PROMPT, vlmFeaturesSchema } from '../../../src/decision/vlm.schema';
import type { VlmFeatures } from '../../../src/decision/engine.types';
import { callGateway } from './_gateway';

/**
 * POST /api/v1/assessments/vlm-features — the caged VLM pass.
 *
 * Body: { base64, woundCrop?, periwoundCrop?, tissueSummary? }
 * Response: { source: 'gateway'|'unavailable', features?, model?, latencyMs, reason? }
 *
 * `generateObject` + Zod + temperature 0: the model can only return the enum
 * shape in `vlm.schema.ts`. It never sees a dressing table, never names a
 * pathway, and its output is advisory input to the deterministic engine — see
 * the reconciliation rules in `src/decision/engine.ts`.
 *
 * Unavailable (no gateway, timeout, refusal, schema violation) is a normal
 * outcome, not an error: the engine runs without the VLM axis and says so.
 */

export type VlmRequest = {
  base64: string;
  woundCrop?: string | null;
  periwoundCrop?: string | null;
  tissueSummary?: unknown;
};

export type VlmResponse = {
  source: 'gateway' | 'unavailable';
  features?: VlmFeatures;
  model?: string;
  latencyMs: number;
  reason?: string;
};

function toDataUrl(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
}

/** The caged extraction step, callable directly by the `run` orchestrator. */
export async function extractVlmFeatures(body: VlmRequest): Promise<VlmResponse> {
  const base64 = String(body.base64 ?? '');
  if (!base64) {
    throw new Error('Missing base64 image.');
  }

  // Crops are optional: without a mask we still get useful periwound and image
  // -quality signals from the full frame, just with less corroboration value.
  const images = [toDataUrl(base64)];
  if (typeof body.woundCrop === 'string' && body.woundCrop) images.push(toDataUrl(body.woundCrop));
  if (typeof body.periwoundCrop === 'string' && body.periwoundCrop) images.push(toDataUrl(body.periwoundCrop));

  const measured = body.tissueSummary
    ? `Measured tissue composition inside the detected wound boundary: ${JSON.stringify(body.tissueSummary)}. ` +
      'Say whether this agrees with what you can see.'
    : 'No measured tissue composition is available; answer "uncertain" for tissue corroboration.';

  const outcome = await callGateway('vlm', async (model, signal) => {
    const { object } = await generateObject({
      model,
      schema: vlmFeaturesSchema,
      temperature: 0,
      abortSignal: signal,
      system: VLM_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `${images.length === 1 ? 'Photograph of a wound.' : 'Photograph of a wound, then a crop of the wound bed, then a crop of the surrounding skin.'} ` +
                `${measured} Report only what you can see.`,
            },
            ...images.map((image) => ({ type: 'image' as const, image })),
          ],
        },
      ],
    });
    return object;
  });

  if (outcome.source === 'unavailable') {
    return { source: 'unavailable', latencyMs: outcome.latencyMs, reason: outcome.reason };
  }

  return {
    source: 'gateway',
    features: outcome.value,
    model: outcome.model,
    latencyMs: outcome.latencyMs,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  try {
    res.status(200).json(await extractVlmFeatures(body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'VLM request failed.' });
  }
}
