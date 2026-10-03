import jpeg from 'jpeg-js';

import { MAX_EDGE, stripDataUri } from './_image';
import { Cv, CvMat, loadCv } from './cv';

/**
 * The on-device-style HSV wound mask, server-side.
 *
 * One implementation for the three places that need it: the legacy `/api/analyze`
 * pass, the tissue step's fallback, and `/segment`'s fallback when no model
 * answers (spec §3.1: on any failure, return `source: 'hsv'`). On a leg ulcer it
 * can trace the whole limb — which is exactly why, as a fallback, it goes to the
 * review screen to be corrected rather than straight into a measurement.
 */

type Hsv = readonly [number, number, number];

/** OpenCV.js requires full-size Mats (not scalars) for inRange bounds. */
export function inRangeScalar(cv: Cv, src: CvMat, lo: Hsv, hi: Hsv, dst: CvMat): void {
  const low = new cv.Mat(src.rows, src.cols, src.type(), new cv.Scalar(lo[0], lo[1], lo[2]));
  const high = new cv.Mat(src.rows, src.cols, src.type(), new cv.Scalar(hi[0], hi[1], hi[2]));
  try {
    cv.inRange(src, low, high, dst);
  } finally {
    low.delete();
    high.delete();
  }
}

/**
 * Write the HSV wound mask of `blurredRgb` into `dst` (CV_8UC1, same size):
 * red/pink (granulation) ∪ yellow (slough) ∪ dark (necrosis), closed then opened.
 */
export function buildHsvMask(cv: Cv, blurredRgb: CvMat, dst: CvMat): void {
  const temps: CvMat[] = [];
  const t = <T extends CvMat>(m: T): T => {
    temps.push(m);
    return m;
  };
  try {
    const hsv = t(new cv.Mat());
    cv.cvtColor(blurredRgb, hsv, cv.COLOR_RGB2HSV);
    const wound = t(new cv.Mat());
    inRangeScalar(cv, hsv, [0, 30, 35], [35, 255, 255], wound);
    const slough = t(new cv.Mat());
    inRangeScalar(cv, hsv, [8, 20, 30], [45, 255, 255], slough);
    cv.bitwise_or(wound, slough, dst);
    const necrosis = t(new cv.Mat());
    inRangeScalar(cv, hsv, [0, 0, 0], [180, 255, 70], necrosis);
    cv.bitwise_or(dst, necrosis, dst);
    const kernel = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    cv.morphologyEx(dst, dst, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(dst, dst, cv.MORPH_OPEN, kernel);
  } finally {
    temps.forEach((m) => m.delete());
  }
}

/** The HSV mask of a JPEG, on the 1024 analysis grid, as flat 0/255 bytes. */
export async function hsvMaskFromImage(
  base64OrDataUrl: string,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const decoded = jpeg.decode(Buffer.from(stripDataUri(base64OrDataUrl), 'base64'), {
    useTArray: true,
    maxMemoryUsageInMB: 512,
  });
  const cv = await loadCv();
  const mats: CvMat[] = [];
  const t = <T extends CvMat>(m: T): T => {
    mats.push(m);
    return m;
  };
  try {
    const src = t(cv.matFromImageData({ data: decoded.data, width: decoded.width, height: decoded.height }));
    const rgb = t(new cv.Mat());
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const scale = Math.min(1, MAX_EDGE / Math.max(rgb.rows, rgb.cols));
    const width = Math.max(1, Math.round(rgb.cols * scale));
    const height = Math.max(1, Math.round(rgb.rows * scale));
    const resized = t(new cv.Mat());
    cv.resize(rgb, resized, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
    const blurred = t(new cv.Mat());
    cv.GaussianBlur(resized, blurred, new cv.Size(5, 5), 0);
    const mask = t(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0)));
    buildHsvMask(cv, blurred, mask);
    return { data: Uint8Array.from(mask.data), width, height };
  } finally {
    mats.forEach((m) => m.delete());
  }
}
