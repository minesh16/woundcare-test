/**
 * The segmentation facade: one call that produces a wound boundary, from
 * whichever backend is configured and working.
 *
 * Three backends, tried in order (`SEGMENTATION_PROVIDERS`, default
 * fusegnet → sam3 → sam2):
 *
 *  | provider  | host      | prompt            | returns              |
 *  |-----------|-----------|-------------------|----------------------|
 *  | fusegnet  | Modal     | none (wound-only) | one binary mask      |
 *  | sam3      | fal.ai    | concept "wound"   | every match + scores |
 *  | sam2      | Replicate | none (automatic)  | everything in frame  |
 *
 * Why a chain rather than one provider: the build spec requires web/native
 * parity and conservative degradation (§2.4, §2.5). A GPU endpoint cold-starting,
 * rate-limiting or being redeployed is routine, and the assessment must still
 * produce a boundary — the next provider, and finally the on-device HSV mask.
 * Every attempt is recorded in `attempts` and lands in the audit log, so "which
 * model drew this boundary" is answerable after the fact rather than inferred.
 *
 * The cage is unchanged by any of this: all three produce a BOUNDARY only.
 * Tissue composition is measured by OpenCV HSI inside the mask; the dressing
 * pathway comes from the deterministic engine.
 */

import { isFusegnetConfigured, runFusegnet } from './_fusegnet';
import { maskStats, selectWoundMask, type MaskSelection } from './_maskSelect';
import { isSam2Configured, runSam2Segmentation } from './_sam2';
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

/**
 * How the boundary was obtained — recorded because it is the single most
 * informative thing about how much the mask can be trusted:
 *  - `wound-specific`: a wound-only model, nothing to disambiguate
 *  - `concept`: a generalist told to find "wound"
 *  - `automatic`: a generalist told nothing, with the wound picked out afterwards
 */
export type PromptMode = 'wound-specific' | 'concept' | 'automatic';

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
  /** SAM 2's union-of-everything mask. Null for the other providers — they do not produce one. */
  combinedMask: string | null;
  /** Which of `masks` was chosen as the wound, when a choice was made. */
  selection: MaskSelection | null;
  /** Per-mask scores, when the provider reports them (SAM 3 does). */
  scores: number[] | null;
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
  combinedMask: string | null;
  selection: MaskSelection | null;
  scores: number[] | null;
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
    case 'fusegnet':
      return isFusegnetConfigured();
    case 'sam3':
      return isSam3Configured();
    case 'sam2':
      return isSam2Configured();
  }
}

/** True when at least one provider in the configured order can run. */
export function isSegmentationConfigured(): boolean {
  return providerStatus().some((p) => p.configured);
}

const MISSING_ENV: Record<SegmentationProvider, string> = {
  fusegnet: 'FUSEGNET_MODAL_URL',
  sam3: 'FAL_KEY',
  sam2: 'REPLICATE_API_TOKEN',
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
  // pixels is a failure the tissue classifier cannot detect on its own.
  const stats = await maskStats(mask);
  if (!stats) {
    throw new Error('FUSegNet returned a mask that could not be decoded.');
  }
  const verdict = maskPlausibility(stats.areaPx, stats.totalPx);
  if (verdict !== 'plausible') {
    throw new ImplausibleMask(`FUSegNet: ${describePlausibility(verdict)}.`);
  }

  return {
    mask,
    masks: [mask],
    combinedMask: null,
    selection: { index: 0, maskUrl: mask, areaPx: stats.areaPx, totalPx: stats.totalPx },
    scores: typeof result.score === 'number' ? [result.score] : null,
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
    const stats = await maskStats(mask);
    if (!stats) throw new Error('SAM 3 returned a mask that could not be decoded.');
    const verdict = maskPlausibility(stats.areaPx, stats.totalPx);
    if (verdict !== 'plausible') {
      throw new ImplausibleMask(`SAM 3: ${describePlausibility(verdict)}.`);
    }
    return {
      mask,
      masks: result.masks,
      combinedMask: null,
      selection: { index: 0, maskUrl: mask, areaPx: stats.areaPx, totalPx: stats.totalPx },
      scores: result.scores,
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

  const stats = selection ?? (await maskStats(mask));
  if (stats) {
    const verdict = maskPlausibility(stats.areaPx, stats.totalPx);
    if (verdict !== 'plausible') {
      throw new ImplausibleMask(`SAM 3: ${describePlausibility(verdict)}.`);
    }
  }

  return {
    mask,
    masks: result.masks,
    combinedMask: null,
    selection: selection ?? null,
    scores: result.scores,
    confidence: selection ? 'high' : 'medium',
    model: result.model,
    promptMode: 'concept',
  };
}

async function trySam2(imageDataUrl: string, point: ImagePoint | null): Promise<Candidate> {
  const result = await runSam2Segmentation({ imageDataUrl });
  const selection =
    point && result.individualMasks.length > 0 ? await selectWoundMask(result.individualMasks, point) : null;

  // The plausibility gate applies to a SELECTED mask only. SAM 2's combined mask
  // is the union of every object in the frame, so it would always read as
  // "too large" — rejecting it would remove the legacy fallback entirely rather
  // than improve it. It is already reported at a lower confidence.
  if (selection) {
    const verdict = maskPlausibility(selection.areaPx, selection.totalPx);
    if (verdict !== 'plausible') {
      throw new ImplausibleMask(`SAM 2: ${describePlausibility(verdict)}.`);
    }
  }

  const mask = selection?.maskUrl ?? result.combinedMask;
  if (!mask) throw new Error('SAM 2 returned no masks.');

  return {
    mask,
    masks: result.individualMasks,
    combinedMask: result.combinedMask,
    selection,
    scores: null,
    confidence: selection ? 'high' : result.confidence,
    model: result.model,
    promptMode: 'automatic',
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
        provider === 'fusegnet'
          ? await tryFusegnet(args.imageDataUrl)
          : provider === 'sam3'
            ? await trySam3(args.imageDataUrl, point)
            : await trySam2(args.imageDataUrl, point);

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
    combinedMask: null,
    selection: null,
    scores: null,
    confidence: 'low',
    model: null,
    promptMode: null,
    attempts,
    reason: summariseFailure(attempts),
  };
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
