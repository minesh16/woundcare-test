import { generateObject } from 'ai';
import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';

import { REPORT_TERM_MAP } from '../../../src/copy/plainLanguage';
import { renderTemplateReport, type ReportFacts } from '../../../src/assessment/reportTemplate';
import { buildReportSystemPrompt } from '../../../src/assessment/reportPrompt';
import type { EngineResult } from '../../../src/decision/engine.types';
import type { ReportPair } from '../../../src/assessment/state';
import { violatesCage } from '../../../src/decision/reportCage';
import { callGateway } from './_gateway';

/**
 * POST /api/v1/assessments/report — narration of already-decided facts.
 *
 * The LLM never sees the image, the raw answers, or the dressing table. It
 * receives a whitelist of facts the deterministic engine has already decided,
 * and writes them up. Anything it produces is checked against those facts
 * before it is returned; a failed check falls back to the deterministic
 * template, which is also what runs when the gateway is unavailable.
 */

const reportSchema = z.object({
  clinicianReport: z.string(),
  patientSummary: z.string(),
});

/** Every fact the LLM is allowed to know. Nothing else is sent. */
function whitelistFacts(result: EngineResult, facts: ReportFacts) {
  return {
    status: result.status,
    confidence: result.confidence,
    rulesVersion: result.rulesVersion,
    tissueType: result.axes.tissue,
    exudateLevel: result.axes.exudate,
    infection: result.axes.infection,
    cwcsPathwayId: result.cwcsPathwayId,
    pathwayWithheld: result.pathwayWithheld,
    primaryDressings: result.primary,
    secondaryDressings: result.secondary,
    referrals: result.referrals.map((r) => ({ urgency: r.urgency, code: r.code, message: r.message })),
    gateCodes: result.gateCodes,
    incompleteReasons: result.incompleteReasons,
    notes: result.notes,
    areaCm2: facts.areaCm2 ?? null,
    bodyZone: facts.bodyZoneLabel ?? null,
    tissuePct: facts.tissuePct ?? null,
  };
}

export type ReportRequest = {
  result: EngineResult;
  areaCm2?: number | null;
  bodyZoneLabel?: string | null;
  tissuePct?: ReportFacts['tissuePct'];
};

/** Narration step, callable directly by the `run` orchestrator. */
export async function composeReport(body: ReportRequest): Promise<ReportPair & { reason?: string }> {
  const result = body.result;
  if (!result || typeof result !== 'object' || !('rulesVersion' in result)) {
    throw new Error('Missing engine result.');
  }

  const facts: ReportFacts = {
    result,
    areaCm2: typeof body.areaCm2 === 'number' ? body.areaCm2 : null,
    bodyZoneLabel: typeof body.bodyZoneLabel === 'string' ? body.bodyZoneLabel : null,
    tissuePct: body.tissuePct ?? null,
  };

  // The deterministic version is always computed — it is both the fallback and
  // the thing the LLM output is judged against.
  const template = renderTemplateReport(facts);

  const outcome = await callGateway('llm', async (model, signal) => {
    const { object } = await generateObject({
      model,
      schema: reportSchema,
      temperature: 0,
      abortSignal: signal,
      system: buildReportSystemPrompt(REPORT_TERM_MAP),
      messages: [
        {
          role: 'user',
          content: `Decided facts:\n${JSON.stringify(whitelistFacts(result, facts), null, 2)}`,
        },
      ],
    });
    return object;
  });

  if (outcome.source === 'unavailable') {
    return { ...template, source: 'template', reason: outcome.reason };
  }

  const violation =
    violatesCage(outcome.value.clinicianReport, result) ??
    violatesCage(outcome.value.patientSummary, result);

  if (violation) {
    console.warn('Report LLM output failed the cage check; using the deterministic template.', violation);
    return { ...template, source: 'template', reason: violation };
  }

  return { ...outcome.value, source: 'llm', model: outcome.model };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  try {
    res.status(200).json(await composeReport(body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Report failed.' });
  }
}
