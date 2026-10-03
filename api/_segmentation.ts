/**
 * The segmentation facade: one call that proposes a wound boundary for the
 * clinician to review (segmentation build spec §3, §6.4).
 *
 *   1. SAM 3 (fal.ai), with the text prompt "wound" plus any taps and box the
 *      clinician has added on the review screen. When it returns several masks,
 *      the spec's rule picks one: drop masks that contradict a tap, then take
 *      the highest score.
 *   2. FUSegNet (Modal), two roles:
 *        - SECOND OPINION on SAM 3's box, for foot wounds (`FUSEGNET_TRIGGER`).
 *          Agreement between the two outlines sets the confidence.
 *        - FALLBACK when SAM 3 fails or returns an implausible mask.
 *   3. The HSV colour mask, when no model answers — `source: 'hsv'`, so the
 *      review screen can say so and the clinician corrects it with the same tools.
 *
 * Never throws: a dead backend becomes a recorded attempt. The cage is
 * unchanged — every provider produces a BOUNDARY only, and nothing downstream
 * runs until a clinician approves it.
 */

import { isFusegnetConfigured, runFusegnet } from './_fusegnet';
import { hsvMaskFromImage } from './_hsvMask';
import type { NormalisedImage } from './_image';
import { compareMasks, traceOutline, type MaskPoint } from './_maskGeometry';
import { loadMaskPixels, toPngDataUri, type MaskPixels } from './_maskIO';
import { isSam3Configured, runSam3 } from './_sam3';
import {
  agreementConfidence,
  confidenceFromScore,
  cxcywhToPixelBox,
  describePlausibility,
  maskBoxCxcywh,
  maskPlausibility,
  parseProviderOrder,
  selectByPrompts,
  shouldRunSecondOpinion,
  type MaskConfidence,
  type SegmentationProvider,
  type SegmentPrompts,
} from './_segmentationParse';

export type { MaskConfidence, SegmentationProvider, SegmentPrompts } from './_segmentationParse';
export type { MaskPoint, BoundaryApproval } from './_maskGeometry';

/**
 * How the boundary was obtained:
 *  - `concept`: a generalist told to find "wound" (plus any taps / box)
 *  - `wound-specific`: a wound-only model, nothing to disambiguate
 *  - `colour`: the HSV threshold fallback — no model at all
 */
export type PromptMode = 'concept' | 'wound-specific' | 'colour';

export type AttemptStatus = 'ok' | 'skipped' | 'failed' | 'implausible';

export type SegmentationAttempt = {
  provider: SegmentationProvider | 'hsv';
  status: AttemptStatus;
  ms: number;
  reason?: string;
};

/** FUSegNet's second opinion on SAM 3's boundary (spec §6.4). */
export type SecondOpinion =
  | {
      status: 'ok';
      model: string;
      mask: string;
      outline: MaskPoint[] | null;
      /** IoU of the two outlines on SAM 3's grid. */
      agreementIoU: number | null;
      regions: Record<string, number | boolean> | null;
      regionsKept: number | null;
      multipleRegions: boolean | null;
      meanProb: number | null;
      latencyMs: number | null;
      ms: number;
    }
  | { status: 'unavailable'; reason: string; ms: number };

export type SegmentationOutcome = {
  /** Who drew `mask`: a model, the colour fallback, or nobody (null). */
  source: SegmentationProvider | 'hsv' | null;
  /** The model provider, when a model drew it. */
  provider: SegmentationProvider | null;
  mask: string | null;
  /** The chosen mask's own score, when the provider reports one. */
  score: number | null;
  /** Normalised [cx, cy, w, h] of the chosen mask. */
  box: [number, number, number, number] | null;
  confidence: MaskConfidence;
  model: string | null;
  promptMode: PromptMode | null;
  /** Editable fractional polygon traced from the mask, for the review screen. */
  outline: MaskPoint[] | null;
  multipleRegions: boolean | null;
  /** Dimensions of the image the models saw (≤ 1024 on the longer edge). */
  frame: { width: number; height: number };
  /** Set pixels of the chosen mask, and the mask's frame size. */
  areaPx: number | null;
  totalPx: number | null;
  /** How many candidate masks the provider returned. */
  candidates: number;
  /** No candidate satisfied every tap — the top-scoring one was used anyway. */
  promptConflict: boolean;
  secondOpinion: SecondOpinion | null;
  /** Why there was no second opinion, when there was none. */
  secondOpinionReason: string | null;
  latencyMs: number;
  attempts: SegmentationAttempt[];
  reason?: string;
};

