import { segmentInput } from '../../_contracts';
import { endpoint } from '../../_http';
import { normaliseImage } from '../../_image';
import { logSegmentation, runSegmentation, type SegmentationOutcome } from '../../_segmentation';
import { sanitisePrompts } from '../../_segmentationParse';

/**
 * POST /api/v1/assessments/segment — the draft wound outline (segmentation spec
 * §3.2). `/api/segment` is an alias.
 *
 * Body: { base64, prompts?: { text?, points?: [{xPct,yPct,label}], box? }, body_zone?, assessment_id? }
 *
 * Response (spec SegmentResponse, plus what the review screen needs):
 *   { source: 'sam3'|'fusegnet'|'hsv'|null, mask, score, box, confidence, model,
 *     latencyMs, reason?, outline, frame, secondOpinion, promptConflict, attempts, … }
 *
 * Always 200 for a valid request: a model outage degrades to `source: 'hsv'`
 * (with `degraded: true`) for the clinician to correct, never to an error. The
 * draft is only a proposal — nothing is measured until POST /approve.
 */
export type SegmentResponse = Pick<
  SegmentationOutcome,
  | 'source'
  | 'provider'
  | 'mask'
  | 'score'
  | 'box'
  | 'confidence'
  | 'model'
  | 'promptMode'
  | 'outline'
  | 'multipleRegions'
  | 'frame'
  | 'areaPx'
  | 'totalPx'
  | 'candidates'
  | 'promptConflict'
  | 'secondOpinion'
  | 'secondOpinionReason'
  | 'latencyMs'
  | 'attempts'
  | 'reason'
>;

export default endpoint({
  name: 'segment',
  scope: 'segment',
  input: segmentInput,
  heavy: true,
  handle: async (input, ctx) => {
    let image;
    try {
      image = normaliseImage(input.base64);
    } catch (error) {
      return { status: 400, error: { code: 'validation_error', message: error instanceof Error ? error.message : 'Unreadable image.' } };
    }
    const prompts = sanitisePrompts(input.prompts);
    const outcome = await runSegmentation({ image, prompts, bodyZone: input.body_zone ?? null });
    logSegmentation(outcome, { assessmentId: input.assessment_id ?? null, prompts, requestId: ctx.requestId });

    const body: SegmentResponse = {
      source: outcome.source,
      provider: outcome.provider,
      mask: outcome.mask,
      score: outcome.score,
      box: outcome.box,
      confidence: outcome.confidence,
      model: outcome.model,
      promptMode: outcome.promptMode,
      outline: outcome.outline,
      multipleRegions: outcome.multipleRegions,
      frame: outcome.frame,
      areaPx: outcome.areaPx,
      totalPx: outcome.totalPx,
      candidates: outcome.candidates,
      promptConflict: outcome.promptConflict,
      secondOpinion: outcome.secondOpinion,
      secondOpinionReason: outcome.secondOpinionReason,
      latencyMs: outcome.latencyMs,
      attempts: outcome.attempts,
      reason: outcome.reason,
    };
    const opinion = outcome.secondOpinion;
    return {
      body,
      degraded: outcome.source !== 'sam3' && outcome.source !== 'fusegnet',
      reason: outcome.reason,
      models: {
        segmentation: outcome.provider ? outcome.model : null,
        second_opinion: opinion?.status === 'ok' ? opinion.model : null,
      },
      outcome: {
        source: outcome.source,
        confidence: outcome.confidence,
        score: outcome.score,
        candidates: outcome.candidates,
        points: prompts.points?.length ?? 0,
        box: Boolean(prompts.box),
        agreementIoU: opinion?.status === 'ok' ? opinion.agreementIoU : null,
      },
    };
  },
});
