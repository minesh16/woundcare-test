/**
 * The automatic pipeline (spec §11): what the app does across `/segment` →
 * `/measure` → `/run`, minus the clinician gate and minus persistence. It calls
 * only existing exports. Every stage is timed and caught: a failed stage never
 * crashes the item.
 *
 * One deliberate refinement over the spec's single tissue call (§11.1 step 4),
 * made for fidelity and recorded in eval/NOTES.md: the app measures TWICE. The
 * client's `/measure` call runs `analyzeTissue({ measure: true })` (coin, white
 * balance, size); `/run` then re-runs `analyzeTissue` WITHOUT measure mode,
 * passing the coin's px/cm — so the engine's tissue % is not white-balanced and
 * its periwound band does not exclude the coin. The harness does the same. When
 * no coin and no white patch were found the two calls are provably identical
 * (same pixels, same mask, no band), so the second is skipped.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateText } from 'ai';

import { cropsFromMask } from '../../api/_crops';
import { loadMaskPixels } from '../../api/_maskIO';
import { compareMasks } from '../../api/_maskGeometry';
import { runSegmentation, type SegmentationOutcome } from '../../api/_segmentation';
import { maskPlausibility } from '../../api/_segmentationParse';
import { callGateway } from '../../api/v1/assessments/_gateway';
import { composeReport } from '../../api/v1/assessments/report';
import { analyzeTissue, type TissueResponse } from '../../api/v1/assessments/tissue';
import { extractVlmFeatures } from '../../api/v1/assessments/vlm-features';
import { BODY_ZONE_LABELS } from '../../src/constants/bodyZones';
import { measuredView } from '../../src/assessment/measured';
import { rgbToLab } from '../../src/cv/tissueClassifier';
import { CWCS_RULES_VERSION, evaluate } from '../../src/decision/engine';
import type { EngineInputs, EngineResult, VlmFeatures } from '../../src/decision/engine.types';
import { violatesCage } from '../../src/decision/reportCage';
import type { BodyZone } from '../../src/decision/types';
import { vlmFeaturesSchema } from '../../src/decision/vlm.schema';
import { buildEngineInputs, sessionFor, type Policy } from './engineInputs';
import { datasetCacheDir, REPO_ROOT } from './env';
import { decodeImage, maskDataUri, maskPixelsFrom, normaliseImage, readMaskPng, safeKey, toGrid, writeMaskPng, type NormalisedImage } from './io';
import type { EvalItem, Prediction, ResultRow } from './schema';
import { dominantFromAxis } from './vocab';

export const SEG_ARMS = ['chain', 'sam3', 'fusegnet', 'hsv'] as const;
export type SegArm = (typeof SEG_ARMS)[number];
export type Boundary = 'auto' | 'gt-mask';

export function armName(seg: SegArm, boundary: Boundary, policy: Policy): string {
  return `${seg}|${boundary}|${policy}`;
}

export type PipelineContext = {
  runId: string;
  /** EVAL_OUT_DIR/<runId> */
  runDir: string;
  seg: SegArm;
  boundary: Boundary;
  policy: Policy;
  withVlm?: boolean;
  withReport?: boolean;
  withBaseline?: boolean;
  /** Bounds concurrent gateway calls (spec §13.2: 2 at a time). */
  gateway?: <T>(fn: () => Promise<T>) => Promise<T>;
};

const passthrough = <T,>(fn: () => Promise<T>) => fn();

/** The baseline arm's prompt, read verbatim from the app's own handler (spec §11.1 step 9). */
let baselinePrompt: string | null = null;
export function baselinePromptText(): string {
  if (baselinePrompt) return baselinePrompt;
  const source = readFileSync(join(REPO_ROOT, 'api/v1/assessments/baseline.ts'), 'utf8');
  const match = source.match(/type:\s*'text',\s*text:\s*'([^']+)'/);
  if (!match) throw new Error('Could not read the baseline prompt from api/v1/assessments/baseline.ts.');
  baselinePrompt = match[1];
  return baselinePrompt;
}

