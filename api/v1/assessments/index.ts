import type { VercelRequest, VercelResponse } from '@vercel/node';

import { newAssessmentId, type AssessmentState } from '../../../src/assessment/state';
import { saveAssessment } from './_store';

/**
 * POST /api/v1/assessments → { assessment_id }
 *
 * Opens a record. `wound_id` is an optional client-generated grouping key for
 * the longitudinal timeline — it identifies a wound across visits, never a
 * person. There is nowhere in this payload to put an identifier.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const state: AssessmentState = {
    id: newAssessmentId(),
    createdAt: new Date().toISOString(),
    woundId: typeof body.wound_id === 'string' ? body.wound_id : null,
    steps: [],
  };

  await saveAssessment(state);
  res.status(200).json({ assessment_id: state.id, created_at: state.createdAt });
}
