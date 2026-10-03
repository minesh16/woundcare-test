import {
  countSet,
  polygonAreaFraction,
  rasterisePolygon,
  validatePolygon,
  type MaskPoint,
} from '../../_maskGeometry';
import { maskInput } from '../../_contracts';
import { endpoint } from '../../_http';
import { toPngDataUri } from '../../_maskIO';
import { maskPlausibility, describePlausibility } from '../../_segmentationParse';

/**
 * POST /api/v1/assessments/mask — turn a clinician's boundary into a mask.
 *
 * Body: { polygon: [{x,y}, …], width?, height?, approval?, assessment_id? }
 *   `polygon` is in FRACTIONAL image coordinates (0–1), which is why no image is
 *   needed here: the polygon is resolution-independent, so the mask can be
 *   rasterised at whatever resolution the measurement step wants.
 *
 * Response: { mask, areaPx, framePx, areaPct, plausibility, width, height }
 *
 * Why this is server-side at all, when a browser could rasterise to a canvas:
 * web/native parity (build spec §2.4). Expo-native has no canvas, so doing it
 * here is the only way both platforms produce a byte-identical mask from the same
 * polygon — and the mask is what every tissue percentage is measured inside.
 *
 * On plausibility: the verdict is REPORTED, never enforced. The automatic gate in
 * `_segmentation.ts` exists to catch a *model* returning nonsense. Here a human
 * has deliberately drawn this boundary, and the whole point of the review screen
 * is that their judgement outranks the model's. The UI warns; the clinician
 * decides.
 */

const DEFAULT_SIZE = 1024;
const MAX_SIZE = 2048;

export type MaskRequest = {
  polygon: MaskPoint[];
  width?: number;
  height?: number;
};

export type MaskResponse = {
  /** PNG data-uri, white-on-black, ready to approve. */
  mask: string;
  areaPx: number;
  framePx: number;
  areaPct: number;
  /** 'plausible' | 'empty' | 'too_small' | 'too_large' — advisory only. */
  plausibility: string;
  plausibilityReason: string;
  width: number;
  height: number;
};

function clampSize(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_SIZE, Math.max(16, Math.round(value)));
}

/** The step itself, callable directly so the orchestrator need not self-fetch. */
export function rasteriseBoundary(body: MaskRequest): MaskResponse {
  const validation = validatePolygon(body.polygon);
  if (!validation.ok) {
    throw new Error(`Invalid boundary: ${validation.reason}`);
  }

  const width = clampSize(body.width, DEFAULT_SIZE);
  const height = clampSize(body.height, DEFAULT_SIZE);
  const mask = rasterisePolygon(body.polygon, width, height);
  const areaPx = countSet(mask);
  const framePx = width * height;
  const verdict = maskPlausibility(areaPx, framePx);

  return {
    mask: toPngDataUri(mask, width, height),
    areaPx,
    framePx,
    // Shoelace and the rasterised count should agree; the rasterised count is
    // authoritative because it is what will actually be measured.
    areaPct: Number(((100 * areaPx) / framePx).toFixed(2)),
    plausibility: verdict,
    plausibilityReason: describePlausibility(verdict),
    width,
    height,
  };
}

export default endpoint({
  name: 'mask',
  scope: 'segment',
  input: maskInput,
  handle: async (input) => {
    let result: MaskResponse;
    try {
      result = rasteriseBoundary(input);
    } catch (error) {
      return { status: 400, error: { code: 'validation_error', message: error instanceof Error ? error.message : 'Invalid boundary.' } };
    }
    // A clinician-drawn boundary is a boundary decision: log its size, never its shape.
    console.log(
      '[boundary]',
      JSON.stringify({
        at: new Date().toISOString(),
        assessmentId: input.assessment_id ?? null,
        approval: input.approval ?? null,
        points: input.polygon.length,
        areaPx: result.areaPx,
        areaPct: result.areaPct,
        shoelaceAreaPct: Number((100 * polygonAreaFraction(input.polygon)).toFixed(2)),
        plausibility: result.plausibility,
      }),
    );
    return { body: result, outcome: { points: input.polygon.length, areaPct: result.areaPct } };
  },
});
