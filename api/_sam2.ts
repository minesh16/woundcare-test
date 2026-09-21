/**
 * SAM 2 adapter → Replicate GPU endpoint (server-side only).
 *
 * The cage (docs/HANDOFF.md / build spec §3): SAM 2 is zero-shot boundary
 * detection only — it produces a mask, never a dressing pathway. It is NOT on
 * the Vercel AI Gateway (the gateway only serves text/image/video/speech/
 * embeddings/reranking models, and Replicate is not a gateway provider), so it
 * lives on a separate GPU endpoint. Here that is Replicate, called directly.
 *
 * IMPORTANT — model capability: `meta/sam-2` is the AUTOMATIC mask generator
 * (segments everything on a points-per-side grid). Its schema has NO point/box
 * prompt input (verified: input = image, points_per_side, pred_iou_thresh,
 * stability_score_thresh, use_m2m; output = combined_mask, individual_masks).
 * So the HSV centroid can't be passed as a prompt — it is instead used to
 * SELECT the wound mask from `individual_masks` (see mask selection below /
 * segment.ts). To do true prompted segmentation, swap in a point-promptable
 * SAM 2 model via SAM2_REPLICATE_MODEL.
 *
 * Configuration (env):
 *  - REPLICATE_API_TOKEN   (required; provisioned by the Vercel↔Replicate
 *                           integration; absent → not configured → degrade)
 *  - SAM2_REPLICATE_MODEL  (optional; defaults to meta/sam-2)
 *  - SAM2_POINTS_PER_SIDE  (optional integer; fewer points = faster, coarser)
 */

export type ImagePoint = { xPct: number; yPct: number };

export type Sam2Result = {
  /** Union of all detected masks (PNG uri) — quick to display, but not wound-specific. */
  combinedMask: string | null;
  /** Per-object masks (PNG uris); select the wound mask via the HSV centroid. */
  individualMasks: string[];
  confidence: 'high' | 'medium' | 'low';
  model: string;
};

const REPLICATE_BASE = 'https://api.replicate.com/v1';
const DEFAULT_MODEL = 'meta/sam-2';

export function isSam2Configured(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Run SAM 2 automatic mask generation on an image. Returns the combined mask +
 * individual masks. Throws if the endpoint is not configured or the request
 * fails — callers degrade conservatively to the existing HSV mask.
 */
export async function runSam2Segmentation(args: {
  imageDataUrl: string;
}): Promise<Sam2Result> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error('SAM 2 not configured: REPLICATE_API_TOKEN is unset.');
  }

  const model = process.env.SAM2_REPLICATE_MODEL ?? DEFAULT_MODEL;
  const pointsPerSide = Number(process.env.SAM2_POINTS_PER_SIDE ?? 32);

  // Input keys match the verified meta/sam-2 schema exactly.
  const input: Record<string, unknown> = {
    image: args.imageDataUrl,
    points_per_side: Number.isFinite(pointsPerSide) ? pointsPerSide : 32,
    use_m2m: true,
  };

  // `Prefer: wait` blocks up to 60s for the prediction to resolve, avoiding a
  // separate polling loop for the demo's request/response shape. Official
  // models use the /models/{owner}/{name}/predictions endpoint.
  const response = await fetch(`${REPLICATE_BASE}/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`SAM 2 request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const prediction = (await response.json()) as {
    status?: string;
    output?: { combined_mask?: unknown; individual_masks?: unknown } | null;
    error?: unknown;
  };

  if (prediction.status === 'failed' || prediction.error) {
    throw new Error(`SAM 2 prediction failed: ${String(prediction.error ?? 'unknown error')}`);
  }

  const output = prediction.output ?? {};
  const combinedMask = typeof output.combined_mask === 'string' ? output.combined_mask : null;
  const individualMasks = asStringArray(output.individual_masks);

  return {
    combinedMask,
    individualMasks,
    // SAM 2's HTTP output exposes no scalar score here; a returned mask is
    // treated as medium confidence, none as low (conservative by default).
    confidence: combinedMask || individualMasks.length > 0 ? 'medium' : 'low',
    model,
  };
}