type Candidate = {
  mask: string;
  pixels: MaskPixels;
  score: number | null;
  box: [number, number, number, number] | null;
  confidence: MaskConfidence;
  model: string;
  promptMode: PromptMode;
  multipleRegions: boolean | null;
  candidates: number;
  promptConflict: boolean;
};

/** Providers in the configured order, annotated with whether they can run. */
export function providerStatus(): { provider: SegmentationProvider; configured: boolean }[] {
  return providerOrder().map((provider) => ({ provider, configured: isProviderConfigured(provider) }));
}

function providerOrder(): SegmentationProvider[] {
  return parseProviderOrder(process.env.SEGMENTATION_PROVIDERS ?? process.env.SEGMENT_PROVIDER);
}

export function isProviderConfigured(provider: SegmentationProvider): boolean {
  return provider === 'sam3' ? isSam3Configured() : isFusegnetConfigured();
}

/** True when at least one provider in the configured order can run. */
export function isSegmentationConfigured(): boolean {
  return providerStatus().some((p) => p.configured);
}

const MISSING_ENV: Record<SegmentationProvider, string> = {
  sam3: 'FAL_KEY',
  fusegnet: 'FUSEGNET_MODAL_URL',
};

/** A mask that came back but cannot be a wound. Distinguished so the audit trail can say so. */
class ImplausibleMask extends Error {}

function hit(mask: MaskPixels, xPct: number, yPct: number): boolean {
  const x = Math.min(mask.width - 1, Math.max(0, Math.floor(xPct * mask.width)));
  const y = Math.min(mask.height - 1, Math.max(0, Math.floor(yPct * mask.height)));
  return mask.data[y * mask.width + x] !== 0;
}

function assertPlausible(provider: string, pixels: MaskPixels): void {
  const verdict = maskPlausibility(pixels.areaPx, pixels.totalPx);
  if (verdict !== 'plausible') throw new ImplausibleMask(`${provider}: ${describePlausibility(verdict)}.`);
}

async function trySam3(image: NormalisedImage, prompts: SegmentPrompts): Promise<Candidate> {
  const result = await runSam3({ imageDataUrl: image.dataUrl, imageBytes: image.bytes, prompts });
  const decoded = await Promise.all(result.masks.map((m) => loadMaskPixels(m)));
  const points = prompts.points ?? [];

  const usable = decoded
    .map((pixels, index) => ({ pixels, index }))
    .filter((d): d is { pixels: MaskPixels; index: number } => d.pixels !== null);
  if (usable.length === 0) throw new Error('SAM 3 returned masks that could not be decoded.');

  const choice = selectByPrompts(
    usable.map((u) => ({
      score: result.scores?.[u.index] ?? null,
      pointHits: points.map((p) => hit(u.pixels, p.xPct, p.yPct)),
    })),
    points.map((p) => p.label),
  );
  const chosen = usable[choice?.index ?? 0];
  assertPlausible('SAM 3', chosen.pixels);

  const score = result.scores?.[chosen.index] ?? null;
  const conflict = choice?.conflict ?? false;
  return {
    mask: result.masks[chosen.index],
    pixels: chosen.pixels,
    score,
    box: result.boxes?.[chosen.index] ?? maskBoxCxcywh(chosen.pixels.data, chosen.pixels.width, chosen.pixels.height),
    // A mask that contradicts the clinician's own taps is low confidence,
    // whatever the model thinks of it.
    confidence: conflict ? 'low' : confidenceFromScore(score),
    model: result.model,
    promptMode: 'concept',
    multipleRegions: result.masks.length > 1,
    candidates: result.masks.length,
    promptConflict: conflict,
  };
}

async function tryFusegnet(image: NormalisedImage): Promise<Candidate> {
  const result = await runFusegnet({ imageDataUrl: image.dataUrl });
  const pixels = await loadMaskPixels(result.mask);
  if (!pixels) throw new Error('FUSegNet returned a mask that could not be decoded.');
  assertPlausible('FUSegNet', pixels);
  return {
    mask: result.mask,
    pixels,
    score: result.score,
    box: maskBoxCxcywh(pixels.data, pixels.width, pixels.height),
    // As a FALLBACK, FUSegNet has no second model to agree with. Its mean_prob
    // can only downgrade (it has no abstain — it outlined a carpet at 0.95), so
    // the best it gets alone is medium.
    confidence: typeof result.score === 'number' && result.score < 0.5 ? 'low' : 'medium',
    model: result.model,
    promptMode: 'wound-specific',
    multipleRegions: result.multipleRegions,
    candidates: 1,
    promptConflict: false,
  };
}