// ---------------------------------------------------------------------------
// Skin-tone proxy (spec §14.8)
// ---------------------------------------------------------------------------

export const ITA_BANDS = ['very_light', 'light', 'intermediate', 'tan', 'brown', 'dark'] as const;

export function itaBand(ita: number): (typeof ITA_BANDS)[number] {
  if (ita > 55) return 'very_light';
  if (ita > 41) return 'light';
  if (ita > 28) return 'intermediate';
  if (ita > 10) return 'tan';
  if (ita > -30) return 'brown';
  return 'dark';
}

/** Two-pass chamfer distance (1, √2) from the set pixels of `mask`. */
export function distanceFrom(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] ? 0 : INF;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * ITA° from the periwound ring 2–6% of the image diagonal outside the mask:
 * median L* and b*, ITA = atan((L*−50)/b*)·180/π. An image-derived proxy, not a
 * clinical skin-tone measure, and affected by lighting.
 */
export function skinToneProxy(img: NormalisedImage, mask: Uint8Array): { itaDeg: number; band: string } | null {
  const rgba = decodeImage(img.bytes);
  if (rgba.width !== img.width || rgba.height !== img.height) return null;
  const { width: w, height: h } = img;
  if (!mask.some((v) => v)) return null;
  const diag = Math.hypot(w, h);
  const lo = 0.02 * diag;
  const hi = 0.06 * diag;
  const dist = distanceFrom(mask, w, h);
  const L: number[] = [];
  const B: number[] = [];
  for (let i = 0; i < w * h; i += 1) {
    if (dist[i] < lo || dist[i] > hi) continue;
    const o = i * 4;
    const lab = rgbToLab(rgba.data[o], rgba.data[o + 1], rgba.data[o + 2]);
    L.push(lab.L);
    B.push(lab.b);
  }
  if (L.length < 50) return null;
  const itaDeg = (Math.atan2(median(L) - 50, median(B)) * 180) / Math.PI;
  return { itaDeg: Number(itaDeg.toFixed(2)), band: itaBand(itaDeg) };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * A central box (middle 40% of each side), used as the "lesion" for the skin-tone ring when an item has
 * no GT and no predicted mask. Without it, only items WITH a mask get a skin-tone band — which, for
 * negatives, means only the false positives do, and per-band FP rates are biased towards 100%.
 */
export function centreMask(w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = Math.floor(0.3 * h); y < Math.ceil(0.7 * h); y += 1) for (let x = Math.floor(0.3 * w); x < Math.ceil(0.7 * w); x += 1) m[y * w + x] = 255;
  return m;
}

export function loadItemImage(item: EvalItem): NormalisedImage {
  const bytes = readFileSync(join(datasetCacheDir(item.datasetId), item.normPath));
  return normaliseImage(bytes.toString('base64'));
}

export function loadGtMask(item: EvalItem): Uint8Array | null {
  if (!item.gt.woundMaskPath) return null;
  const mask = readMaskPng(join(datasetCacheDir(item.datasetId), item.gt.woundMaskPath));
  return toGrid(mask, item.width, item.height);
}

export function maskPathFor(runDir: string, itemId: string, arm: string): string {
  return join(runDir, 'masks', `${safeKey(itemId)}__${safeKey(arm)}.png`);
}

type Stage = 'normalise' | 'segment' | 'measure' | 'tissue_run' | 'vlm' | 'evaluate' | 'report' | 'baseline' | 'skin_tone' | 'write_mask';

function emptyEngine(): Prediction['engine'] {
  return {
    status: 'incomplete',
    pathwayWithheld: false,
    gateCodes: [],
    cwcsPathwayId: null,
    confidence: 'low',
    referrals: [],
    incompleteReasons: [],
    rulesVersion: CWCS_RULES_VERSION,
  };
}

/** Everything the pipeline produced for one item × arm, plus what `parity` compares. */
export type PipelineOutput = {
  row: ResultRow;
  engineInputs: EngineInputs | null;
  result: EngineResult | null;
};

/**
 * Run one item through one arm. `maskOverride` replaces segmentation with a
 * supplied mask on the analysis grid (the `gt-mask` arm, and `parity`).
 */
