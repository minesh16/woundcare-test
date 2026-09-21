import { PNG } from 'pngjs';

import type { ImagePoint } from './_sam2';

/**
 * Wound-mask selection for the `meta/sam-2` automatic mask generator.
 *
 * `meta/sam-2` returns every object it finds (`individual_masks`) with no
 * prompt input, so we can't ask it for "the wound" directly. Instead we reuse
 * the HSV wound centroid to SELECT the right mask: keep only masks whose pixel
 * at the centroid is set, then pick the SMALLEST by area — this discards the
 * whole-image / large-skin masks that also contain the centroid and keeps the
 * tight wound boundary. Conservative by default: any decode/fetch failure is
 * skipped, and if nothing matches we return null so the caller falls back.
 */

export type MaskSelection = {
  index: number;
  maskUrl: string;
  areaPx: number;
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

async function decodeMask(url: string): Promise<PNG | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return PNG.sync.read(buffer);
  } catch {
    return null;
  }
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

    const areaPx = countSetPixels(png.data, png.width * png.height);
    if (areaPx === 0) continue;

    // Smallest containing mask wins (tight wound vs whole-image blob).
    if (!best || areaPx < best.areaPx) {
      best = { index, maskUrl: url, areaPx };
    }
  }

  return best;
}
