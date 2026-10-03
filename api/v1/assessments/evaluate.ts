
import { evaluate } from '../../../src/decision/engine';
import type { EngineInputs } from '../../../src/decision/engine.types';
import { newAssessmentId, type AssessmentState } from '../../../src/assessment/state';
import { evaluateInput } from '../../_contracts';
import { endpoint } from '../../_http';
import { appendTimeline, buildAuditRecord, saveAssessment, writeAudit } from './_store';

/**
 * POST /api/v1/assessments/evaluate — the deterministic decision.
 *
 * No AI whatsoever. This exists so web, native and the `run` orchestrator all
 * go through one execution path and one audit write point: an assessment that
 * isn't audited here didn't happen.
 *
 * Stored state, when there is any, is the base; the client's posted inputs are
 * layered on top. With no database the posted state is simply used as-is, and
 * the audit record goes to the logs.
 */
/**
 * POST /api/v1/assessments/evaluate — the deterministic engine. No image, no
 * approval needed: it decides from inputs alone. The record id is minted here
 * (MW-02): a caller-supplied id can no longer overwrite someone else's record.
 */
export default endpoint({
  name: 'evaluate',
  scope: 'evaluate',
  input: evaluateInput,
  handle: async (input) => {
    const inputs = input.inputs as EngineInputs;
    const state: AssessmentState = { id: newAssessmentId(), createdAt: new Date().toISOString(), engineInputs: inputs };
    const result = evaluate(inputs);
    state.result = result;

    await saveAssessment(state);
    await writeAudit(buildAuditRecord(state, inputs, result));
    if (result.status === 'complete') await appendTimeline(state);

    return {
      body: { result, assessment_id: state.id },
      outcome: { status: result.status, pathway: result.cwcsPathwayId, gates: result.gateCodes },
    };
  },
});
