import type { VercelResponse } from '@vercel/node';

import { newAssessmentId, type AssessmentState } from '../../../src/assessment/state';
import type { EngineInputs } from '../../../src/decision/engine.types';
import { runInput } from '../../_contracts';
import { endpoint } from '../../_http';
import { runAssessment } from './_controller';

/**
 * POST /api/v1/assessments/run — the whole pipeline over an APPROVED outline,
 * streamed (Server-Sent Events).
 *
 *   event: meta      the envelope (request_id, versions, regulatory_status)
 *   event: step      as each stage finishes
 *   event: decision  the engine's result, as soon as it is made
 *   event: result    the final assessment state (after the report)
 *   event: error     the engine itself failed
 *
 * Requires an approval bound to this image and mask (403 otherwise) — there is
 * no auto-approval (segmentation spec §6A.1). The record id is minted here
 * (MW-02). maxDuration is in vercel.json.
 */

function send(res: VercelResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default endpoint({
  name: 'run',
  scope: 'run',
  input: runInput,
  requiresApproval: true,
  heavy: true,
  stream: true,
  handle: async (input, ctx) => {
    const { res } = ctx;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    send(res, 'meta', ctx.meta());

    const state: AssessmentState = {
      id: newAssessmentId(),
      createdAt: new Date().toISOString(),
      woundId: input.wound_id ?? null,
      imageSha256: ctx.imageSha256,
    };

    let outcome: Record<string, unknown> = {};
    let models: Record<string, string | null> = {};
    let degraded = false;
    try {
      const final = await runAssessment(
        {
          state,
          base64: input.base64,
          engineInputs: input.inputs as EngineInputs,
          pxPerCm: input.px_per_cm ?? null,
          areaCm2: input.area_cm2 ?? null,
          bodyZoneLabel: input.body_zone_label ?? null,
          mask: input.mask,
          approval: ctx.approval!,
        },
        (step) => send(res, 'step', step),
        (decision) => send(res, 'decision', decision),
      );
      models = { vlm: final.vlmModel ?? null, llm: final.report?.model ?? null };
      degraded = (final.steps ?? []).some((s) => s.status !== 'ok');
      outcome = { status: final.result?.status, pathway: final.result?.cwcsPathwayId ?? null, assessmentId: final.id };
      send(res, 'result', { ...final, ...ctx.meta(), model_versions: { ...ctx.meta().model_versions, ...models } });
    } catch {
      // The engine is the only step that can get here; everything else degrades.
      send(res, 'error', { code: 'internal_error', message: 'The assessment could not be completed.', request_id: ctx.requestId });
    } finally {
      res.end();
    }
    return { streamed: true, models, degraded, outcome };
  },
});
