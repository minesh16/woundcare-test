import { classifyPeriwoundPixel } from '../src/cv/tissueClassifier';
import type { Periwound } from '../src/decision/types';
import type { Cv, CvMat } from './cv';

/**
 * Mask and periwound operations shared by the legacy `/api/analyze` pipeline
 * and the V2 `/api/v1/assessments/tissue` endpoint, so both measure the same
 * things the same way.
 */

/** Mölnlycke step 5 assesses the skin within 4 cm of the wound edge. */
export const PERIWOUND_BAND_CM = 4;
/** Cap the dilation kernel so a very large px/cm can't blow up the morphology op. */
const MAX_PERIWOUND_KERNEL = 151;
/** Share of the band that must read as waterlogged before we call it maceration. */
const MACERATION_THRESHOLD_PCT = 15;

/** Count set pixels in a single-channel mask buffer. */
export function countMaskPixels(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== 0) n += 1;
  }
  return n;
}

/**
 * Periwound band = (wound mask dilated by 4 cm) minus the wound mask itself.
 * Reports redness and maceration in that ring. Requires a calibrated scale:
 * without `pxPerCm` a 4 cm radius cannot be expressed in pixels, so we return
 * `null` with a reason instead of inventing one (conservative by default).
 */
export function measurePeriwound(
  cv: Cv,
  rgb: CvMat,
  woundMask: CvMat,
  pxPerCm: number | null,
): Periwound | null {
  if (!pxPerCm || pxPerCm <= 0) {
    return null;
  }

  const radiusPx = Math.round(PERIWOUND_BAND_CM * pxPerCm);
  if (radiusPx < 1) {
    return null;
  }

  const kernelSize = Math.min(2 * radiusPx + 1, MAX_PERIWOUND_KERNEL);
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize, kernelSize));
  const dilated = new cv.Mat();
  const ring = new cv.Mat();

  try {
    cv.dilate(woundMask, dilated, kernel);
    cv.subtract(dilated, woundMask, ring);

    const band = ring.data;
    const pixels = rgb.data;
    const channels = rgb.channels();

    let considered = 0;
    let red = 0;
    let macerated = 0;

    for (let i = 0; i < band.length; i += 1) {
      if (band[i] === 0) continue;
      const o = i * channels;
      const label = classifyPeriwoundPixel(pixels[o], pixels[o + 1], pixels[o + 2]);
      considered += 1;
      if (label === 'red') red += 1;
      else if (label === 'macerated') macerated += 1;
    }

    if (considered === 0) {
      return null;
    }

    const rednessPct = Math.round((red / considered) * 100);
    const macerationPct = Math.round((macerated / considered) * 100);

    return {
      rednessPct,
      macerationPct,
      maceration: macerationPct >= MACERATION_THRESHOLD_PCT,
      bandPx: considered,
      bandCm: PERIWOUND_BAND_CM,
    };
  } finally {
    kernel.delete();
    dilated.delete();
    ring.delete();
  }
}

