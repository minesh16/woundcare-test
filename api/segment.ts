import type { VercelRequest, VercelResponse } from '@vercel/node';

import { MaskSelection, selectWoundMask } from './_maskSelect';
import { ImagePoint, isSam2Configured, runSam2Segmentation } from './_sam2';

/**
 * POST /api/segment  — SAM 2 boundary segmentation (assessmentV2, additive).
 *
 * Body: { base64: string, point?: { xPct, yPct } }
 *  - `point` is the HSV wound centroid (or a user tap). `meta/sam-2` is an
 *    automatic mask generator with no prompt input, so the point is NOT sent to
 *    the model — it is used server-side to SELECT the wound mask from
 *    `individual_masks` (smallest mask containing the centroid; see
 *    `_maskSelect.ts`).
 *
 * Response: { source, mask, combinedMask, masks, selection, confidence, point?, model?, reason? }
 *  - `mask` is the wound-specific mask when selection succeeds, else the
 *    combined (all-objects) mask.
 *  - When SAM 2 is not configured (no REPLICATE_API_TOKEN) or the call fails,
 *    responds conservatively with { source: 'unavailable', mask: null } so the
 *    client falls back to the existing HSV mask.
 */

type SegmentResponse = {
  source: 'sam2' | 'unavailable';
  /** Wound-specific mask uri when a centroid selection succeeds, else combinedMask. */
  mask: string | null;
  /** Union of all detected masks (uri); kept for reference/debug. */
  combinedMask: string | null;
  /** Per-object mask uris returned by SAM 2. */
  masks: string[];
  /** Which individual mask was chosen as the wound, or null if none/HSV fallback. */
  selection: MaskSelection | null;
  confidence: 'high' | 'medium' | 'low';
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

  if (!isSam2Configured()) {
    const payload: SegmentResponse = {
      source: 'unavailable',
      mask: null,
      combinedMask: null,
      masks: [],
      selection: null,
      confidence: 'low',
      point,
      reason: 'SAM 2 endpoint not configured (REPLICATE_API_TOKEN unset).',
    };
    res.status(200).json(payload);
    return;
  }

  try {
    const result = await runSam2Segmentation({ imageDataUrl: toDataUrl(base64) });

    // Select the wound mask from the auto-generated set using the HSV centroid.
    const selection =
      point && result.individualMasks.length > 0
        ? await selectWoundMask(result.individualMasks, point)
        : null;

    const payload: SegmentResponse = {
      source: 'sam2',
      mask: selection?.maskUrl ?? result.combinedMask,
      combinedMask: result.combinedMask,
      masks: result.individualMasks,
      selection,
      // A centroid-selected wound mask is a stronger result than the raw union.
      confidence: selection ? 'high' : result.confidence,
      point,
      model: result.model,
    };
    res.status(200).json(payload);
  } catch (error) {
    // Conservative by default: never break the flow on a segmentation failure.
    console.warn('SAM 2 segmentation failed; falling back to HSV.', error);
    const payload: SegmentResponse = {
      source: 'unavailable',
      mask: null,
      combinedMask: null,
      masks: [],
      selection: null,
      confidence: 'low',
      point,
      reason: error instanceof Error ? error.message : 'Segmentation failed.',
    };
    res.status(200).json(payload);
  }
}
