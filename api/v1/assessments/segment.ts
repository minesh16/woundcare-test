import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  isSegmentationConfigured,
  runSegmentation,
  type ImagePoint,
  type SegmentationOutcome,
} from '../../_segmentation';
import type { SegmentSummary } from '../../../src/assessment/state';

/**
 * POST /api/v1/assessments/segment — the segment step of the V2 pipeline
 * (build spec §7: `POST /api/v1/assessments/{id}/segment`).
 *
 * Body: { base64: string, point?: { xPct, yPct }, assessment_id?: string }
 * Response: { segment: SegmentSummary, provider, promptMode, masks, selection,
 *             scores, attempts, wound_area_cm2: null, calibration: null }
 *
 * The granular sibling of the `run` orchestrator: `run` calls the same facade
 * through `_controller.ts`, so there is one implementation of the step and this
 * endpoint cannot drift from the pipeline's behaviour.
 *
 * On `calibration` and `wound_area_cm2`: the spec puts them in this response,
 * but the scale comes from the reference marker, which `/api/analyze` detects on
 * the client's behalf and reports as `pxPerCm`. They are returned as null here,
 * explicitly, rather than being quietly absent — area in cm² without a measured
 * scale is the exact number this app must never invent.
 */

type SegmentStepResponse = {
  segment: SegmentSummary;
  provider: SegmentationOutcome['provider'];
  promptMode: SegmentationOutcome['promptMode'];
  masks: string[];
  selection: SegmentationOutcome['selection'];
  scores: number[] | null;
  attempts: SegmentationOutcome['attempts'];
  /** Always null: measurement needs the marker scale, which this step does not compute. */
  wound_area_cm2: null;
  calibration: null;
  assessment_id?: string;
  reason?: string;
};

function parsePoint(raw: unknown): ImagePoint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { xPct, yPct } = raw as Record<string, unknown>;
  return typeof xPct === 'number' && typeof yPct === 'number' ? { xPct, yPct } : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const base64 = String(body.base64 ?? '');
  if (!base64) {
    res.status(400).json({ error: 'Missing base64 image.' });
    return;
  }

  const assessmentId = typeof body.assessment_id === 'string' ? body.assessment_id : undefined;
  const point = parsePoint(body.point);

  if (!isSegmentationConfigured()) {
    const payload: SegmentStepResponse = {
      segment: { source: 'unavailable', maskUrl: null, confidence: 'low' },
      provider: null,
      promptMode: null,
      masks: [],
      selection: null,
      scores: null,
      attempts: [],
      wound_area_cm2: null,
      calibration: null,
      assessment_id: assessmentId,
      reason: 'No segmentation provider configured (FAL_KEY and FUSEGNET_MODAL_URL both unset).',
    };
    res.status(200).json(payload);
    return;
  }

  const outcome = await runSegmentation({
    imageDataUrl: base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`,
    point,
  });

  const payload: SegmentStepResponse = {
    segment: {
      source: outcome.provider ?? 'unavailable',
      maskUrl: outcome.mask,
      confidence: outcome.confidence,
      model: outcome.model ?? undefined,
      promptMode: outcome.promptMode ?? undefined,
    },
    provider: outcome.provider,
    promptMode: outcome.promptMode,
    masks: outcome.masks,
    selection: outcome.selection,
    scores: outcome.scores,
    attempts: outcome.attempts,
    wound_area_cm2: null,
    calibration: null,
    assessment_id: assessmentId,
    reason: outcome.reason,
  };
  res.status(200).json(payload);
}
