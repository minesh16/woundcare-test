import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  isSegmentationConfigured,
  runSegmentation,
  type ImagePoint,
  type MaskSelection,
  type PromptMode,
  type SegmentationAttempt,
  type SegmentationProvider,
} from './_segmentation';

/**
 * POST /api/segment — wound-boundary segmentation (assessmentV2, additive).
 *
 * Body: { base64: string, point?: { xPct, yPct } }
 *  - `point` is the HSV wound centroid (or a user tap), in fractional
 *    coordinates. What happens to it depends on which backend answers:
 *      sam3     — sent as a pixel `point_prompt`, and used to pick the right
 *                 instance when the concept prompt "wound" matches more than one
 *      fusegnet — ignored; the model segments wounds and nothing else
 *
 * Response: { source, provider, promptMode, mask, masks, selection,
 *             scores, confidence, attempts, point?, model?, reason? }
 *  - `mask` is the wound mask to measure tissue inside.
 *  - `attempts` records every provider tried and why it was skipped or rejected.
 *    This is the thing worth having in production: "the boundary looks wrong"
 *    and "the boundary came from the fallback provider" are the same bug report.
 *  - With no provider configured, or both of them failing, responds
 *    { source: 'unavailable', mask: null } so the client keeps its HSV mask.
 *    Conservative by default — a segmentation outage degrades the boundary, it
 *    never blocks the assessment.
 *
 * Note: this endpoint always returns 200 for a well-formed request. A 500 here
 * would make the client's fallback path indistinguishable from a bug.
 */

type SegmentResponse = {
  /** `provider` when a mask was produced, else 'unavailable'. Kept as `source` for the existing client. */
  source: SegmentationProvider | 'unavailable';
  provider: SegmentationProvider | null;
  promptMode: PromptMode | null;
  /** The wound mask uri. */
  mask: string | null;
  /** Every mask the winning provider returned. */
  masks: string[];
  /** Which mask was chosen as the wound, when a choice was made. */
  selection: MaskSelection | null;
  /** Per-mask confidence when the provider reports it (SAM 3 does). */
  scores: number[] | null;
  confidence: 'high' | 'medium' | 'low';
  attempts: SegmentationAttempt[];
  point?: ImagePoint;
  model?: string;
  reason?: string;
};

function toDataUrl(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
}

function parsePoint(raw: unknown): ImagePoint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { xPct, yPct } = raw as Record<string, unknown>;
  if (typeof xPct === 'number' && typeof yPct === 'number') {
    return { xPct, yPct };
  }
  return undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const base64 = String(body.base64 ?? '');
  const point = parsePoint(body.point);

  if (!base64) {
    res.status(400).json({ error: 'Missing base64 image.' });
    return;
  }

  if (!isSegmentationConfigured()) {
    const payload: SegmentResponse = {
      source: 'unavailable',
      provider: null,
      promptMode: null,
      mask: null,
      masks: [],
      selection: null,
      scores: null,
      confidence: 'low',
      attempts: [],
      point,
      reason: 'No segmentation provider configured (FAL_KEY and FUSEGNET_MODAL_URL both unset).',
    };
    res.status(200).json(payload);
    return;
  }

  // runSegmentation never throws; it reports a failed chain as provider: null.
  const outcome = await runSegmentation({ imageDataUrl: toDataUrl(base64), point });

  const payload: SegmentResponse = {
    source: outcome.provider ?? 'unavailable',
    provider: outcome.provider,
    promptMode: outcome.promptMode,
    mask: outcome.mask,
    masks: outcome.masks,
    selection: outcome.selection,
    scores: outcome.scores,
    confidence: outcome.confidence,
    attempts: outcome.attempts,
    point,
    model: outcome.model ?? undefined,
    reason: outcome.reason,
  };
  res.status(200).json(payload);
}
