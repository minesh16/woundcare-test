/**
 * Parity, stage A (spec §12) — runs ONLY as the child of `eval/cli.mts parity`.
 *
 * Builds each image's mask with the harness pipeline (HSV: both providers are
 * blanked), then hands image + mask to the app's real orchestrator,
 * `runAssessment`, under an in-memory approval. With SUPABASE_* removed the
 * app's `_store.ts` returns early and `writeAudit` logs to stdout; with no
 * gateway the VLM degrades to `unavailable` and the report to its template.
 * Nothing is persisted and nothing is paid for.
 *
 *   npx tsx eval/src/parity.child.mts <input.json> <output.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

if (process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('parity child: SUPABASE_* is set — refusing to run.');
  process.exit(3);
}
if (process.env.EVAL_PARITY_CHILD !== '1') {
  console.error('parity child: run me through `npx tsx eval/cli.mts parity`.');
  process.exit(3);
}

// tsx loads the .ts modules as CommonJS. Their named exports appear on the dynamic-import
// namespace; `default` is a module's OWN default export (e.g. an endpoint handler), so it is
// only unwrapped when nothing else was detected.
const load = async <T,>(path: string): Promise<T> => {
  const mod = (await import(path)) as Record<string, unknown>;
  const named = Object.keys(mod).filter((k) => k !== 'default');
  return (named.length === 0 && mod.default && typeof mod.default === 'object' ? mod.default : mod) as T;
};

const { runAssessment } = await load<typeof import('../../api/v1/assessments/_controller')>('../../api/v1/assessments/_controller.ts');
const { maskSha256, loadMaskPixels } = await load<typeof import('../../api/_maskIO')>('../../api/_maskIO.ts');
const { analyzeTissue } = await load<typeof import('../../api/v1/assessments/tissue')>('../../api/v1/assessments/tissue.ts');
const { isGatewayConfigured } = await load<typeof import('../../api/v1/assessments/_gateway')>('../../api/v1/assessments/_gateway.ts');
const { runPipeline } = await load<typeof import('./pipeline')>('./pipeline.ts');
const { baseInputs } = await load<typeof import('./engineInputs')>('./engineInputs.ts');
const { normaliseImage } = await load<typeof import('./io')>('./io.ts');

type Input = import('./parity').ParityChildInput;
type Output = import('./parity').ParityChildOutput;

const [inputPath, outputPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath, 'utf8')) as Input;
const output: Output = {
  env: {
    supabase: Boolean(process.env.SUPABASE_URL),
    gateway: isGatewayConfigured(),
    fal: Boolean(process.env.FAL_KEY),
    modal: Boolean(process.env.FUSEGNET_MODAL_URL),
  },
  cases: [],
};

for (const image of input.images) {
  const img = normaliseImage(readFileSync(image.path).toString('base64'));
  const item = {
    id: `parity:${image.id}`,
    datasetId: 'parity',
    key: image.id,
    split: null,
    imageSha256: img.sha256,
    dhash: '',
    relPath: '',
    normPath: '',
    width: img.width,
    height: img.height,
    gt: { rawLabels: {} },
    strata: {},
    duplicateOf: null,
  };
  const built = await runPipeline(item, { runId: 'parity', runDir: input.outDir, seg: 'hsv', boundary: 'auto', policy: 'image_only' }, { image: img });
  const maskPath = built.row.prediction?.maskPath;
  if (!maskPath) throw new Error(`parity child: no HSV mask for ${image.id}: ${JSON.stringify(built.row.prediction?.errors ?? built.row.error)}`);
  const mask = `data:image/png;base64,${readFileSync(maskPath).toString('base64')}`;
  const pixels = await loadMaskPixels(mask);
  if (!pixels) throw new Error(`parity child: mask for ${image.id} did not decode`);

  // What the client sends to /run after /measure.
  const measure = await analyzeTissue({ base64: img.base64, mask, maskProvider: null, measure: true, includeCoinReference: true });
  const { inputs, pxPerCm } = baseInputs({ measure, bodyZone: null });

  const approval = {
    id: `parity-${image.id}`,
    keyId: 'eval-parity',
    orgId: 'eval',
    assessmentId: `parity-${image.id}`,
    imageSha256: img.sha256,
    maskSha256: maskSha256(pixels),
    approval: 'drawn' as const,
    clinicianId: null,
    provider: null,
    model: null,
    correctionId: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const state = await runAssessment(
    { state: { id: `parity-${image.id}`, createdAt: new Date().toISOString() }, base64: img.base64, engineInputs: inputs, pxPerCm, mask, approval },
    () => {},
  );
  if (!state.result || !state.engineInputs) throw new Error(`parity child: runAssessment returned no result for ${image.id}`);
  output.cases.push({ id: image.id, maskPath, result: state.result, engineInputs: state.engineInputs, pxPerCm });
}

writeFileSync(outputPath, JSON.stringify(output));
console.log(`parity child: ${output.cases.length} case(s) through runAssessment.`);
