/**
 * FUSegNet adapter → Modal GPU endpoint (server-side only).
 *
 * FUSegNet is a wound-specific segmentation network (FUSeg-challenge lineage:
 * EfficientNet encoder + parallel scSE decoder, trained on chronic foot-ulcer
 * photographs). Unlike SAM it is not promptable and not general — it takes an
 * image and returns one binary wound mask. For this app that is the point:
 *
 *  - no prompt to get wrong and nothing to disambiguate, so the "model segmented
 *    the foot instead of the ulcer" failure mode is gone;
 *  - its training distribution is a clinical population MendWise targets.
 *
 * But it is the *specific* model, not the *general* one — chronic FOOT ulcers —
 * which is why SAM 3 runs first. And it has **no abstain**: on a synthetic image
 * with no wound in it, it returned a 3,346 px mask at `mean_prob` 0.95, where
 * SAM 3 correctly returned no match at all. Nothing here can be read as "there is
 * a wound"; that is what `maskPlausibility` and the engine's gates are for.
 *
 * The cage (build spec §2) is unchanged: this produces a BOUNDARY. Tissue
 * composition is still measured by OpenCV HSI inside the mask, and the dressing
 * decision is still the deterministic engine's. Zero-shot, no fine-tuning by us.
 *
 * Configuration (env, server-side only — never `EXPO_PUBLIC_`):
 *  - FUSEGNET_MODAL_URL     (required; the deployed `*.modal.run` web endpoint.
 *                            Absent → provider not configured → next provider)
 *  - MODAL_KEY / MODAL_SECRET  (Modal proxy auth: sent as `Modal-Key` /
 *                            `Modal-Secret`, which is what `requires_proxy_auth`
 *                            expects)
 *  - FUSEGNET_AUTH_TOKEN    (alternative: sent as `Authorization: Bearer <t>`,
 *                            for an endpoint that checks the token itself)
 *  - FUSEGNET_IMAGE_FIELD   (optional; request field holding the image,
 *                            default `image_b64` — the endpoint's own name for it)
 *  - FUSEGNET_SEGMENT_PATH  (optional; default `/segment`. FUSEGNET_MODAL_URL is
 *                            the bare origin, which 404s on its own)
 *  - FUSEGNET_SIZE          (optional; model input side, multiple of 32. Omitted
 *                            by default so the endpoint keeps its own 512)
 *  - FUSEGNET_MASK_FIELD    (optional; response field holding the mask — tried
 *                            before the known spellings in `_segmentationParse`)
 *  - FUSEGNET_TIMEOUT_MS    (optional; default 60000. A cold Modal container
 *                            loading EfficientNet weights is slow on the first
 *                            call and fast afterwards, so this is generous)
 *  - FUSEGNET_MODEL_LABEL   (optional; audit-log fallback only — the endpoint
 *                            reports its own `model`, which is preferred)
 *
 * The request is assembled by `fusegnetRequest` in `_segmentationParse.ts`, which
 * `npm run check:segmentation` also uses — so the probe verifies the request this
 * adapter actually sends, not a lookalike.
 */

import {
  fusegnetRequest,
  parseFusegnetResponse,
  type FusegnetParsed,
} from './_segmentationParse';

export type FusegnetResult = {
  /** The single binary wound mask (http url or data uri). */
  mask: string;
  /**
   * The endpoint's `mean_prob`. NOT an "is there a wound" signal — FUSegNet has
   * no abstain and returned 0.95 on an image containing no wound. It can only
   * downgrade confidence, never establish it.
   */
  score: number | null;
  /** Pixel area if the endpoint already counted it (we re-measure anyway). */
  areaPx: number | null;
  /** Whether the endpoint's own region filter saw more than one component. */
  multipleRegions: boolean | null;
  model: string;
  /** Response keys, for diagnosing a contract mismatch. */
  keys: string[];
};

export function isFusegnetConfigured(): boolean {
  return Boolean(process.env.FUSEGNET_MODAL_URL);
}

/** The env var names this provider reads — names only, never values. */
export const FUSEGNET_ENV_VARS = [
  'FUSEGNET_MODAL_URL',
  'MODAL_KEY',
  'MODAL_SECRET',
  'FUSEGNET_AUTH_TOKEN',
] as const;

/**
 * Run FUSegNet on an image. Throws on a missing config, a transport failure or
 * an unrecognised response shape — the facade catches and moves to the next
 * provider, so a FUSegNet outage degrades the boundary rather than the
 * assessment.
 */
export async function runFusegnet(args: { imageDataUrl: string }): Promise<FusegnetResult> {
  const request = fusegnetRequest(process.env, args.imageDataUrl);
  if (!request) {
    throw new Error('FUSegNet not configured: FUSEGNET_MODAL_URL is unset.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  let parsed: FusegnetParsed;
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`FUSegNet request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    parsed = parseFusegnetResponse((await response.json()) as unknown, process.env.FUSEGNET_MASK_FIELD);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`FUSegNet timed out after ${request.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!parsed.mask) {
    // Name the keys we did get: this is the one failure that is a contract
    // mismatch rather than an outage, and it is invisible without them.
    throw new Error(
      `FUSegNet returned no recognisable mask. Response keys: [${parsed.keys.join(', ')}]. ` +
        'Set FUSEGNET_MASK_FIELD to the right key, or run npm run check:segmentation.',
    );
  }

  return {
    mask: parsed.mask,
    score: parsed.score,
    areaPx: parsed.areaPx,
    multipleRegions: parsed.multipleRegions,
    // Prefer the weights the endpoint names itself over a label we made up: the
    // audit log's job is to say what actually ran, and the endpoint knows and we
    // don't. Falls back to the env label, then a constant.
    model: parsed.model ?? process.env.FUSEGNET_MODEL_LABEL ?? 'fusegnet@modal',
    keys: parsed.keys,
  };
}
