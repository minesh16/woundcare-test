import { generateText } from 'ai';
import type { VercelRequest, VercelResponse } from '@vercel/node';

import { callGateway } from './_gateway';

/**
 * POST /api/v1/assessments/baseline — the comparison arm.
 *
 * A single unguided frontier call on the same photograph: no mask, no
 * measurement, no rules engine, no cage. This is deliberately NOT part of the
 * assessment pipeline and its output never reaches the engine or the record —
 * it exists so the comparison screen can show what an ungrounded answer looks
 * like next to a measured, auditable one.
 *
 * Keep it honest: the prompt is a fair, ordinary request, not a strawman. The
 * comparison is only worth making if the baseline is the real thing.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const base64 = String(body.base64 ?? '');
  if (!base64) {
    res.status(400).json({ error: 'Missing base64 image.' });
    return;
  }

  const outcome = await callGateway('vlm', async (model, signal) => {
    const { text } = await generateText({
      model,
      abortSignal: signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Assess this wound and recommend a dressing.' },
            { type: 'image', image: base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}` },
          ],
        },
      ],
    });
    return text;
  });

  if (outcome.source === 'unavailable') {
    res.status(200).json({ source: 'unavailable', reason: outcome.reason, latencyMs: outcome.latencyMs });
    return;
  }

  res.status(200).json({
    source: 'gateway',
    text: outcome.value,
    model: outcome.model,
    latencyMs: outcome.latencyMs,
  });
}
