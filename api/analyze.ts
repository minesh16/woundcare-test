import jpeg from 'jpeg-js';

import { breakdownFromBuffer, toPercentages } from '../src/cv/tissueClassifier';
import { CvResult, ImagePoint, Periwound } from '../src/decision/types';
import { analyzeInput } from './_contracts';
import { endpoint } from './_http';
import { buildHsvMask } from './_hsvMask';
import { stripDataUri } from './_image';
import { detectCoin } from './_measure';
import { countMaskPixels, measurePeriwound } from './_tissueOps';
import { Cv, CvMat, CvMatVector, ImageDataLike, loadCv } from './cv';

const MAX_EDGE = 1024;

function encodeOverlayBase64(cv: Cv, rgb: CvMat): string {
  const rgba = new cv.Mat();
  cv.cvtColor(rgb, rgba, cv.COLOR_RGB2RGBA);
  try {
    const encoded = jpeg.encode({ data: Buffer.from(rgba.data), width: rgba.cols, height: rgba.rows }, 82);
    return encoded.data.toString('base64');
  } finally {
    rgba.delete();
  }
}

/** Server-side port of the native react-native-fast-opencv pipeline (same HSV thresholds). */
function runPipeline(cv: Cv, image: ImageDataLike, includeCoinReference: boolean): CvResult {
  const trash: CvMat[] = [];
  const track = <T extends CvMat>(mat: T): T => {
    trash.push(mat);
    return mat;
  };
  let contours: CvMatVector | null = null;

  try {
    const src = track(cv.matFromImageData(image));
    const rgbFull = track(new cv.Mat());
    cv.cvtColor(src, rgbFull, cv.COLOR_RGBA2RGB);

    const scale = Math.min(1, MAX_EDGE / Math.max(rgbFull.rows, rgbFull.cols));
    const targetWidth = Math.max(1, Math.round(rgbFull.cols * scale));
    const targetHeight = Math.max(1, Math.round(rgbFull.rows * scale));

    const resized = track(new cv.Mat());
    cv.resize(rgbFull, resized, new cv.Size(targetWidth, targetHeight), 0, 0, cv.INTER_LINEAR);
    const blurred = track(new cv.Mat());
    cv.GaussianBlur(resized, blurred, new cv.Size(5, 5), 0);
    const gray = track(new cv.Mat());
    cv.cvtColor(blurred, gray, cv.COLOR_RGB2GRAY);

    const combined = track(new cv.Mat(targetHeight, targetWidth, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0)));
    buildHsvMask(cv, blurred, combined);

    const hierarchy = track(new cv.Mat());
    contours = new cv.MatVector();
    cv.findContours(combined, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let areaPx2 = 0;
    let largestIdx = -1;
    for (let i = 0; i < contours.size(); i += 1) {
      const area = cv.contourArea(contours.get(i));
      if (area > areaPx2) {
        areaPx2 = area;
        largestIdx = i;
      }
    }

    // Tissue composition is measured INSIDE the wound mask only. Classifying the
    // whole frame would fold skin and background pixels into the CWCS tissue axis
    // (and therefore into the pathway), so `combined` — the HSV wound mask, same
    // dimensions as `blurred` — gates which pixels are counted.
    const tissue = breakdownFromBuffer(blurred.data, blurred.channels(), combined.data);
    const percentages = toPercentages(tissue);
    const maskAreaPx = countMaskPixels(combined.data);

    let coinDetected = false;
    let areaCm2: number | null = null;
    let pxPerCm: number | null = null;
    if (includeCoinReference) {
      // Same detector as the measure step (radius bounds + edge support), but
      // with no approved outline yet there is no wound to exclude. Under
      // assessmentV2 this scale is superseded by `/api/v1/assessments/measure`.
      const coin = detectCoin(cv, gray, null);
      if (coin) {
        coinDetected = true;
        pxPerCm = coin.pxPerCm;
        areaCm2 = areaPx2 / (pxPerCm * pxPerCm);
      }
    }

    // Periwound ring (Mölnlycke step 5 — 4 cm band around the wound edge). The
    // band is only meaningful once we know the real-world scale, so with no
    // marker we report null rather than guessing a pixel radius.
    const periwound = measurePeriwound(cv, blurred, combined, pxPerCm);

    // HSV wound centroid (fractional coords) — segmentation prompt/selection seed.
    let hsvCentroid: ImagePoint | null = null;
    if (largestIdx >= 0) {
      const moments = cv.moments(contours.get(largestIdx));
      if (moments.m00 > 0) {
        hsvCentroid = {
          xPct: moments.m10 / moments.m00 / targetWidth,
          yPct: moments.m01 / moments.m00 / targetHeight,
        };
      }
    }

    const overlay = track(blurred.clone());
    if (largestIdx >= 0) {
      cv.drawContours(overlay, contours, largestIdx, new cv.Scalar(0, 200, 120, 255), 2, cv.LINE_8);
    }
    const overlayBase64 = encodeOverlayBase64(cv, overlay);

    const confidence = areaPx2 > 500 ? (coinDetected ? 'high' : 'medium') : ('low' as const);

    return {
      ...percentages,
      areaPx2,
      areaCm2,
      pxPerCm,
      depthAssessed: false,
      confidence,
      maskSource: 'hsv',
      maskAreaPx,
      periwound,
      overlayBase64,
      analysisEngine: 'opencv',
      coinDetected,
      hsvCentroid,
    };
  } finally {
    contours?.delete();
    trash.forEach((mat) => mat.delete());
  }
}

/**
 * POST /api/analyze — the HSV colour pass: the capture quality gate, the
 * offline-equivalent fallback, and (with assessmentV2 off) the legacy
 * measurement. Under assessmentV2 nothing here is shown as a measurement —
 * that comes from POST /measure on the approved outline.
 */
export default endpoint({
  name: 'analyze',
  scope: 'analyze',
  input: analyzeInput,
  handle: async (input) => {
    let decoded;
    try {
      decoded = jpeg.decode(Buffer.from(stripDataUri(input.base64), 'base64'), { useTArray: true, maxMemoryUsageInMB: 512 });
    } catch {
      return { status: 400, error: { code: 'validation_error', message: 'The image could not be read (expected a JPEG).' } };
    }
    const cv = await loadCv();
    const result = runPipeline(cv, { data: decoded.data, width: decoded.width, height: decoded.height }, Boolean(input.includeCoinReference));
    return { body: result, outcome: { coinDetected: result.coinDetected, confidence: result.confidence } };
  },
});
