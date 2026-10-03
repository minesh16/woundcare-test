import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PNG } from 'pngjs';

import {
  countSet,
  polygonAreaFraction,
  rasterisePolygon,
  validatePolygon,
  type MaskPoint,
} from '../../_maskGeometry';
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
  /** PNG data-uri, white-on-black, ready to hand to the tissue step. */
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

/** Encode a 0/255 single-channel mask as a white-on-black PNG data-uri. */
function toPngDataUri(mask: Uint8Array, width: number, height: number): string {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const on = mask[i] !== 0 ? 255 : 0;
    const o = i * 4;
    png.data[o] = on;
    png.data[o + 1] = on;
    png.data[o + 2] = on;
    // Opaque everywhere: the consumers test brightness AND alpha, and a
    // transparent "outside" would read as outside twice rather than once.
    png.data[o + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
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

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};

  try {
    const result = rasteriseBoundary(body as MaskRequest);
    // Log it like a segmentation call: a clinician-drawn boundary is a boundary
    // decision, and which boundary was measured is exactly what the audit trail
    // needs. No image, no mask data — the shape's size only.
    console.log(
      '[boundary]',
      JSON.stringify({
        at: new Date().toISOString(),
        assessmentId: typeof body.assessment_id === 'string' ? body.assessment_id : null,
        approval: typeof body.approval === 'string' ? body.approval : null,
        points: (body.polygon as MaskPoint[]).length,
        areaPx: result.areaPx,
        areaPct: result.areaPct,
        shoelaceAreaPct: Number((100 * polygonAreaFraction(body.polygon as MaskPoint[])).toFixed(2)),
        plausibility: result.plausibility,
      }),
    );
    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not build the boundary mask.';
    // A bad polygon is a client error, not a server fault.
    res.status(message.startsWith('Invalid boundary') ? 400 : 500).json({ error: message });
  }
}
