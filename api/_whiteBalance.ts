/**
 * White balance from a printed white reference patch (segmentation spec §5).
 *
 * Import-free so `test:measure` can run the warm-light acceptance test offline.
 * Detection (OpenCV) is in `_measure.ts`; the arithmetic is here.
 *
 * Why a white patch and not the coin: a coin's highlights are specular — they
 * reflect the light source, not a neutral surface — so they are not a reliable
 * grey reference. A matte white card is. With no patch in frame, white balance
 * is skipped, the `no_marker` flag is raised and tissue confidence is capped at
 * medium (spec §5).
 */

export type Gains = { r: number; g: number; b: number };

/** Gains are clamped: a correction bigger than this is a wrong patch, not a colour cast. */
export const GAIN_MIN = 0.6;
export const GAIN_MAX = 1.6;

/** Minimum usable patch pixels after excluding clipped highlights. */
export const MIN_PATCH_PX = 50;

/** A "white" patch darker than this on average is not a white patch. */
const MIN_PATCH_MEAN = 60;

/**
 * Per-channel gains that make the patch neutral grey at its own brightness.
 * Clipped pixels (any channel ≥ 250) are excluded: a clipped channel has lost
 * the colour information the gain is computed from. Null when the patch is too
 * small, too dark, or would need an implausible correction.
 */
export function gainsFromPatch(rgb: ArrayLike<number>, channels: number, patchMask: ArrayLike<number>): Gains | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const pixels = Math.floor(rgb.length / channels);
  for (let i = 0; i < pixels; i += 1) {
    if (!patchMask[i]) continue;
    const o = i * channels;
    const pr = rgb[o];
    const pg = rgb[o + 1];
    const pb = rgb[o + 2];
    if (pr >= 250 || pg >= 250 || pb >= 250) continue;
    r += pr;
    g += pg;
    b += pb;
    n += 1;
  }
  if (n < MIN_PATCH_PX) return null;
  r /= n;
  g /= n;
  b /= n;
  if (Math.min(r, g, b) < MIN_PATCH_MEAN) return null;
  const grey = (r + g + b) / 3;
  const gains = { r: grey / r, g: grey / g, b: grey / b };
  if ([gains.r, gains.g, gains.b].some((k) => k < GAIN_MIN || k > GAIN_MAX)) return null;
  return gains;
}

/** A new buffer with the gains applied (channels beyond RGB copied unchanged). */
export function applyGains(rgb: Uint8Array, channels: number, gains: Gains): Uint8Array {
  const out = new Uint8Array(rgb.length);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let o = 0; o < rgb.length; o += channels) {
    out[o] = clamp(rgb[o] * gains.r);
    out[o + 1] = clamp(rgb[o + 1] * gains.g);
    out[o + 2] = clamp(rgb[o + 2] * gains.b);
    for (let c = 3; c < channels; c += 1) out[o + c] = rgb[o + c];
  }
  return out;
}

/**
 * Shape test for a candidate patch: a printed card is a filled rectangle of
 * modest size. Highlights on skin, a white sheet filling the background, or a
 * thin strip of bandage edge all fail one of these.
 */
export function looksLikePatch(c: {
  /** Contour area / frame area. */
  areaFraction: number;
  /** Contour area / its minimum-area rectangle's area. */
  rectangularity: number;
  /** Long side / short side of that rectangle. */
  aspect: number;
}): boolean {
  return c.areaFraction >= 0.002 && c.areaFraction <= 0.15 && c.rectangularity >= 0.8 && c.aspect <= 2.5;
}
