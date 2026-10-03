import { correctionInput } from '../../_contracts';
import { endpoint } from '../../_http';
import { updateCorrectionTissue } from './_store';

/**
 * POST /api/v1/assessments/correction — record the clinician's tissue
 * confirmation (segmentation spec §4.3) against the correction row that
 * POST /approve wrote. A changed dominant tissue is logged as `tissue_override`.
 *
 * Body: { correction_id, tissue_auto, tissue_final, wound_location? }
 */
export default endpoint({
  name: 'correction',
  scope: 'approve',
  input: correctionInput,
  handle: async (input) => {
    const tissueOverride = input.tissue_auto !== input.tissue_final;
    const stored = await updateCorrectionTissue(input.correction_id, {
      tissue_auto: input.tissue_auto,
      tissue_final: input.tissue_final,
      tissue_override: tissueOverride,
      wound_location: input.wound_location ?? null,
      monk_tone: input.monk_tone ?? null,
    });
    return { body: { stored, tissue_override: tissueOverride }, outcome: { tissueOverride } };
  },
});