export async function runPipeline(
  item: EvalItem,
  ctx: PipelineContext,
  opts: { maskOverride?: Uint8Array | null; writeMask?: boolean; image?: NormalisedImage } = {},
): Promise<PipelineOutput> {
  const arm = armName(ctx.seg, ctx.boundary, ctx.policy);
  const timings: Record<string, number> = {};
  const errors: Prediction['errors'] = [];
  const gateway = ctx.gateway ?? passthrough;
  const startedAll = Date.now();

  async function stage<T>(name: Stage, fn: () => Promise<T> | T): Promise<T | null> {
    const t0 = Date.now();
    try {
      return await fn();
    } catch (error) {
      errors.push({ stage: name, message: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      timings[name] = (timings[name] ?? 0) + (Date.now() - t0);
    }
  }

  const base = (status: ResultRow['status'], prediction: Prediction | null, error?: string): PipelineOutput => ({
    row: { runId: ctx.runId, itemId: item.id, arm, status, prediction, timings, error: error ?? null, at: new Date().toISOString() },
    engineInputs: null,
    result: null,
  });

  // 1. Normalise
  const img = await stage('normalise', () => opts.image ?? loadItemImage(item));
  if (!img) return base('failed', null, errors[0]?.message ?? 'image could not be loaded');
  const frame = { width: img.width, height: img.height };
  const bodyZone = item.gt.bodyZone ?? null;

  // 2. Segment
  let outcome: SegmentationOutcome | null = null;
  let maskUri: string | null = null;
  let maskGrid: Uint8Array | null = null;
  const override = ctx.boundary === 'gt-mask' ? (opts.maskOverride ?? loadGtMask(item)) : (opts.maskOverride ?? null);
  if (ctx.boundary === 'gt-mask' && !override) return base('skipped', null, 'no ground-truth wound mask for the gt-mask arm');

  if (override) {
    maskGrid = override;
    maskUri = maskDataUri(override, img.width, img.height);
  } else {
    outcome = await stage('segment', () => runSegmentation({ image: img, prompts: null, bodyZone }));
    if (outcome?.mask) {
      const mask = outcome.mask;
      const pixels = await stage('segment', () => loadMaskPixels(mask));
      if (pixels) {
        maskUri = outcome.mask;
        maskGrid = toGrid(pixels, img.width, img.height);
      } else {
        errors.push({ stage: 'segment', message: 'the returned mask could not be decoded' });
      }
    }
  }

  // 3. Plausibility — recorded, never a gate.
  const areaPx = maskGrid ? maskPixelsFrom(maskGrid, img.width, img.height).areaPx : null;
  const plausibility = areaPx === null ? 'empty' : maskPlausibility(areaPx, img.width * img.height);
  const segmentation: Prediction['segmentation'] = override
    ? {
        source: null,
        model: 'ground_truth',
        score: null,
        confidence: 'high',
        plausibility,
        multipleRegions: null,
        candidates: 1,
        latencyMs: 0,
        attempts: [],
        secondOpinion: null,
        areaPx,
        frame,
        promptConflict: false,
      }
    : {
        source: outcome?.source ?? null,
        model: outcome?.model ?? null,
        score: outcome?.score ?? null,
        confidence: outcome?.confidence ?? 'low',
        plausibility,
        multipleRegions: outcome?.multipleRegions ?? null,
        candidates: outcome?.candidates ?? 0,
        latencyMs: outcome?.latencyMs ?? timings.segment ?? 0,
        attempts: (outcome?.attempts ?? []).map((a) => ({ provider: a.provider, status: a.status, ms: a.ms, ...(a.reason ? { reason: a.reason } : {}) })),
        secondOpinion: outcome?.secondOpinion
          ? outcome.secondOpinion.status === 'ok'
            ? {
                status: 'ok',
                agreementIoU: outcome.secondOpinion.agreementIoU,
                latencyMs: outcome.secondOpinion.latencyMs,
                multipleRegions: outcome.secondOpinion.multipleRegions,
              }
            : { status: outcome.secondOpinion.status, agreementIoU: null, reason: outcome.secondOpinion.reason }
          : null,
        areaPx,
        frame,
        promptConflict: outcome?.promptConflict ?? false,
      };
  const woundPresent = Boolean(maskGrid && plausibility === 'plausible');
  const maskProvider = outcome?.source === 'sam3' || outcome?.source === 'fusegnet' ? outcome.source : null;

  // 4. Measure (/measure) + the /run tissue step.
  let measure: TissueResponse | null = null;
  let runTissue: TissueResponse | null = null;
  if (maskUri) {
    const uri = maskUri;
    measure = await stage('measure', () =>
      analyzeTissue({ base64: img.base64, mask: uri, maskProvider, measure: true, includeCoinReference: true }),
    );
    const m = measure?.measurement;
    const needsRunStep = Boolean(m && (m.scale || m.whiteBalance.applied || m.classifier !== 'absolute'));
    if (measure && !needsRunStep) {
      runTissue = measure;
    } else if (measure) {
      const pxPerCm = sessionFor({ measure, bodyZone }).measurement?.scale?.pxPerCm ?? null;
      runTissue = await stage('tissue_run', () => analyzeTissue({ base64: img.base64, mask: uri, maskProvider, pxPerCm }));
    }
  }
  const tissue = runTissue?.tissue ?? null;
  const tissuePct = tissue
    ? { granulation: tissue.granulation, slough: tissue.slough, necrotic: tissue.necrotic, epithelial: tissue.epithelial, other: tissue.other }
    : null;
  const tissueSentinel = Boolean(tissuePct && Object.values(tissuePct).every((v) => v === 20));
  const mm = measure?.measurement ?? null;
  const measurement: Prediction['measurement'] = mm
    ? {
        markerFound: mm.scale !== null,
        pxPerCm: mm.scale?.pxPerCm ?? null,
        coinSupport: mm.scale?.support ?? null,
        areaCm2: mm.geometry.areaCm2,
        lengthCm: mm.geometry.lengthCm,
        widthCm: mm.geometry.widthCm,
        perimeterCm: mm.geometry.perimeterCm,
        whiteBalanced: mm.whiteBalance.applied,
        classifier: mm.classifier,
      }
    : null;

  // 5. VLM (opt-in)
  let vlm: Prediction['vlm'] = null;
  let vlmFeatures: VlmFeatures | undefined;
  if (ctx.withVlm && maskUri) {
    const uri = maskUri;
    const response = await stage('vlm', async () => {
      const pixels = await loadMaskPixels(uri);
      const crops = pixels ? cropsFromMask(img.base64, pixels) : null;
      return gateway(() =>
        extractVlmFeatures({
          base64: img.base64,
          woundCrop: crops?.wound ?? null,
          periwoundCrop: crops?.periwound ?? null,
          tissueSummary: tissue ?? undefined,
        }),
      );
    });
    if (response) {
      vlmFeatures = response.features;
      vlm = {
        source: response.source,
        model: response.model ?? null,
        features: response.features ?? null,
        latencyMs: response.latencyMs,
        schemaValid: response.features ? vlmFeaturesSchema.safeParse(response.features).success : undefined,
      };
    }
  }

  // 6–7. Engine inputs → decide
  const built = buildEngineInputs({ measure, runTissue, vlm: vlmFeatures, bodyZone, policy: ctx.policy, gt: item.gt });
  let result: EngineResult | null = null;
  if (built.inputs) {
    const inputs = built.inputs;
    result = await stage('evaluate', () => evaluate(inputs));
  }
  const engine: Prediction['engine'] = result
    ? {
        status: result.status,
        pathwayWithheld: result.pathwayWithheld,
        gateCodes: result.gateCodes,
        cwcsPathwayId: result.cwcsPathwayId,
        confidence: result.confidence,
        referrals: result.referrals.map((r) => ({ urgency: r.urgency, code: r.code })),
        incompleteReasons: result.incompleteReasons,
        rulesVersion: result.rulesVersion,
      }
    : emptyEngine();

  // 8. Report (opt-in)
  let report: Prediction['report'] = null;
  if (ctx.withReport && result) {
    const decided = result;
    const view = measuredView(sessionFor({ measure, bodyZone }));
    const composed = await stage('report', () =>
      gateway(() =>
        composeReport({
          result: decided,
          areaCm2: view?.areaCm2 ?? null,
          bodyZoneLabel: bodyZone && bodyZone in BODY_ZONE_LABELS ? BODY_ZONE_LABELS[bodyZone as BodyZone] : null,
          tissuePct: tissue
            ? { granulation: tissue.granulation, slough: tissue.slough, necrosis: tissue.necrotic, epithelial: tissue.epithelial }
            : null,
        }),
      ),
    );
    if (composed) {
      // composeReport already swaps a cage-violating LLM text for the template;
      // its `reason` is where that violation is recorded.
      const finalViolation = violatesCage(composed.clinicianReport, decided) ?? violatesCage(composed.patientSummary, decided);
      const rejected = composed.source === 'template' && typeof composed.reason === 'string' && /^Report (names|discusses)/.test(composed.reason);
      report = {
        source: composed.source,
        cageViolation: Boolean(finalViolation) || rejected,
        cageReason: finalViolation ?? (rejected ? composed.reason ?? null : null),
        model: composed.model ?? null,
      };
    }
  }

  // 9. Baseline (opt-in) — stored verbatim, never scored for correctness.
  let baseline: Prediction['baseline'] = null;
  if (ctx.withBaseline) {
    const prompt = baselinePromptText();
    const outcome2 = await stage('baseline', () =>
      gateway(() =>
        callGateway('vlm', async (model, signal) => {
          const { text } = await generateText({
            model,
            abortSignal: signal,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image', image: img.dataUrl }] }],
          });
          return text;
        }),
      ),
    );
    baseline = outcome2 && outcome2.source === 'gateway' ? { text: outcome2.value, model: outcome2.model } : { text: null, model: null };
  }

  // Skin-tone proxy: from the GT mask when there is one (stable across arms), else the predicted mask.
  const toneMask = (item.gt.woundMaskPath ? loadGtMaskSafe(item) : null) ?? maskGrid ?? centreMask(img.width, img.height);
  const skinTone = await stage('skin_tone', () => skinToneProxy(img, toneMask));

  // 10. Write the predicted mask.
  let maskPath: string | null = null;
  if (maskGrid && opts.writeMask !== false) {
    const path = maskPathFor(ctx.runDir, item.id, arm);
    const grid = maskGrid;
    const ok = await stage('write_mask', () => {
      mkdirSync(dirname(path), { recursive: true });
      writeMaskPng(path, grid, img.width, img.height);
      return true;
    });
    if (ok) maskPath = path;
  }

  timings.total = Date.now() - startedAll;
  const prediction: Prediction = {
    woundPresent,
    maskPath,
    segmentation,
    measurement,
    tissuePct,
    tissuePctRelative: mm?.comparison.relative ?? null,
    tissueSentinel,
    periwound: tissue?.periwound ? { rednessPct: tissue.periwound.rednessPct, maceration: tissue.periwound.maceration } : null,
    dominantTissue: dominantFromAxis(result?.axes.tissue ?? null),
    exudate: result?.axes.exudate ?? null,
    infection: result?.axes.infection ?? null,
    engine,
    vlm,
    report,
    baseline,
    skinToneProxy: skinTone ?? null,
    timings,
    errors,
  };
  const out = base('ok', prediction);
  return { ...out, engineInputs: built.inputs, result };
}

function loadGtMaskSafe(item: EvalItem): Uint8Array | null {
  try {
    return loadGtMask(item);
  } catch {
    return null;
  }
}

/** IoU via the app's own `compareMasks` — the cross-check for the harness's IoU (spec §14.2). */
export function appIoU(a: Uint8Array, b: Uint8Array, w: number, h: number): number | null {
  return compareMasks({ data: a, width: w, height: h }, { data: b, width: w, height: h }, w, h).iou;
}
