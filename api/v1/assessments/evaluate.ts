import type { VercelRequest, VercelResponse } from '@vercel/node';

import { evaluate } from '../../../src/decision/engine';
import type { EngineInputs } from '../../../src/decision/engine.types';
import type { AssessmentState } from '../../../src/assessment/state';
import { appendTimeline, buildAuditRecord, loadAssessment, saveAssessment, writeAudit } from './_store';

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
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const inputs = body.inputs as EngineInputs | undefined;
  if (!inputs || typeof inputs !== 'object' || !inputs.tissue) {
    res.status(400).json({ error: 'Missing engine inputs.' });
    return;
  }

  const id = typeof body.assessment_id === 'string' ? body.assessment_id : null;
  const stored = id ? await loadAssessment(id) : null;

  const state: AssessmentState = {
    ...(stored ?? {
      id: id ?? `asmt-local-${Date.now()}`,
      createdAt: new Date().toISOString(),
    }),
    ...(body.state as Partial<AssessmentState> | undefined),
    engineInputs: inputs,
  };

  const result = evaluate(inputs);
  state.result = result;

  await saveAssessment(state);
  await writeAudit(buildAuditRecord(state, inputs, result));
  if (result.status === 'complete') {
    await appendTimeline(state);
  }

  res.status(200).json({ result, assessment_id: state.id });
}
