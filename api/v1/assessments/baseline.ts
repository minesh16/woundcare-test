import { generateText } from 'ai';

import { baselineInput } from '../../_contracts';
import { endpoint } from '../../_http';
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
/**
 * POST /api/v1/assessments/baseline — the deliberately UNGROUNDED comparison
 * arm (an open question to a frontier model). Never feeds the assessment.
 * Heavy-rate-limited: it is an open prompt to a paid model (MW-03).
 */
export default endpoint({
  name: 'baseline',
  scope: 'baseline',
  input: baselineInput,
  heavy: true,
  handle: async (input) => {
    const base64 = input.base64;
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
      return { body: { source: 'unavailable', reason: outcome.reason, latencyMs: outcome.latencyMs }, degraded: true };
    }
    return {
      body: { source: 'gateway', text: outcome.value, model: outcome.model, latencyMs: outcome.latencyMs },
      models: { vlm: outcome.model },
    };
  },
});
