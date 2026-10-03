import { approveInput } from '../../_contracts';
import { endpoint } from '../../_http';
import { createApproval } from '../../_apiStore';
import { BOUNDARY_CHANGED_IOU, compareMasks } from '../../_maskGeometry';
import { loadMaskPixels, maskSha256, toPngDataUri } from '../../_maskIO';
import { describePlausibility, maskPlausibility } from '../../_segmentationParse';
import { db } from '../../_supabase';
import { writeCorrection, type CorrectionRow } from './_store';

/**
 * POST /api/v1/assessments/approve — the clinician signs off the wound outline
 * (segmentation spec §6A.1, §4.1).
 *
 * Returns an `approval_id` bound to SHA-256 hashes of the image and the final
 * mask. `/measure`, `/tissue`, `/vlm-features` and `/run` refuse to work without
 * one, and refuse an image or mask that is not the approved one — so clinician
 * review is enforced by the API, not left to the UI (the intended-use control).
 *
 * Also writes exactly one row to the segmentation correction log, with the IoU
 * between the model's draft and the final mask computed HERE, not reported by
 * the caller.
 */

/**
 * Mask images are kept only for images that are not of a patient (spec §4.1).
 * `consented_demo` is a consented photo of a real person, so it counts as a
 * patient image. The database enforces the same rule with a CHECK.
 */
export function mayStoreMasks(source: string): boolean {
  return source === 'public_dataset' || source === 'synthetic';
}

export default endpoint({
  name: 'approve',
  scope: 'approve',
  input: approveInput,
  handle: async (input, ctx) => {
    const finalMask = await loadMaskPixels(input.final_mask);
    if (!finalMask || finalMask.areaPx === 0) {
      return { status: 422, error: { code: 'unprocessable', message: 'The final mask could not be read, or is empty.' } };
    }
    const aiMask = input.ai_mask ? await loadMaskPixels(input.ai_mask) : null;

    // Compare on the model's grid when there is one (it has the photo's aspect).
    const comparison = aiMask ? compareMasks(aiMask, finalMask, aiMask.width, aiMask.height) : null;
    const iou = comparison?.iou ?? null;
    const imageSource = input.image_source ?? 'consented_demo';
    const store = mayStoreMasks(imageSource);
    const opinion = input.second_opinion ?? null;
    const round = (v: number | null | undefined, dp: number) => (typeof v === 'number' ? Number(v.toFixed(dp)) : null);

    const row: CorrectionRow = {
      assessment_id: input.assessment_id,
      model: input.model ?? null,
      confidence: input.confidence ?? null,
      score: round(input.score, 4),
      approval: input.approval,
      iou: round(iou, 4),
      ai_area_px: comparison?.aAreaPx ?? null,
      final_area_px: comparison?.bAreaPx ?? finalMask.areaPx,
      area_delta_pct: round(comparison?.areaDeltaPct, 2),
      // No draft to compare with (drawn from scratch with nothing proposed): changed by definition.
      boundary_changed: iou === null ? (aiMask ? null : true) : iou < BOUNDARY_CHANGED_IOU,
      n_edits: input.edits ?? 0,
      n_taps: input.taps ?? 0,
      box_used: input.box_used ?? false,
      ms_to_approve: input.ms_to_approve ?? null,
      wound_location: input.body_zone ?? null,
      monk_tone: input.monk_tone ?? null,
      image_source: imageSource,
      ai_mask_png: store && aiMask ? toPngDataUri(aiMask.data, aiMask.width, aiMask.height) : null,
      final_mask_png: store ? toPngDataUri(finalMask.data, finalMask.width, finalMask.height) : null,
      approval_id: null,
      clinician_id: input.clinician_id ?? null,
      second_opinion_status: opinion?.status ?? null,
      agreement_iou: round(opinion?.agreement_iou, 4),
      fusegnet_regions: opinion?.regions ?? null,
      fusegnet_mean_prob: round(opinion?.mean_prob, 4),
      fusegnet_latency_ms: typeof opinion?.latency_ms === 'number' ? Math.round(opinion.latency_ms) : null,
    };
    const correctionId = await writeCorrection(row);

    const approval = await createApproval({
      keyId: ctx.key.id,
      orgId: ctx.key.orgId,
      assessmentId: input.assessment_id,
      imageSha256: ctx.imageSha256!,
      maskSha256: maskSha256(finalMask),
      approval: input.approval,
      clinicianId: input.clinician_id ?? null,
      provider: input.approval === 'drawn' ? null : (input.provider ?? null),
      model: input.approval === 'drawn' ? null : (input.model ?? null),
      correctionId,
    });
    if (correctionId) await linkCorrection(correctionId, approval.id);

    const verdict = maskPlausibility(finalMask.areaPx, finalMask.totalPx);
    return {
      body: {
        approval_id: approval.id,
        expires_at: approval.expiresAt,
        correction_id: correctionId,
        iou: row.iou,
        ai_area_px: row.ai_area_px,
        final_area_px: row.final_area_px,
        area_delta_pct: row.area_delta_pct,
        boundary_changed: row.boundary_changed,
        masks_stored: Boolean(row.final_mask_png),
        // Advisory only: the clinician is the authority on the outline.
        plausibility: verdict,
        plausibility_reason: describePlausibility(verdict),
      },
      outcome: { approval: input.approval, iou: row.iou, boundaryChanged: row.boundary_changed },
    };
  },
});

async function linkCorrection(correctionId: string, approvalId: string): Promise<void> {
  const client = db();
  if (client) await client.from('segmentation_corrections').update({ approval_id: approvalId }).eq('id', correctionId);
}
