/**
 * The segmentation facade: one call that produces a wound boundary, from
 * whichever backend is configured and working.
 *
 * Two backends, tried in order (`SEGMENTATION_PROVIDERS`, default sam3 → fusegnet):
 *
 *  | provider  | host   | prompt            | returns              |
 *  |-----------|--------|-------------------|----------------------|
 *  | sam3      | fal.ai | concept "wound"   | every match + scores |
 *  | fusegnet  | Modal  | none (wound-only) | one binary mask      |
 *
 * SAM 2 on Replicate used to be a third provider. It has been removed: as the
 * automatic mask generator it took no prompt, segmented everything in frame, and
 * the wound had to be guessed back out of the result — it did not work well
 * enough to be worth keeping even as a fallback. Below these two the fallback is
 * the on-device HSV mask, as it always was.
 *
 * Why a chain rather than one provider: the build spec requires web/native
 * parity and conservative degradation (§2.4, §2.5). A GPU endpoint cold-starting,
 * rate-limiting or being redeployed is routine, and the assessment must still
 * produce a boundary — the next provider, and finally the on-device HSV mask.
 * Every attempt is recorded in `attempts` and lands in the audit log, so "which
 * model drew this boundary" is answerable after the fact rather than inferred.
 *
 * The cage is unchanged by any of this: both produce a BOUNDARY only. Tissue
 * composition is measured by OpenCV HSI inside the mask; the dressing pathway
 * comes from the deterministic engine.
 */

import { isFusegnetConfigured, runFusegnet } from './_fusegnet';
import { traceOutline, type MaskPoint } from './_maskGeometry';
import { loadMaskPixels, selectWoundMask, type MaskSelection } from './_maskSelect';
import { isSam3Configured, runSam3 } from './_sam3';
import {
  confidenceFromScore,
  describePlausibility,
  highestScoreIndex,
  maskPlausibility,
  parseProviderOrder,
  type ImagePoint,
  type MaskConfidence,
  type SegmentationProvider,
} from './_segmentationParse';

export type { ImagePoint, MaskConfidence, SegmentationProvider } from './_segmentationParse';
export type { MaskSelection } from './_maskSelect';
export type { MaskPoint, BoundaryApproval } from './_maskGeometry';

/**
 * How the boundary was obtained — recorded because it is the single most
 * informative thing about how much the mask can be trusted:
 *  - `concept`: a generalist told to find "wound"
 *  - `wound-specific`: a wound-only model, nothing to disambiguate
 */
export type PromptMode = 'concept' | 'wound-specific';

export type AttemptStatus = 'ok' | 'skipped' | 'failed' | 'implausible';

export type SegmentationAttempt = {
  provider: SegmentationProvider;
  status: AttemptStatus;
  ms: number;
  reason?: string;
};

export type SegmentationOutcome = {
  /** Which backend produced `mask`, or null when none did. */
  provider: SegmentationProvider | null;
  /** The wound mask (http url or data uri). */
  mask: string | null;
  /** All masks the winning provider returned (one, for FUSegNet). */
  masks: string[];
  /** Which of `masks` was chosen as the wound, when a choice was made. */
  selection: MaskSelection | null;
  /** Per-mask scores, when the provider reports them (SAM 3 does). */
  scores: number[] | null;
  /**
   * The provider saw more than one disconnected region — satellite lesions, two
   * wounds in one frame, or a boundary that broke up. Recorded, not acted on:
   * acting on it is a clinical judgement that belongs to the engine.
   * Null when the provider does not report it.
   */
  multipleRegions: boolean | null;
  /**
   * The chosen mask's boundary as an editable fractional polygon.
   *
   * This is what makes the review screen possible: the clinician adjusts THIS,
   * rather than being handed an opaque PNG and a yes/no. Null when the mask could
   * not be traced, in which case the review screen offers "draw" instead of
   * "adjust" — there is nothing honest to pre-fill the editor with.
   */
  outline: MaskPoint[] | null;
  confidence: MaskConfidence;
  model: string | null;
  promptMode: PromptMode | null;
  /** Every provider tried, in order, with why it was skipped or failed. */
  attempts: SegmentationAttempt[];
  /** Why there is no mask, when there is no mask. */
  reason?: string;
};

type Candidate = {
  mask: string;
  masks: string[];
  selection: MaskSelection | null;
  scores: number[] | null;
  multipleRegions: boolean | null;
  outline: MaskPoint[] | null;
  confidence: MaskConfidence;
  model: string;
  promptMode: PromptMode;
};

