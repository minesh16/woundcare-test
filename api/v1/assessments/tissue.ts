import jpeg from 'jpeg-js';

import {
  breakdownFromBuffer,
  breakdownFromBufferRelative,
  medianLab,
  toPercentages,
} from '../../../src/cv/tissueClassifier';
import type { MeasurementResult, TissuePercentages, TissueSummary } from '../../../src/assessment/state';
import { endpoint } from '../../_http';
import { tissueInput } from '../../_contracts';
import { buildHsvMask } from '../../_hsvMask';
import { MAX_EDGE, stripDataUri } from '../../_image';
import { loadMaskPixels, resampleMask } from '../../_maskIO';
import { detectCoin, detectWhitePatch, measureMaskGeometry } from '../../_measure';
import { countMaskPixels, measurePeriwound } from '../../_tissueOps';
import { applyGains } from '../../_whiteBalance';
import { CvMat, loadCv } from '../../cv';

/**
 * Tissue composition INSIDE the wound — and, in measure mode, the wound's scale,
 * size and colour correction (segmentation spec §4.2, §5).
 *
 * Pixels outside the boundary are not counted at all (skipped, not binned as
 * "other"). With no mask supplied — only possible from the orchestrator's own
 * fallback, never over HTTP, where an approval is required — the HSV mask is
 * used and `maskSource` says so.
 */

export type TissueRequest = {
  base64: string;
  mask?: string | null;
  pxPerCm?: number | null;
  /** Which backend drew `mask`. Recorded, never inferred. */
  maskProvider?: TissueSummary['maskProvider'];
  /** Also find the coin and white patch OUTSIDE the mask and size the wound. */
  measure?: boolean;
  /** False when the clinician said there is no coin in the photo — skip the search. */
  includeCoinReference?: boolean;
};

export type TissueResponse = {
  tissue: TissueSummary | null;
  maskSource: TissueSummary['maskSource'];
  maskProvider: TissueSummary['maskProvider'];
  maskAreaPx: number;
  periwound: TissueSummary['periwound'];
  /** Present when `measure` was requested and a supplied mask was measured. */
  measurement?: MeasurementResult | null;
  reason?: string;
  periwoundReason?: string;
};

const asPercentages = (b: ReturnType<typeof breakdownFromBuffer>): TissuePercentages => {
  const p = toPercentages(b);
  return {
    granulation: p.granulationPercent,
    slough: p.sloughPercent,
    necrotic: p.necrosisPercent,
    epithelial: p.epithelialPercent,
    other: p.otherPercent,
  };
};

