import { PNG } from 'pngjs';

import type { ImagePoint } from './_segmentationParse';

/**
 * Wound-mask selection and mask measurement, for the backends that return more
 * than one mask.
 *
 * `meta/sam-2` (Replicate) returns every object it finds with no prompt input,
 * and SAM 3 with the concept prompt "wound" returns every instance it matches,
 * so neither can be asked for "the wound" and handed back exactly one mask.
 * Instead we reuse the HSV wound centroid to SELECT the right one: keep only
 * masks whose pixel at the centroid is set, then pick the SMALLEST by area —
 * this discards the whole-image / large-skin masks that also contain the
 * centroid and keeps the tight wound boundary. Conservative by default: any
 * decode/fetch failure is skipped, and if nothing matches we return null so the
 * caller falls back.
 *
 * FUSegNet needs none of this: it returns one wound mask because wounds are the
 * only thing it can segment. `maskStats` is still used on its output, to check
 * the mask is a plausible size before anything is measured inside it.
 */

export type MaskSelection = {
  index: number;
  maskUrl: string;
  areaPx: number;
  /** Pixels in the whole mask image — the denominator for the plausibility check. */
  totalPx: number;
};

/** Max masks to fetch+decode per request (bounds latency/memory on busy scenes). */
const DEFAULT_MAX_MASKS = 48;

function isSet(data: Buffer, idx: number): boolean {
  // pngjs normalises to RGBA. A binary mask is white-on-black (opaque) or an
  // alpha cutout; treat a pixel as "in the mask" when it is opaque and bright.
  const alpha = data[idx + 3];
  if (alpha <= 127) return false;
  const luma = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
  return luma > 127;
}

function countSetPixels(data: Buffer, pixelCount: number): number {
  let area = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    if (isSet(data, i * 4)) area += 1;
  }
  return area;
}

/**
 * Decode a mask from an http(s) url or a data uri.
 *
 * Data uris are decoded directly rather than passed to `fetch`. `fetch` does
 * accept them, but a mask arriving inline is the common case for the Modal
 * endpoint (a Python handler returning base64 PNG), and routing it through the
 * HTTP stack to get bytes we already hold adds a dependency on `data:` support
 * for no benefit. `api/v1/assessments/tissue.ts` does the same.
 */
async function decodeMask(url: string): Promise<PNG | null> {
  try {
    let buffer: Buffer;
    if (url.startsWith('data:')) {
      buffer = Buffer.from(url.replace(/^data:[^;,]*;base64,/, ''), 'base64');
    } else {
      const response = await fetch(url);
      if (!response.ok) return null;
      buffer = Buffer.from(await response.arrayBuffer());
    }
    return PNG.sync.read(buffer);
  } catch {
    return null;
  }
}

export type MaskStats = {
  /** Pixels inside the mask. */
  areaPx: number;
  /** Pixels in the whole mask image — the denominator for a plausibility check. */
  totalPx: number;
  width: number;
  height: number;
};

/**
 * Decode a single mask and measure it. Used on the single-mask backends
 * (FUSegNet, or SAM 3 when it matched exactly one instance) where there is
 * nothing to select between but the size still has to be sanity-checked before
 * the tissue classifier treats everything inside it as wound bed.
 *
 * Returns null when the mask cannot be fetched or decoded — the caller then
 * degrades to the next provider rather than measuring inside a mask it could
 * not read.
 */
export async function maskStats(url: string): Promise<MaskStats | null> {
  const png = await decodeMask(url);
  if (!png) return null;
  const totalPx = png.width * png.height;
  return {
    areaPx: countSetPixels(png.data, totalPx),
    totalPx,
    width: png.width,
    height: png.height,
  };
}

/**
 * Return the smallest mask whose centroid pixel is set, or null if none match.
 * `point` is fractional (0–1) so it maps to any mask resolution.
 */
export async function selectWoundMask(
  masks: string[],
  point: ImagePoint,
  maxMasks: number = DEFAULT_MAX_MASKS,
): Promise<MaskSelection | null> {
  const candidates = masks.slice(0, Math.max(0, maxMasks));

  const decoded = await Promise.all(
    candidates.map(async (url, index) => ({ index, url, png: await decodeMask(url) })),
  );

  let best: MaskSelection | null = null;

  for (const { index, url, png } of decoded) {
    if (!png) continue;

    const px = Math.min(png.width - 1, Math.max(0, Math.round(point.xPct * png.width)));
    const py = Math.min(png.height - 1, Math.max(0, Math.round(point.yPct * png.height)));
    const centroidIdx = (py * png.width + px) * 4;

    if (!isSet(png.data, centroidIdx)) continue;

    const totalPx = png.width * png.height;
    const areaPx = countSetPixels(png.data, totalPx);
    if (areaPx === 0) continue;

    // Smallest containing mask wins (tight wound vs whole-image blob).
    if (!best || areaPx < best.areaPx) {
      best = { index, maskUrl: url, areaPx, totalPx };
    }
  }

  return best;
}