/** Providers in the configured order, annotated with whether they can run. */
export function providerStatus(): { provider: SegmentationProvider; configured: boolean }[] {
  return parseProviderOrder(process.env.SEGMENTATION_PROVIDERS).map((provider) => ({
    provider,
    configured: isProviderConfigured(provider),
  }));
}

export function isProviderConfigured(provider: SegmentationProvider): boolean {
  switch (provider) {
    case 'sam3':
      return isSam3Configured();
    case 'fusegnet':
      return isFusegnetConfigured();
  }
}

/** True when at least one provider in the configured order can run. */
export function isSegmentationConfigured(): boolean {
  return providerStatus().some((p) => p.configured);
}

const MISSING_ENV: Record<SegmentationProvider, string> = {
  sam3: 'FAL_KEY',
  fusegnet: 'FUSEGNET_MODAL_URL',
};

/**
 * FUSegNet confidence. A plausible mask from a wound-only model with no
 * selection ambiguity is the strong case, so a missing score does NOT downgrade
 * it the way it does for a generalist — the only downgrade signal is the model's
 * own low score. (Compare `confidenceFromScore`, which treats a missing score as
 * medium because there a mask could be of anything.)
 */
function fusegnetConfidence(score: number | null): MaskConfidence {
  if (typeof score === 'number' && Number.isFinite(score) && score < 0.5) return 'medium';
  return 'high';
}

/** A mask that came back but cannot be a wound. Distinguished so the audit trail can say so. */
class ImplausibleMask extends Error {}

async function tryFusegnet(imageDataUrl: string): Promise<Candidate> {
  const result = await runFusegnet({ imageDataUrl });
  const mask = result.mask;

  // Measure it before trusting it: a mask covering the whole frame or two
  // pixels is a failure the tissue classifier cannot detect on its own. The same
  // decode also yields the outline the review screen edits.
  const pixels = await loadMaskPixels(mask);
  if (!pixels) {
    throw new Error('FUSegNet returned a mask that could not be decoded.');
  }
  const verdict = maskPlausibility(pixels.areaPx, pixels.totalPx);
  if (verdict !== 'plausible') {
    throw new ImplausibleMask(`FUSegNet: ${describePlausibility(verdict)}.`);
  }

  return {
    mask,
    masks: [mask],
    selection: { index: 0, maskUrl: mask, areaPx: pixels.areaPx, totalPx: pixels.totalPx },
    scores: typeof result.score === 'number' ? [result.score] : null,
    multipleRegions: result.multipleRegions,
    outline: traceOutline(pixels.data, pixels.width, pixels.height),
    confidence: fusegnetConfidence(result.score),
    model: result.model,
    promptMode: 'wound-specific',
  };
}

async function trySam3(imageDataUrl: string, point: ImagePoint | null): Promise<Candidate> {
  const result = await runSam3({ imageDataUrl, point });

  // One match is the common case for a single wound: take it, and check its size.
  if (result.masks.length === 1) {
    const mask = result.masks[0];
    const pixels = await loadMaskPixels(mask);
    if (!pixels) throw new Error('SAM 3 returned a mask that could not be decoded.');
    const verdict = maskPlausibility(pixels.areaPx, pixels.totalPx);
    if (verdict !== 'plausible') {
      throw new ImplausibleMask(`SAM 3: ${describePlausibility(verdict)}.`);
    }
    return {
      mask,
      masks: result.masks,
      selection: { index: 0, maskUrl: mask, areaPx: pixels.areaPx, totalPx: pixels.totalPx },
      scores: result.scores,
      // One match from a concept prompt is, by definition, one region.
      multipleRegions: false,
      outline: traceOutline(pixels.data, pixels.width, pixels.height),
      confidence: confidenceFromScore(result.scores?.[0] ?? null),
      model: result.model,
      promptMode: 'concept',
    };
  }

  // Several instances of "wound". The HSV centroid disambiguates — and when it
  // does, that is two independent signals agreeing on the same region, which is
  // a stronger result than either alone. Without a centroid, fall back to fal's
  // own top-scoring mask at medium confidence: nothing has corroborated it.
  const selection = point ? await selectWoundMask(result.masks, point) : null;
  const fallbackIndex = highestScoreIndex(result.scores) ?? 0;
  const index = selection?.index ?? fallbackIndex;
  const mask = result.masks[index];
  if (!mask) throw new Error('SAM 3 returned no usable mask.');

  // One decode of the chosen mask serves the plausibility check and the outline.
  const pixels = await loadMaskPixels(mask);
  if (pixels) {
    const verdict = maskPlausibility(pixels.areaPx, pixels.totalPx);
    if (verdict !== 'plausible') {
      throw new ImplausibleMask(`SAM 3: ${describePlausibility(verdict)}.`);
    }
  }

  return {
    mask,
    masks: result.masks,
    selection: selection ?? null,
    scores: result.scores,
    // SAM 3 matched the concept more than once in this frame.
    multipleRegions: result.masks.length > 1,
    outline: pixels ? traceOutline(pixels.data, pixels.width, pixels.height) : null,
    confidence: selection ? 'high' : 'medium',
    model: result.model,
    promptMode: 'concept',
  };
}