/** The step itself. The HTTP handler, `/measure` and `run` all come through here. */
export async function analyzeTissue(body: TissueRequest): Promise<TissueResponse> {
  const base64 = stripDataUri(String(body.base64 ?? ''));
  let pxPerCm = typeof body.pxPerCm === 'number' ? body.pxPerCm : null;
  let maskProvider: TissueSummary['maskProvider'] =
    body.maskProvider === 'sam3' || body.maskProvider === 'fusegnet' ? body.maskProvider : null;
  if (!base64) throw new Error('Missing base64 image.');

  const mats: CvMat[] = [];
  const t = <T extends CvMat>(m: T): T => {
    mats.push(m);
    return m;
  };

  try {
    const decoded = jpeg.decode(Buffer.from(base64, 'base64'), { useTArray: true, maxMemoryUsageInMB: 512 });
    const cv = await loadCv();
    const src = t(cv.matFromImageData({ data: decoded.data, width: decoded.width, height: decoded.height }));
    const rgbFull = t(new cv.Mat());
    cv.cvtColor(src, rgbFull, cv.COLOR_RGBA2RGB);

    const scale = Math.min(1, MAX_EDGE / Math.max(rgbFull.rows, rgbFull.cols));
    const width = Math.max(1, Math.round(rgbFull.cols * scale));
    const height = Math.max(1, Math.round(rgbFull.rows * scale));
    const resized = t(new cv.Mat());
    cv.resize(rgbFull, resized, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
    const blurred = t(new cv.Mat());
    cv.GaussianBlur(resized, blurred, new cv.Size(5, 5), 0);

    // The wound mask: the supplied one, or HSV.
    let maskSource: TissueSummary['maskSource'] = 'hsv';
    const maskMat = t(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0)));
    const supplied = typeof body.mask === 'string' && body.mask ? await loadMaskPixels(body.mask) : null;
    if (supplied) {
      maskMat.data.set(resampleMask(supplied, width, height));
      maskSource = 'model';
    } else {
      // The supplied mask did not decode (or there was none), so the provider
      // label would be a lie about which boundary was measured.
      maskProvider = null;
      buildHsvMask(cv, blurred, maskMat);
    }

    const maskAreaPx = countMaskPixels(maskMat.data);
    if (maskAreaPx === 0) {
      return { tissue: null, maskSource, maskProvider, maskAreaPx: 0, periwound: null, reason: 'No wound area found in the image.' };
    }

    // --- Measure mode: scale, colour correction, size ------------------------
    let measurement: MeasurementResult | null = null;
    let pixels: Uint8Array = blurred.data;
    let coinExclusion: { x: number; y: number; r: number }[] = [];
    if (body.measure && maskSource === 'model') {
      const gray = t(new cv.Mat());
      cv.cvtColor(blurred, gray, cv.COLOR_RGB2GRAY);
      const coin = body.includeCoinReference === false ? null : detectCoin(cv, gray, maskMat.data);
      pxPerCm = coin?.pxPerCm ?? null;
      if (coin) coinExclusion = [{ x: coin.xPct * width, y: coin.yPct * height, r: coin.rPct * width }];

      const patch = detectWhitePatch(cv, blurred, maskMat.data, coin);
      if (patch) pixels = applyGains(blurred.data, blurred.channels(), patch.gains);

      const absolute = breakdownFromBuffer(pixels, blurred.channels(), maskMat.data);
      // Relative classification needs the patient's own skin: the periwound band
      // when there is a scale, otherwise a ring 3% of the frame wide.
      const ringMat = t(maskMat.clone());
      const ringRadius = pxPerCm ? Math.round(2 * pxPerCm) : Math.round(0.03 * Math.max(width, height));
      const ringKernel = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * Math.min(ringRadius, 75) + 1, 2 * Math.min(ringRadius, 75) + 1)));
      cv.dilate(ringMat, ringMat, ringKernel);
      const ring = new Uint8Array(ringMat.data.length);
      for (let i = 0; i < ring.length; i += 1) ring[i] = ringMat.data[i] && !maskMat.data[i] ? 255 : 0;
      const skin = medianLab(pixels, blurred.channels(), ring);
      const relative = skin ? breakdownFromBufferRelative(pixels, blurred.channels(), maskMat.data, skin) : null;

      const useRelative = process.env.TISSUE_RELATIVE === '1' && relative !== null;
      measurement = {
        frame: { width, height },
        scale: coin,
        scaleReason: coin
          ? undefined
          : body.includeCoinReference === false
            ? 'No coin in the photo (as stated at capture).'
            : 'No coin found beside the wound.',
        geometry: measureMaskGeometry(cv, maskMat, maskAreaPx, pxPerCm),
        whiteBalance: patch ? { applied: true, gains: patch.gains, patch: patch.box } : { applied: false, reason: 'no_marker' },
        flags: patch ? [] : ['no_marker'],
        classifier: useRelative ? 'relative' : 'absolute',
        comparison: { absolute: asPercentages(absolute), relative: relative ? asPercentages(relative) : null },
      };
    }

    const breakdown =
      measurement?.classifier === 'relative'
        ? (() => {
            const c = measurement.comparison.relative!;
            return { granulation: c.granulation, slough: c.slough, necrosis: c.necrotic, epithelial: c.epithelial, other: c.other };
          })()
        : breakdownFromBuffer(pixels, blurred.channels(), maskMat.data);
    const pct = toPercentages(breakdown);

    // The 4 cm periwound band (needs the scale), measured on the corrected colours.
    const pixelMat = pixels === blurred.data ? blurred : (() => {
      const m = t(blurred.clone());
      m.data.set(pixels);
      return m;
    })();
    const periwound = measurePeriwound(cv, pixelMat, maskMat, pxPerCm, coinExclusion);

    const summary: TissueSummary = {
      granulation: pct.granulationPercent,
      slough: pct.sloughPercent,
      necrotic: pct.necrosisPercent,
      epithelial: pct.epithelialPercent,
      other: pct.otherPercent,
      maskSource,
      maskProvider,
      maskAreaPx,
      periwound: periwound
        ? { rednessPct: periwound.rednessPct, macerationPct: periwound.macerationPct, maceration: periwound.maceration }
        : null,
    };

    return {
      tissue: summary,
      maskSource,
      maskProvider,
      maskAreaPx,
      periwound: summary.periwound,
      measurement,
      periwoundReason: summary.periwound ? undefined : 'No size reference, so the 4 cm band could not be measured.',
    };
  } finally {
    mats.forEach((m) => m.delete());
  }
}

/**
 * POST /api/v1/assessments/tissue — tissue % inside an APPROVED outline.
 * Body: { base64, mask, approval_id }. Rejected (403) without a valid approval.
 */
export default endpoint({
  name: 'tissue',
  scope: 'tissue',
  input: tissueInput,
  requiresApproval: true,
  handle: async (input, ctx) => {
    const result = await analyzeTissue({
      base64: input.base64,
      mask: input.mask,
      maskProvider: (ctx.approval?.provider as TissueSummary['maskProvider']) ?? null,
    });
    if (!result.tissue) return { status: 422, error: { code: 'unprocessable', message: result.reason ?? 'No wound area found.' } };
    return { body: result };
  },
});
