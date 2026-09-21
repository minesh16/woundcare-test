import type { VercelRequest, VercelResponse } from '@vercel/node';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { breakdownFromBuffer, toPercentages } from '../../../src/cv/tissueClassifier';
import type { TissueSummary } from '../../../src/assessment/state';
import { countMaskPixels, measurePeriwound } from '../../_tissueOps';
import { Cv, CvMat, loadCv } from '../../cv';

/**
 * POST /api/v1/assessments/tissue — tissue composition INSIDE the wound.
 *
 * Body: { base64, mask?: string, pxPerCm?: number }
 *
 * The mask is the point of this endpoint. Classifying a whole photograph folds
 * skin, background and clothing into the CWCS tissue axis, and the pathway
 * inherits that error — so pixels outside the boundary are not counted at all
 * (they are skipped, not binned as "other", which would still distort the
 * percentages).
 *
 * With no SAM 2 mask supplied we fall back to the HSV wound mask and say so via
 * `maskSource`, because a weaker boundary should be visible downstream rather
 * than silently assumed to be as good.
 */

const MAX_EDGE = 1024;

function stripDataUri(base64: string): string {
  return base64.replace(/^data:image\/\w+;base64,/, '');
}

type Hsv = readonly [number, number, number];

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

/** Fetch or decode a SAM 2 mask PNG (url or data-url) into raw RGBA. */
async function loadMaskPng(source: string): Promise<PNG | null> {
  try {
    let buffer: Buffer;
    if (source.startsWith('data:')) {
      buffer = Buffer.from(stripDataUri(source), 'base64');
    } else {
      const response = await fetch(source);
      if (!response.ok) return null;
      buffer = Buffer.from(await response.arrayBuffer());
    }
    return PNG.sync.read(buffer);
  } catch (error) {
    console.warn('Mask decode failed; falling back to the HSV mask.', error);
    return null;
  }
}

/** Nearest-neighbour resample of a mask PNG onto the analysis grid. */
function maskToBuffer(png: PNG, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(png.height - 1, Math.floor((y / height) * png.height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(png.width - 1, Math.floor((x / width) * png.width));
      const idx = (sy * png.width + sx) * 4;
      // SAM 2 masks are white-on-black; alpha-zero pixels are outside too.
      const on = png.data[idx + 3] !== 0 && png.data[idx] > 127;
      out[y * width + x] = on ? 255 : 0;
    }
  }
  return out;
}

export type TissueRequest = { base64: string; mask?: string | null; pxPerCm?: number | null };
export type TissueResponse = {
  tissue: TissueSummary | null;
  maskSource: TissueSummary['maskSource'];
  maskAreaPx: number;
  periwound: TissueSummary['periwound'];
  reason?: string;
  periwoundReason?: string;
};

/**
 * The step itself, callable directly. The HTTP handler and the `run`
 * orchestrator both go through this, so there is one implementation of the
 * measurement rather than one per entry point.
 */
export async function analyzeTissue(body: TissueRequest): Promise<TissueResponse> {
  const base64 = stripDataUri(String(body.base64 ?? ''));
  const pxPerCm = typeof body.pxPerCm === 'number' ? body.pxPerCm : null;

  if (!base64) {
    throw new Error('Missing base64 image.');
  }

  const trash: CvMat[] = [];
  const track = <T extends CvMat>(mat: T): T => {
    trash.push(mat);
    return mat;
  };

  try {
    const decoded = jpeg.decode(Buffer.from(base64, 'base64'), { useTArray: true, maxMemoryUsageInMB: 512 });
    const cv = await loadCv();

    const src = track(cv.matFromImageData({ data: decoded.data, width: decoded.width, height: decoded.height }));
    const rgbFull = track(new cv.Mat());
    cv.cvtColor(src, rgbFull, cv.COLOR_RGBA2RGB);

    const scale = Math.min(1, MAX_EDGE / Math.max(rgbFull.rows, rgbFull.cols));
    const width = Math.max(1, Math.round(rgbFull.cols * scale));
    const height = Math.max(1, Math.round(rgbFull.rows * scale));

    const resized = track(new cv.Mat());
    cv.resize(rgbFull, resized, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
    const blurred = track(new cv.Mat());
    cv.GaussianBlur(resized, blurred, new cv.Size(5, 5), 0);

    // Build the wound mask: SAM 2 when supplied, HSV otherwise.
    let maskSource: TissueSummary['maskSource'] = 'hsv';
    let maskMat = track(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0)));

    const suppliedMask = typeof body.mask === 'string' && body.mask ? await loadMaskPng(body.mask) : null;
    if (suppliedMask) {
      const buffer = maskToBuffer(suppliedMask, width, height);
      maskMat.data.set(buffer);
      maskSource = 'sam2';
    } else {
      const hsv = track(new cv.Mat());
      cv.cvtColor(blurred, hsv, cv.COLOR_RGB2HSV);
      const wound = track(new cv.Mat());
      inRangeScalar(cv, hsv, [0, 30, 35], [35, 255, 255], wound);
      const slough = track(new cv.Mat());
      inRangeScalar(cv, hsv, [8, 20, 30], [45, 255, 255], slough);
      cv.bitwise_or(wound, slough, maskMat);
      const necrosis = track(new cv.Mat());
      inRangeScalar(cv, hsv, [0, 0, 0], [180, 255, 70], necrosis);
      cv.bitwise_or(maskMat, necrosis, maskMat);
      const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
      cv.morphologyEx(maskMat, maskMat, cv.MORPH_CLOSE, kernel);
      cv.morphologyEx(maskMat, maskMat, cv.MORPH_OPEN, kernel);
    }

    const maskAreaPx = countMaskPixels(maskMat.data);
    if (maskAreaPx === 0) {
      return {
        tissue: null,
        maskSource,
        maskAreaPx: 0,
        periwound: null,
        reason: 'No wound area found in the image.',
      };
    }

    const breakdown = breakdownFromBuffer(blurred.data, blurred.channels(), maskMat.data);
    const pct = toPercentages(breakdown);
    const periwound = measurePeriwound(cv, blurred, maskMat, pxPerCm);

    const summary: TissueSummary = {
      granulation: pct.granulationPercent,
      slough: pct.sloughPercent,
      necrotic: pct.necrosisPercent,
      epithelial: pct.epithelialPercent,
      other: pct.otherPercent,
      maskSource,
      maskAreaPx,
      periwound: periwound
        ? { rednessPct: periwound.rednessPct, macerationPct: periwound.macerationPct, maceration: periwound.maceration }
        : null,
    };

    return {
      tissue: summary,
      maskSource,
      maskAreaPx,
      periwound: summary.periwound,
      // Without a scale, 4 cm cannot be expressed in pixels — we say so rather
      // than sizing the band off an assumed distance.
      periwoundReason: summary.periwound ? undefined : 'No size reference, so the 4 cm band could not be measured.',
    };
  } finally {
    trash.forEach((mat) => mat.delete());
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  try {
    res.status(200).json(await analyzeTissue(body));
  } catch (error) {
    console.error('Tissue analysis failed.', error);
    const message = error instanceof Error ? error.message : 'Tissue analysis failed.';
    res.status(message.startsWith('Missing') ? 400 : 500).json({ error: message });
  }
}
