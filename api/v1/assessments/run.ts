import type { VercelRequest, VercelResponse } from '@vercel/node';

import type { AssessmentState } from '../../../src/assessment/state';
import { runAssessment } from './_controller';

/**
 * POST /api/v1/assessments/run — the whole pipeline, streamed.
 *
 * Emits `event: step` frames as each stage finishes, then a final
 * `event: result` carrying the assessment state. Streaming runs on the default
 * Node runtime (Fluid Compute) — there is no reason to reach for the edge
 * runtime here, and doing so would cost us the Node APIs the CV steps need.
 *
 * The stream is also the honest view of the pipeline: a degraded step says so
 * as it happens, rather than being hidden behind a single final answer.
 */

export const config = { maxDuration: 300 };

function send(res: VercelResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const base64 = String(body.base64 ?? '');
  const engineInputs = body.inputs;

  if (!base64 || !engineInputs?.tissue) {
    res.status(400).json({ error: 'Missing image or engine inputs.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const state: AssessmentState = body.state ?? {
    id: `asmt-local-${Date.now()}`,
    createdAt: new Date().toISOString(),
  };

  try {
    const final = await runAssessment(
      {
        state,
        base64,
        engineInputs,
        pxPerCm: body.pxPerCm ?? null,
        areaCm2: body.areaCm2 ?? null,
        bodyZoneLabel: body.bodyZoneLabel ?? null,
      },
      (outcome) => send(res, 'step', outcome),
    );
    send(res, 'result', final);
  } catch (error) {
    // The engine step is the only one that can get us here; everything else
    // degrades. Say so plainly rather than emitting a half-assessment.
    send(res, 'error', {
      message: error instanceof Error ? error.message : 'Assessment failed.',
    });
  } finally {
    res.end();
  }
}
