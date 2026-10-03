import type { TissueSummary } from '../../../src/assessment/state';
import { measureInput } from '../../_contracts';
import { endpoint } from '../../_http';
import { analyzeTissue } from './tissue';

/**
 * POST /api/v1/assessments/measure — measure the APPROVED outline
 * (segmentation spec §4.2, §5; module table §6A.1).
 *
 * Body: { base64, mask, approval_id, include_coin_reference? }
 * Response: the tissue step's response plus `measurement`:
 *   { frame, scale: { kind:'coin', xPct, yPct, rPct, support, pxPerCm } | null,
 *     scaleReason?, geometry: { areaPx, areaCm2, lengthCm, widthCm, perimeterCm },
 *     whiteBalance, flags, classifier, comparison }
 *
 * Requires an approval bound to this image and this mask (403 otherwise). Never
 * falls back to HSV: the point is to measure inside a boundary a human signed off.
 */
export default endpoint({
  name: 'measure',
  scope: 'measure',
  input: measureInput,
  requiresApproval: true,
  handle: async (input, ctx) => {
    const result = await analyzeTissue({
      base64: input.base64,
      mask: input.mask,
      maskProvider: (ctx.approval?.provider as TissueSummary['maskProvider']) ?? null,
      measure: true,
      includeCoinReference: input.include_coin_reference !== false,
    });
    if (result.maskSource !== 'model' || !result.measurement || !result.tissue) {
      return { status: 422, error: { code: 'unprocessable', message: 'The approved outline could not be measured.' } };
    }
    const m = result.measurement;
    return {
      body: result,
      outcome: {
        maskAreaPx: result.maskAreaPx,
        pxPerCm: m.scale ? Number(m.scale.pxPerCm.toFixed(1)) : null,
        areaCm2: m.geometry.areaCm2,
        whiteBalance: m.whiteBalance.applied,
        classifier: m.classifier,
      },
    };
  },
});