/** FUSegNet on SAM 3's box. Never throws — any failure means "skip it" (spec §6.4). */
async function secondOpinion(image: NormalisedImage, sam: Candidate): Promise<SecondOpinion> {
  const started = Date.now();
  try {
    const box = sam.box ? cxcywhToPixelBox(sam.box, image) : null;
    const result = await runFusegnet({ imageDataUrl: image.dataUrl, box });
    const pixels = await loadMaskPixels(result.mask);
    if (!pixels) throw new Error('mask could not be decoded');
    const iou = compareMasks(sam.pixels, pixels, sam.pixels.width, sam.pixels.height).iou;
    return {
      status: 'ok',
      model: result.model,
      mask: result.mask,
      outline: traceOutline(pixels.data, pixels.width, pixels.height),
      agreementIoU: iou === null ? null : Number(iou.toFixed(4)),
      regions: result.regions,
      regionsKept: result.regionsKept,
      multipleRegions: result.multipleRegions,
      meanProb: result.score,
      latencyMs: result.latencyMs,
      ms: Date.now() - started,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'second opinion failed';
    console.warn(`fusegnet: unavailable — ${reason}`);
    return { status: 'unavailable', reason, ms: Date.now() - started };
  }
}

async function hsvFallback(image: NormalisedImage): Promise<Candidate | null> {
  const hsv = await hsvMaskFromImage(image.base64);
  let areaPx = 0;
  for (let i = 0; i < hsv.data.length; i += 1) if (hsv.data[i]) areaPx += 1;
  if (areaPx === 0) return null;
  const pixels: MaskPixels = { ...hsv, areaPx, totalPx: hsv.width * hsv.height };
  return {
    mask: toPngDataUri(hsv.data, hsv.width, hsv.height),
    pixels,
    score: null,
    box: maskBoxCxcywh(hsv.data, hsv.width, hsv.height),
    // A colour threshold is not a wound detector: it is a starting point for the
    // clinician to correct, never something to approve unread.
    confidence: 'low',
    model: 'hsv-threshold',
    promptMode: 'colour',
    multipleRegions: null,
    candidates: 1,
    promptConflict: false,
  };
}

/**
 * Propose a boundary. `bodyZone` decides whether FUSegNet gives a second
 * opinion; `prompts` are the clinician's text, taps and box from review.
 */
export async function runSegmentation(args: {
  image: NormalisedImage;
  prompts?: SegmentPrompts | null;
  bodyZone?: string | null;
}): Promise<SegmentationOutcome> {
  const started = Date.now();
  const prompts = args.prompts ?? {};
  const attempts: SegmentationAttempt[] = [];
  const frame = { width: args.image.width, height: args.image.height };

  let provider: SegmentationProvider | null = null;
  let candidate: Candidate | null = null;

  for (const p of providerOrder()) {
    if (!isProviderConfigured(p)) {
      attempts.push({ provider: p, status: 'skipped', ms: 0, reason: `not configured (${MISSING_ENV[p]} unset)` });
      continue;
    }
    const t0 = Date.now();
    try {
      candidate = p === 'sam3' ? await trySam3(args.image, prompts) : await tryFusegnet(args.image);
      provider = p;
      attempts.push({ provider: p, status: 'ok', ms: Date.now() - t0 });
      break;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'segmentation failed';
      attempts.push({ provider: p, status: error instanceof ImplausibleMask ? 'implausible' : 'failed', ms: Date.now() - t0, reason });
      console.warn(`Segmentation provider ${p} did not produce a usable mask: ${reason}`);
    }
  }

  // Second opinion: only on a SAM 3 boundary, only when the trigger says so.
  let opinion: SecondOpinion | null = null;
  let opinionReason: string | null = null;
  let confidence = candidate?.confidence ?? 'low';
  if (provider === 'sam3' && candidate) {
    if (!isFusegnetConfigured()) {
      opinionReason = 'FUSegNet not configured';
    } else if (!shouldRunSecondOpinion(process.env.FUSEGNET_TRIGGER, args.bodyZone)) {
      opinionReason = `not triggered (FUSEGNET_TRIGGER=${process.env.FUSEGNET_TRIGGER ?? 'foot'}, location ${args.bodyZone ?? 'unknown'})`;
    } else {
      opinion = await secondOpinion(args.image, candidate);
      if (opinion.status === 'ok') {
        // Agreement between two independent models replaces the score-based band.
        confidence = agreementConfidence({
          iou: opinion.agreementIoU,
          multipleRegions: opinion.multipleRegions,
          regionsKept: opinion.regionsKept,
        });
      } else {
        opinionReason = opinion.reason;
      }
    }
  }

  let source: SegmentationOutcome['source'] = provider;
  let reason: string | undefined;
  if (!candidate) {
    reason = summariseFailure(attempts);
    const t0 = Date.now();
    try {
      candidate = await hsvFallback(args.image);
      attempts.push({
        provider: 'hsv',
        status: candidate ? 'ok' : 'failed',
        ms: Date.now() - t0,
        reason: candidate ? undefined : 'the colour estimate found no wound-coloured area',
      });
      if (candidate) {
        source = 'hsv';
        confidence = 'low';
      }
    } catch (error) {
      attempts.push({ provider: 'hsv', status: 'failed', ms: Date.now() - t0, reason: error instanceof Error ? error.message : 'hsv failed' });
    }
  }

  return {
    source,
    provider,
    mask: candidate?.mask ?? null,
    score: candidate?.score ?? null,
    box: candidate?.box ?? null,
    confidence,
    model: candidate?.model ?? null,
    promptMode: candidate?.promptMode ?? null,
    outline: candidate ? traceOutline(candidate.pixels.data, candidate.pixels.width, candidate.pixels.height) : null,
    multipleRegions: candidate?.multipleRegions ?? null,
    frame,
    areaPx: candidate?.pixels.areaPx ?? null,
    totalPx: candidate?.pixels.totalPx ?? null,
    candidates: candidate?.candidates ?? 0,
    promptConflict: candidate?.promptConflict ?? false,
    secondOpinion: opinion,
    secondOpinionReason: opinionReason,
    latencyMs: Date.now() - started,
    attempts,
    reason,
  };
}

/**
 * One structured log line per segmentation — latency, scores, prompt counts and
 * outcome only. No image, no mask (spec §3.1).
 */
export function logSegmentation(
  outcome: SegmentationOutcome,
  context?: { assessmentId?: string | null; prompts?: SegmentPrompts | null; requestId?: string },
): void {
  console.log(
    '[segment]',
    JSON.stringify({
      at: new Date().toISOString(),
      requestId: context?.requestId ?? null,
      assessmentId: context?.assessmentId ?? null,
      source: outcome.source,
      model: outcome.model,
      promptMode: outcome.promptMode,
      confidence: outcome.confidence,
      score: outcome.score,
      candidates: outcome.candidates,
      promptConflict: outcome.promptConflict,
      points: context?.prompts?.points?.length ?? 0,
      box: Boolean(context?.prompts?.box),
      areaPct: outcome.areaPx && outcome.totalPx ? Number(((100 * outcome.areaPx) / outcome.totalPx).toFixed(2)) : null,
      secondOpinion: outcome.secondOpinion
        ? outcome.secondOpinion.status === 'ok'
          ? { iou: outcome.secondOpinion.agreementIoU, regions: outcome.secondOpinion.regions, meanProb: outcome.secondOpinion.meanProb, latencyMs: outcome.secondOpinion.latencyMs }
          : { status: 'unavailable', reason: outcome.secondOpinion.reason }
        : outcome.secondOpinionReason,
      latencyMs: outcome.latencyMs,
      attempts: outcome.attempts.map((a) => ({ provider: a.provider, status: a.status, ms: a.ms, reason: a.reason ?? null })),
      reason: outcome.reason ?? null,
    }),
  );
}

function summariseFailure(attempts: SegmentationAttempt[]): string {
  if (attempts.length === 0 || attempts.every((a) => a.status === 'skipped')) {
    return 'No segmentation model is configured — using the colour estimate.';
  }
  const tried = attempts
    .filter((a) => a.status !== 'skipped')
    .map((a) => `${a.provider}: ${a.reason ?? a.status}`)
    .join('; ');
  return `No model produced a usable boundary (${tried}) — using the colour estimate.`;
}
