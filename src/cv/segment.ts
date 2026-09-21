import { ASSESSMENT_V2 } from '@/config/featureFlags';
import { uriToBase64 } from '@/cv/opencvPipeline';
import type { ImagePoint } from '@/decision/types';

/**
 * Client helper for the additive SAM 2 boundary pass (assessmentV2).
 *
 * Only runs when the `assessmentV2` flag is enabled; otherwise returns null so
 * the existing HSV analyze flow is the sole source of the wound mask. Any
 * failure resolves to null (conservative by default) — the demo never breaks.
 */

export type MaskSelection = {
  index: number;
  maskUrl: string;
  areaPx: number;
};

export type SegmentResult = {
  source: 'sam2' | 'unavailable';
  /** Wound-specific mask uri when centroid selection succeeds, else the combined mask. */
  mask: string | null;
  /** Union of all detected masks (uri). */
  combinedMask: string | null;
  /** Per-object mask uris returned by SAM 2 (meta/sam-2 auto mask generator). */
  masks: string[];
  /** Which individual mask was chosen as the wound, or null if none/HSV fallback. */
  selection: MaskSelection | null;
  confidence: 'high' | 'medium' | 'low';
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
    console.warn('SAM 2 segment request failed; using HSV mask.', error);
    return null;
  }
}

/** Convenience: segment straight from an image URI (seeds SAM 2 with the HSV centroid). */
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
