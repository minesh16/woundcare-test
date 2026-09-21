/**
 * Live end-to-end smoke test. Run: npm run smoke:live
 *
 * Exercises the two paths unit tests cannot reach: a real caged VLM call
 * through the AI Gateway, and a real Supabase round-trip including the audit
 * write. Costs a few cents in model tokens and writes one throwaway row, which
 * it deletes afterwards.
 *
 * Needs AI_GATEWAY_API_KEY, and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for
 * the database half (it skips that half, rather than failing, if they're unset).
 */
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

/**
 * SCOPE NOTE — what this does and does not cover.
 *
 * Node's type-stripping requires explicit `.ts` extensions on relative imports,
 * which the api/ handlers (correctly, for the Vercel build) do not use. So the
 * two HTTP handlers' thin request/response wrappers are NOT loaded here.
 * Everything they delegate to IS: the real `callGateway`, the real Zod schema,
 * the real system prompts (imported, not paraphrased — see reportPrompt.ts),
 * the real engine, the real cage check and the real Supabase store. Not covered here: the handlers' body parsing (~15 lines each)
 * and the deterministic report template — the template is a pure function with
 * no external dependency, so a live run tells us nothing a unit test doesn't.
 */
const { callGateway } = await import('../api/v1/assessments/_gateway.ts');
const { vlmFeaturesSchema, VLM_SYSTEM_PROMPT } = await import('../src/decision/vlm.schema.ts');
const { evaluate } = await import('../src/decision/engine.ts');
const { violatesCage } = await import('../src/decision/reportCage.ts');
const { buildReportSystemPrompt } = await import('../src/assessment/reportPrompt.ts');
const { REPORT_TERM_MAP } = await import('../src/copy/plainLanguage.ts');
const store = await import('../api/v1/assessments/_store.ts');
const { generateObject } = await import('ai');
const { z } = await import('zod');

