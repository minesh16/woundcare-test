/**
 * FUSegNet adapter → Modal GPU endpoint (server-side only).
 *
 * FUSegNet is a wound-specific segmentation network (FUSeg-challenge lineage:
 * EfficientNet encoder + parallel scSE decoder, trained on chronic foot-ulcer
 * photographs). Unlike SAM it is not promptable and not general — it takes an
 * image and returns one binary wound mask. For this app that is the point:
 *
 *  - no prompt to get wrong, and no `individual_masks` to disambiguate, so the
 *    "model segmented the foot instead of the ulcer" failure mode is gone;
 *  - it is the only one of the three backends whose training distribution is
 *    the clinical population MendWise targets.
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
 *                            default `image`)
 *  - FUSEGNET_MASK_FIELD    (optional; response field holding the mask — tried
 *                            before the known spellings in `_segmentationParse`)
 *  - FUSEGNET_TIMEOUT_MS    (optional; default 60000. A cold Modal container
 *                            loading EfficientNet weights is slow on the first
 *                            call and fast afterwards, so this is generous)
 *  - FUSEGNET_MODEL_LABEL   (optional; what goes in the audit log's model field)
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
  /** Scalar confidence if the endpoint returns one; null otherwise. */
  score: number | null;
  /** Pixel area if the endpoint already counted it (we re-measure anyway). */
  areaPx: number | null;
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
    model: process.env.FUSEGNET_MODEL_LABEL ?? 'fusegnet@modal',
    keys: parsed.keys,
  };
}
