/**
 * SAM 3 adapter → fal.ai (server-side only).
 *
 * SAM 3's addition over SAM 2 is the *concept* prompt: give it a noun phrase
 * ("wound") and it returns every instance of that concept, with scores. That
 * collapses the build spec's optional V2 segmentation plan (§3 — "Grounding DINO
 * text-prompt 'wound' → box → SAM 2") into a single call, and it means the HSV
 * centroid is no longer load-bearing: it becomes a tiebreaker when more than one
 * instance comes back, not the only thing standing between us and a mask of the
 * patient's shoe.
 *
 * The cage (build spec §2) is unchanged: SAM 3 produces a BOUNDARY. It is not
 * asked anything clinical, it has no free-text channel into the decision path,
 * and it is zero-shot.
 *
 * Endpoint: `fal-ai/sam-3/image`, called synchronously at `https://fal.run/...`.
 * Input schema used here (verified against the published Sam3ImageInput):
 * image_url, prompt, point_prompts[{x,y,label}], apply_mask, output_format,
 * return_multiple_masks, max_masks, include_scores, sync_mode.
 * Output: `{ masks: Image[], image, scores?: number[], metadata?, boxes? }`.
 *
 * Configuration (env, server-side only — never `EXPO_PUBLIC_`):
 *  - FAL_KEY              (required; sent as `Authorization: Key <FAL_KEY>`.
 *                          Absent → provider not configured → next provider)
 *  - SAM3_FAL_MODEL       (optional; default `fal-ai/sam-3/image`)
 *  - SAM3_PROMPT          (optional; default `wound`)
 *  - SAM3_MAX_MASKS       (optional; default 4, fal allows 1–32)
 *  - SAM3_SYNC_MODE       (optional; `true` returns masks as data uris instead
 *                          of hosted files — skips a CDN round-trip but inflates
 *                          the response, so it is off by default)
 *  - SAM3_TIMEOUT_MS      (optional; default 60000)
 */

import {
  dataUrlToBytes,
  parseSam3Response,
  sam3Request,
  SAM3_FAL_MODEL_DEFAULT,
  SAM3_PROMPT_DEFAULT,
  type ImagePoint,
  type Sam3Parsed,
} from './_segmentationParse';

export type Sam3Result = {
  /** Every instance of the concept prompt, as mask refs. */
  masks: string[];
  /** Per-mask confidence aligned with `masks`, or null when fal returned none. */
  scores: number[] | null;
  model: string;
  /** The concept prompt actually sent — recorded so a run is reproducible. */
  prompt: string;
  /** Whether a pixel point prompt was included (needs decodable dimensions). */
  pointPrompted: boolean;
  keys: string[];
};

export function isSam3Configured(): boolean {
  return Boolean(process.env.FAL_KEY);
}

/** The env var names this provider reads — names only, never values. */
export const SAM3_ENV_VARS = ['FAL_KEY'] as const;

export async function runSam3(args: {
  imageDataUrl: string;
  point?: ImagePoint | null;
}): Promise<Sam3Result> {
  // `point_prompts` are pixel coordinates; ours are fractional. The request
  // builder reads the real dimensions from the image header and omits the point
  // prompt if it can't — the concept prompt alone is a complete request, so a
  // point we cannot place correctly is left out rather than guessed.
  const request = sam3Request(process.env, {
    imageDataUrl: args.imageDataUrl,
    point: args.point ?? null,
    imageBytes: dataUrlToBytes(args.imageDataUrl),
  });
  if (!request) {
    throw new Error('SAM 3 not configured: FAL_KEY is unset.');
  }

  const sent = JSON.parse(request.body) as { prompt?: string; point_prompts?: unknown };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  let parsed: Sam3Parsed;
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SAM 3 request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    parsed = parseSam3Response((await response.json()) as unknown);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`SAM 3 timed out after ${request.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (parsed.masks.length === 0) {
    throw new Error(
      `SAM 3 found no "${sent.prompt ?? SAM3_PROMPT_DEFAULT}" in the image. ` +
        `Response keys: [${parsed.keys.join(', ')}].`,
    );
  }

  return {
    masks: parsed.masks,
    scores: parsed.scores,
    model: process.env.SAM3_FAL_MODEL ?? SAM3_FAL_MODEL_DEFAULT,
    prompt: sent.prompt ?? SAM3_PROMPT_DEFAULT,
    pointPrompted: Array.isArray(sent.point_prompts),
    keys: parsed.keys,
  };
}