/** Mirrors api/v1/assessments/vlm-features.ts, using the same schema and prompt. */
async function extractVlmFeatures(body: { base64: string; tissueSummary?: unknown }) {
  const dataUrl = body.base64.startsWith('data:') ? body.base64 : `data:image/jpeg;base64,${body.base64}`;
  const outcome = await callGateway('vlm', async (model, signal) => {
    const { object } = await generateObject({
      model,
      schema: vlmFeaturesSchema,
      temperature: 0,
      abortSignal: signal,
      system: VLM_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Photograph of a wound. Measured tissue composition inside the detected wound boundary: ${JSON.stringify(body.tissueSummary)}. Say whether this agrees with what you can see. Report only what you can see.` },
          { type: 'image', image: dataUrl },
        ],
      }],
    });
    return object;
  });
  return outcome.source === 'gateway'
    ? { source: 'gateway' as const, features: outcome.value, model: outcome.model, latencyMs: outcome.latencyMs }
    : { source: 'unavailable' as const, features: undefined, reason: outcome.reason, latencyMs: outcome.latencyMs, model: undefined };
}

/** Mirrors api/v1/assessments/report.ts, including the fallback-on-violation rule. */
async function composeReport(body: { result: ReturnType<typeof evaluate>; areaCm2?: number | null; bodyZoneLabel?: string | null }) {
  const outcome = await callGateway('llm', async (model, signal) => {
    const { object } = await generateObject({
      model,
      schema: z.object({ clinicianReport: z.string(), patientSummary: z.string() }),
      temperature: 0,
      abortSignal: signal,
      system: buildReportSystemPrompt(REPORT_TERM_MAP),
      messages: [{ role: 'user', content: `Decided facts:\n${JSON.stringify(body.result, null, 2)}` }],
    });
    return object;
  });
  if (outcome.source === 'unavailable') {
    return { clinicianReport: '', patientSummary: '', source: 'template' as const, reason: outcome.reason, model: undefined };
  }
  const violation = violatesCage(outcome.value.clinicianReport, body.result) ?? violatesCage(outcome.value.patientSummary, body.result);
  if (violation) {
    // In the endpoint this falls back to the deterministic template; here we
    // surface the violation so the test fails loudly instead of passing on it.
    return { ...outcome.value, source: 'template' as const, reason: violation, model: outcome.model };
  }
  return { ...outcome.value, source: 'llm' as const, model: outcome.model, reason: undefined };
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

/**
 * A synthetic "wound": a dull red blob with a yellow patch on a pale ground.
 * Not a clinical image — the point is only that a real image round-trips
 * through the gateway and comes back as schema-valid enums.
 */
async function syntheticJpeg(): Promise<string> {
  const width = 256;
  const height = 256;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dx = x - 128;
      const dy = y - 128;
      const r = Math.sqrt(dx * dx + dy * dy);
      let rgb: [number, number, number] = [226, 200, 180];      // skin-ish ground
      if (r < 70) rgb = [150, 40, 40];                           // wound bed
      if (r < 70 && dx > 10 && dy < 10) rgb = [200, 180, 90];    // yellow patch
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
  const jpeg = (await import('jpeg-js')).default;
  return Buffer.from(jpeg.encode({ data: Buffer.from(data), width, height }, 90).data).toString('base64');
}

console.log('\n1. Caged VLM through the AI Gateway');
const image = await syntheticJpeg();
const vlm = await extractVlmFeatures({ base64: image, tissueSummary: { granulation: 70, slough: 20, necrotic: 0 } });

check('the gateway returned features', vlm.source === 'gateway', vlm.reason);
if (vlm.features) {
  console.log(`       model: ${vlm.model}  latency: ${vlm.latencyMs} ms`);
  console.log(`       ${JSON.stringify(vlm.features)}`);
  check('the response validates against the cage schema', vlmFeaturesSchema.safeParse(vlm.features).success);
  check('no free text leaked into the response', !JSON.stringify(vlm.features).match(/dressing|apply|recommend/i));
}

console.log('\n2. Determinism at temperature 0');
if (vlm.features) {
  const again = await extractVlmFeatures({ base64: image, tissueSummary: { granulation: 70, slough: 20, necrotic: 0 } });
  check(
    'two identical calls agree',
    JSON.stringify(again.features) === JSON.stringify(vlm.features),
    { first: vlm.features, second: again.features },
  );
}

console.log('\n3. Engine consumes the VLM features');
const result = evaluate({
  tissue: { necrosis: 0, slough: 20, granulation: 70, epithelial: 5, other: 5 },
  exudate: 'moderate',
  infection: 'no',
  markerFound: true,
  cvConfidence: 'high',
  vlm: vlm.features,
});
console.log(`       pathway: ${result.cwcsPathwayId}  confidence: ${result.confidence}  gates: [${result.gateCodes}]`);
check('the engine produced a decision (or withheld it for a stated reason)',
  result.cwcsPathwayId !== null || result.gateCodes.length > 0 || result.incompleteReasons.length > 0);

console.log('\n4. Report LLM, narrating decided facts only');
const report = await composeReport({ result, areaCm2: 12.4, bodyZoneLabel: 'Left lower leg' });
console.log(`       source: ${report.source}${report.model ? ` (${report.model})` : ''}${report.reason ? ` — ${report.reason}` : ''}`);
check('both documents were produced', Boolean(report.clinicianReport && report.patientSummary));
check('the report passed the cage check (source is llm, not a fallback)', report.source === 'llm', report.reason);
if (result.cwcsPathwayId !== null) {
  const wrongPathway = report.patientSummary.match(/pathway\s+(\d+)/i);
  check('no pathway other than the decided one is named',
    !wrongPathway || Number(wrongPathway[1]) === result.cwcsPathwayId, wrongPathway?.[0]);
}
console.log(`\n--- patient summary ---\n${report.patientSummary}\n--- end ---`);

console.log('\n5. Supabase round-trip');
if (!store.isStoreConfigured()) {
  console.log('       skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
} else {
  const id = `asmt-smoke-${Date.now()}`;
  const state = {
    id,
    createdAt: new Date().toISOString(),
    woundId: 'wound-smoke',
    result,
    vlm: vlm.features ?? null,
    // Provenance: which model produced the features. The audit trail is only
    // worth something if it records what actually generated the inputs.
    vlmModel: vlm.model ?? null,
    report: { clinicianReport: '', patientSummary: '', source: report.source, model: report.model },
    steps: [{ step: 'vlm' as const, status: 'ok' as const, ms: vlm.latencyMs, summary: 'smoke' }],
  };
  await store.saveAssessment(state);
  const loaded = await store.loadAssessment(id);
  check('the assessment was written and read back', loaded?.id === id, loaded);

  const audit = store.buildAuditRecord(state, { tissue: { necrosis: 0, slough: 20, granulation: 70, epithelial: 5, other: 5 } }, result);
  await store.writeAudit(audit);
  check('the audit record has a stable input hash', /^[0-9a-f]{8}$/.test(audit.inputsHash), audit.inputsHash);
  check('the audit record names the model that produced the VLM features', audit.models.vlm === vlm.model, audit.models);
  check('the audit record names the report model', audit.models.llm === report.model, audit.models);
  console.log(`       audit: pathway ${audit.cwcsPathwayId}, rules ${audit.rulesVersion}, hash ${audit.inputsHash}`);
  console.log(`       models: ${JSON.stringify(audit.models)}`);

  // writeAudit falls back to stdout when the DB is unreachable, so "no throw"
  // is not proof of a write. Read the row back through a separate client.
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: auditRows } = await db.from('audit_log').select('inputs_hash, models').eq('assessment_id', id);
  check('the audit row is really in the database', auditRows?.length === 1 && auditRows[0].inputs_hash === audit.inputsHash, auditRows);
  check('the persisted audit row carries the model ids', Boolean((auditRows?.[0]?.models as Record<string, string>)?.vlm), auditRows?.[0]?.models);

  if (process.env.SMOKE_KEEP_ROWS === 'true') {
    console.log(`       rows kept: assessments/${id} (SMOKE_KEEP_ROWS=true)`);
  } else {
    await db.from('audit_log').delete().eq('assessment_id', id);
    await db.from('wound_timeline').delete().eq('assessment_id', id);
    await db.from('assessments').delete().eq('id', id);
    const { data: left } = await db.from('assessments').select('id').eq('id', id);
    check('the smoke rows were cleaned up', left?.length === 0, left);
  }
}

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
process.exit(failed > 0 ? 1 : 0);
