import { COIN_DIAMETER_CM } from '../src/cv/measureArea';
import type { ScaleReference, WoundGeometry } from '../src/assessment/state';
import { chooseCoin, coinRadiusBounds, overlapsMask, parseCircles } from './_coin';
import { inRangeScalar } from './_hsvMask';
import { gainsFromPatch, looksLikePatch, type Gains } from './_whiteBalance';
import type { Cv, CvMat, CvMatVector } from './cv';

/**
 * The OpenCV half of measurement: find the coin, then size the approved outline.
 * The decisions (which circle is the coin) are in the import-free `_coin.ts`.
 *
 * Every pixel value here is in the ANALYSIS frame — the photo resized to 1024 px
 * on its longer edge, the same grid the tissue classifier uses — so px/cm from
 * the coin and px counts from the mask are directly comparable.
 */

/**
 * Find the reference coin in a grayscale frame.
 *
 * `woundMask` (one byte per pixel, same grid) excludes any circle touching the
 * wound; pass null when no outline exists yet. Returns null rather than a guess.
 */
export function detectCoin(cv: Cv, gray: CvMat, woundMask: Uint8Array | null): ScaleReference | null {
  const width = gray.cols;
  const height = gray.rows;
  const { minRadius, maxRadius } = coinRadiusBounds(width, height);

  const circles = new cv.Mat();
  const edges = new cv.Mat();
  try {
    cv.HoughCircles(gray, circles, cv.HOUGH_GRADIENT, 1.2, 40, 100, 30, minRadius, maxRadius);
    cv.Canny(gray, edges, 50, 150);
    const choice = chooseCoin(parseCircles(circles.data32F, circles.cols), {
      edges: edges.data,
      mask: woundMask,
      width,
      height,
    });
    if (!choice) return null;
    const { x, y, r } = choice.circle;
    return {
      kind: 'coin',
      xPct: x / width,
      yPct: y / height,
      rPct: r / width,
      support: Number(choice.support.toFixed(2)),
      pxPerCm: (2 * r) / COIN_DIAMETER_CM,
    };
  } finally {
    circles.delete();
    edges.delete();
  }
}

const round1 = (value: number) => Number(value.toFixed(1));

/**
 * Area, length, width and perimeter of a binary mask (build spec §4.2).
 *
 * Area counts every set pixel (satellite regions included — they were in the
 * approved outline). Length/width come from `minAreaRect` and perimeter from
 * `arcLength`, both on the LARGEST region, because a rectangle or perimeter
 * spanning two separate regions would describe the gap between them.
 */
export function measureMaskGeometry(cv: Cv, mask: CvMat, areaPx: number, pxPerCm: number | null): WoundGeometry {
  const work = mask.clone();
  const hierarchy = new cv.Mat();
  const contours: CvMatVector = new cv.MatVector();
  try {
    cv.findContours(work, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let largest = -1;
    let largestArea = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      const area = cv.contourArea(contours.get(i));
      if (area > largestArea) {
        largestArea = area;
        largest = i;
      }
    }

    const scale = pxPerCm && pxPerCm > 0 ? pxPerCm : null;
    if (largest < 0 || !scale) {
      return {
        areaPx,
        areaCm2: scale ? round1(areaPx / (scale * scale)) : null,
        lengthCm: null,
        widthCm: null,
        perimeterCm: null,
      };
    }

    const contour = contours.get(largest);
    const rect = cv.minAreaRect(contour);
    const longSide = Math.max(rect.size.width, rect.size.height);
    const shortSide = Math.min(rect.size.width, rect.size.height);
    const perimeterPx = cv.arcLength(contour, true);
    return {
      areaPx,
      areaCm2: round1(areaPx / (scale * scale)),
      lengthCm: round1(longSide / scale),
      widthCm: round1(shortSide / scale),
      perimeterCm: round1(perimeterPx / scale),
    };
  } finally {
    contours.delete();
    hierarchy.delete();
    work.delete();
  }
}

/** A white reference patch found in the photo, and the gains it implies. */
export type WhitePatch = {
  gains: Gains;
  /** Bounding box of the patch, fractional, for drawing it on the photo. */
  box: { xPct: number; yPct: number; wPct: number; hPct: number };
};

/**
 * Find a printed white reference patch (segmentation spec §5): a matte, bright,
 * low-saturation filled rectangle of card size, not touching the wound and not
 * the coin. Returns null — white balance skipped — when there is none.
 */
export function detectWhitePatch(
  cv: Cv,
  blurredRgb: CvMat,
  woundMask: Uint8Array,
  coin: ScaleReference | null,
): WhitePatch | null {
  const width = blurredRgb.cols;
  const height = blurredRgb.rows;
  const mats: CvMat[] = [];
  const t = <T extends CvMat>(m: T): T => {
    mats.push(m);
    return m;
  };
  const contours: CvMatVector = new cv.MatVector();
  try {
    const hsv = t(new cv.Mat());
    cv.cvtColor(blurredRgb, hsv, cv.COLOR_RGB2HSV);
    const white = t(new cv.Mat());
    // Saturation up to 90/255, not "near zero": under the very colour cast this
    // corrects, a white card reads distinctly tinted (a tungsten-lit card was
    // S ≈ 67). The shape test, not the colour, is what keeps skin out.
    inRangeScalar(cv, hsv, [0, 0, 170], [180, 90, 255], white);
    const kernel = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    cv.morphologyEx(white, white, cv.MORPH_OPEN, kernel);
    const hierarchy = t(new cv.Mat());
    cv.findContours(white, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      const rect = cv.minAreaRect(contour);
      const rectArea = rect.size.width * rect.size.height;
      if (rectArea <= 0) continue;
      const long = Math.max(rect.size.width, rect.size.height);
      const short = Math.max(1, Math.min(rect.size.width, rect.size.height));
      const shape = { areaFraction: area / (width * height), rectangularity: area / rectArea, aspect: long / short };
      if (!looksLikePatch(shape)) continue;
      // Not the wound, not the coin.
      const reach = long / 2;
      if (overlapsMask({ x: rect.center.x, y: rect.center.y, r: reach }, woundMask, width, height, 0)) continue;
      if (coin) {
        const cx = coin.xPct * width;
        const cy = coin.yPct * height;
        if (Math.hypot(rect.center.x - cx, rect.center.y - cy) < coin.rPct * width * 1.2 + reach) continue;
      }
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    }
    if (best < 0) return null;

    // Sample the patch's interior only: its edge blends into the background.
    const filled = t(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0)));
    cv.drawContours(filled, contours, best, new cv.Scalar(255, 255, 255, 255), -1, cv.LINE_8);
    const erodeKernel = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7)));
    cv.erode(filled, filled, erodeKernel);
    const gains = gainsFromPatch(blurredRgb.data, blurredRgb.channels(), filled.data);
    if (!gains) return null;

    // Axis-aligned box from the patch pixels themselves (minAreaRect's
    // width/height swap with its rotation convention, so they cannot be used).
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!filled.data[y * width + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return {
      gains: { r: Number(gains.r.toFixed(3)), g: Number(gains.g.toFixed(3)), b: Number(gains.b.toFixed(3)) },
      box: { xPct: x0 / width, yPct: y0 / height, wPct: (x1 - x0 + 1) / width, hPct: (y1 - y0 + 1) / height },
    };
  } finally {
    contours.delete();
    mats.forEach((m) => m.delete());
  }
}
