
import { newAssessmentId, type AssessmentState } from '../../../src/assessment/state';
import { createInput } from '../../_contracts';
import { endpoint } from '../../_http';
import { saveAssessment } from './_store';

/**
 * POST /api/v1/assessments/create → { assessment_id }
 *
 * Named `create.ts`, not `index.ts`: Vercel's filesystem routing did not map a
 * nested `index.ts` to its directory path (`/api/v1/assessments` returned 404
 * in production while its siblings resolved), so the route is explicit.
 *
 * Opens a record. `wound_id` is an optional client-generated grouping key for
 * the longitudinal timeline — it identifies a wound across visits, never a
 * person. There is nowhere in this payload to put an identifier.
 */
export default endpoint({
  name: 'create',
  scope: 'run',
  input: createInput,
  handle: async (input) => {
    const state: AssessmentState = {
      id: newAssessmentId(),
      createdAt: new Date().toISOString(),
      woundId: input.wound_id ?? null,
      steps: [],
    };
    await saveAssessment(state);
    return { body: { assessment_id: state.id, created_at: state.createdAt } };
  },
});