/**
 * Run the provider chain. Never throws: the worst outcome is
 * `{ provider: null, mask: null }`, which every caller already handles by
 * falling back to the on-device HSV boundary.
 */
export async function runSegmentation(args: {
  imageDataUrl: string;
  point?: ImagePoint | null;
}): Promise<SegmentationOutcome> {
  const point = args.point ?? null;
  const attempts: SegmentationAttempt[] = [];
  const order = parseProviderOrder(process.env.SEGMENTATION_PROVIDERS);

  for (const provider of order) {
    if (!isProviderConfigured(provider)) {
      attempts.push({
        provider,
        status: 'skipped',
        ms: 0,
        reason: `not configured (${MISSING_ENV[provider]} unset)`,
      });
      continue;
    }

    const started = Date.now();
    try {
      const candidate =
        provider === 'sam3'
          ? await trySam3(args.imageDataUrl, point)
          : await tryFusegnet(args.imageDataUrl);

      attempts.push({ provider, status: 'ok', ms: Date.now() - started });
      return { provider, attempts, ...candidate };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'segmentation failed';
      attempts.push({
        provider,
        status: error instanceof ImplausibleMask ? 'implausible' : 'failed',
        ms: Date.now() - started,
        reason,
      });
      // Conservative by default: try the next provider rather than returning a
      // boundary we have just decided not to trust.
      console.warn(`Segmentation provider ${provider} did not produce a usable mask: ${reason}`);
    }
  }

  return {
    provider: null,
    mask: null,
    masks: [],
    selection: null,
    scores: null,
    multipleRegions: null,
    outline: null,
    confidence: 'low',
    model: null,
    promptMode: null,
    attempts,
    reason: summariseFailure(attempts),
  };
}

/**
 * Log which model drew the boundary, as one structured line.
 *
 * `/api/segment` is the endpoint the APP actually calls, and it persists nothing:
 * `writeAudit` is only reached from `evaluate`/`run`, which only the compare
 * screen uses. So without this, every real assessment a clinician does through
 * the app leaves no record of which model produced the boundary the tissue
 * percentages were measured inside — the one fact the audit trail most needs.
 *
 * Deliberately stdout rather than a database row: Vercel retains function logs,
 * `writeAudit` already uses the same fallback, and a boundary call is not an
 * assessment — writing an `audit_log` row per segment would put rows in there
 * that no clinical decision corresponds to. The real fix is for the app to go
 * through `run`, which audits properly; this makes the gap observable until then.
 *
 * De-identified by construction: no image, no mask data, no free text from a
 * provider beyond its own failure reason.
 */
export function logSegmentation(outcome: SegmentationOutcome, context?: { assessmentId?: string | null }): void {
  console.log(
    '[segment]',
    JSON.stringify({
      at: new Date().toISOString(),
      assessmentId: context?.assessmentId ?? null,
      provider: outcome.provider,
      model: outcome.model,
      promptMode: outcome.promptMode,
      confidence: outcome.confidence,
      maskFound: Boolean(outcome.mask),
      areaPx: outcome.selection?.areaPx ?? null,
      framePx: outcome.selection?.totalPx ?? null,
      areaPct: outcome.selection ? Number(((100 * outcome.selection.areaPx) / outcome.selection.totalPx).toFixed(2)) : null,
      scores: outcome.scores,
      multipleRegions: outcome.multipleRegions,
      outlinePoints: outcome.outline?.length ?? null,
      // The whole chain, so a silent degradation is visible in the logs rather
      // than only in a response nobody kept.
      attempts: outcome.attempts.map((a) => ({ provider: a.provider, status: a.status, ms: a.ms, reason: a.reason ?? null })),
      reason: outcome.reason ?? null,
    }),
  );
}

function summariseFailure(attempts: SegmentationAttempt[]): string {
  if (attempts.length === 0) return 'No segmentation provider is configured.';
  if (attempts.every((a) => a.status === 'skipped')) {
    return `No segmentation provider is configured (${attempts.map((a) => a.provider).join(', ')}).`;
  }
  const tried = attempts
    .filter((a) => a.status !== 'skipped')
    .map((a) => `${a.provider}: ${a.reason ?? a.status}`)
    .join('; ');
  return `No usable wound boundary — ${tried}`;
}
