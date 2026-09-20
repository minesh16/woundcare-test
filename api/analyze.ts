import type { VercelRequest, VercelResponse } from '@vercel/node';
import jpeg from 'jpeg-js';

import { px2ToCm2 } from '../src/cv/measureArea';
import { breakdownFromBuffer, toPercentages } from '../src/cv/tissueClassifier';
import { CvResult } from '../src/decision/types';
import { Cv, CvMat, CvMatVector, ImageDataLike, loadCv } from './cv';

const MAX_EDGE = 1024;

type Hsv = readonly [number, number, number];

function stripDataUri(base64: string): string {
  return base64.replace(/^data:image\/\w+;base64,/, '');
}

/** OpenCV.js requires full-size Mats (not scalars) for inRange bounds. */
function inRangeScalar(cv: Cv, src: CvMat, lo: Hsv, hi: Hsv, dst: CvMat): void {
  const low = new cv.Mat(src.rows, src.cols, src.type(), new cv.Scalar(lo[0], lo[1], lo[2]));
  const high = new cv.Mat(src.rows, src.cols, src.type(), new cv.Scalar(hi[0], hi[1], hi[2]));
  try {
    cv.inRange(src, low, high, dst);
  } finally {
    low.delete();
    high.delete();
  }
}

function detectCoinAreaPx2(cv: Cv, gray: CvMat): number | null {
  const circles = new cv.Mat();
  try {
    cv.HoughCircles(gray, circles, cv.HOUGH_GRADIENT, 1.2, 40, 100, 30);
    if (circles.data32F.length >= 3) {
      const radius = circles.data32F[2];
      if (radius > 0) {
        return Math.PI * radius * radius;
      }
    }
    return null;
  } finally {
    circles.delete();
  }
}

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
    const hsv = track(new cv.Mat());
    cv.cvtColor(blurred, hsv, cv.COLOR_RGB2HSV);
    const gray = track(new cv.Mat());
    cv.cvtColor(blurred, gray, cv.COLOR_RGB2GRAY);

    const wound = track(new cv.Mat());
    inRangeScalar(cv, hsv, [0, 30, 35], [35, 255, 255], wound);
    const slough = track(new cv.Mat());
    inRangeScalar(cv, hsv, [8, 20, 30], [45, 255, 255], slough);
    const combined = track(new cv.Mat());
    cv.bitwise_or(wound, slough, combined);
    const necrosis = track(new cv.Mat());
    inRangeScalar(cv, hsv, [0, 0, 0], [180, 255, 70], necrosis);
    cv.bitwise_or(combined, necrosis, combined);

    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    cv.morphologyEx(combined, combined, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(combined, combined, cv.MORPH_OPEN, kernel);

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

    const tissue = breakdownFromBuffer(blurred.data, blurred.channels());
    const percentages = toPercentages(tissue);

    let coinDetected = false;
    let areaCm2: number | null = null;
    if (includeCoinReference) {
      const coinAreaPx2 = detectCoinAreaPx2(cv, gray);
      if (coinAreaPx2) {
        coinDetected = true;
        areaCm2 = px2ToCm2(areaPx2, coinAreaPx2);
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
      depthAssessed: false,
      confidence,
      overlayBase64,
      analysisEngine: 'opencv',
      coinDetected,
    };
  } finally {
    contours?.delete();
    trash.forEach((mat) => mat.delete());
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
    const base64 = stripDataUri(String(body.base64 ?? ''));
    const includeCoinReference = Boolean(body.includeCoinReference);

    if (!base64) {
      res.status(400).json({ error: 'Missing base64 image.' });
      return;
    }

    const decoded = jpeg.decode(Buffer.from(base64, 'base64'), { useTArray: true, maxMemoryUsageInMB: 512 });
    const cv = await loadCv();
    const result = runPipeline(cv, { data: decoded.data, width: decoded.width, height: decoded.height }, includeCoinReference);

    res.status(200).json(result);
  } catch (error) {
    console.error('OpenCV analysis failed on server.', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Analysis failed.' });
  }
}
