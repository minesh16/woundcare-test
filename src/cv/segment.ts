import { ASSESSMENT_V2 } from '@/config/featureFlags';
import { uriToBase64 } from '@/cv/opencvPipeline';
import type { SegmentationProviderName, SegmentPromptMode } from '@/assessment/state';
import type { ImagePoint } from '@/decision/types';

/**
 * Client helper for the additive wound-boundary pass (assessmentV2).
 *
 * The server picks the backend — FUSegNet on Modal, then SAM 3 on fal.ai, then
 * SAM 2 on Replicate (`SEGMENTATION_PROVIDERS`). The client deliberately does
 * not choose and does not need rebuilding when the order changes: all it sends
 * is the image and the HSV centroid, and all it reads back is a mask plus which
 * provider produced it. That is the web/native parity rule from the build spec
 * (§2.4) — every heavy decision is server-side, so Expo-native and Expo-web
 * behave identically.
 *
 * Only runs when the `assessmentV2` flag is enabled; otherwise returns null so
 * the existing HSV analyze flow is the sole source of the wound mask. Any
 * failure resolves to null (conservative by default) — the demo never breaks.
 */

export type MaskSelection = {
  index: number;
  maskUrl: string;
  areaPx: number;
  totalPx: number;
};

/** One provider's attempt, in the order they were tried. */
export type SegmentAttempt = {
  provider: SegmentationProviderName;
  status: 'ok' | 'skipped' | 'failed' | 'implausible';
  ms: number;
  reason?: string;
};

export type SegmentResult = {
  /** The provider that produced `mask`, or 'unavailable' when none did. */
  source: SegmentationProviderName | 'unavailable';
  provider: SegmentationProviderName | null;
  /** Whether the boundary came from a wound-only model, a concept prompt, or an automatic pass. */
  promptMode: SegmentPromptMode | null;
  /** The wound mask uri. */
  mask: string | null;
  /** SAM 2's union-of-everything mask; null for the other providers. */
  combinedMask: string | null;
  /** Every mask the winning provider returned (one, for FUSegNet). */
  masks: string[];
  /** Which mask was chosen as the wound, when a choice was made. */
  selection: MaskSelection | null;
  /** Per-mask confidence when the provider reports it (SAM 3 does). */
  scores: number[] | null;
  confidence: 'high' | 'medium' | 'low';
  attempts: SegmentAttempt[];
  point?: ImagePoint;
  model?: string;
  reason?: string;
};

const SEGMENT_URL = process.env.EXPO_PUBLIC_SEGMENT_URL ?? '/api/segment';

export async function segmentWoundBase64(
  base64: string,
  point?: ImagePoint | null,
): Promise<SegmentResult | null> {
  if (!ASSESSMENT_V2) {
    return null;
  }

  try {
    const response = await fetch(SEGMENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, point: point ?? undefined }),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as SegmentResult;
  } catch (error) {
    console.warn('Boundary segment request failed; using HSV mask.', error);
    return null;
  }
}

/**
 * Convenience: segment straight from an image URI. The centroid is sent as the
 * prompt/selection seed — what the server does with it depends on the backend
 * that answers (see `api/segment.ts`).
 */
export async function segmentWoundUri(
  uri: string,
  point?: ImagePoint | null,
): Promise<SegmentResult | null> {
  if (!ASSESSMENT_V2) {
    return null;
  }
  const base64 = await uriToBase64(uri);
  return segmentWoundBase64(base64, point);
}
