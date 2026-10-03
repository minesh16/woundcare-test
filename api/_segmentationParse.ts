/**
 * Segmentation wire-format logic — pure functions, NO imports.
 *
 * Everything here is request-building, response-parsing and plausibility
 * checking for the three segmentation backends. It is deliberately a single
 * self-contained runtime module with zero relative imports, for the same reason
 * `src/decision/engine.ts` is: `node --experimental-strip-types` resolves ESM
 * specifiers literally, so a cross-file `import './_x'` (no extension) would
 * make this untestable offline. The HTTP adapters (`_sam3.ts`, `_fusegnet.ts`)
 * and the facade (`_segmentation.ts`) import FROM here; nothing is imported
 * INTO here.
 *
 * The cage (docs/MendWise_Assessment_Build_Spec.md §2): a segmentation model
 * produces a boundary and nothing else. No provider here emits a tissue class,
 * an exudate level or a dressing pathway — those come from HSI measurement
 * inside the returned mask and from the deterministic engine.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * The wound-boundary backends, in the order of preference below.
 *
 *  - `sam3`     — SAM 3 on fal.ai, driven by the text concept prompt "wound".
 *    Returns every instance of the concept, so selection may still apply.
 *  - `fusegnet` — wound-specific CNN (FUSeg-trained) on a Modal GPU endpoint.
 *    Returns ONE binary wound mask. No prompt, and no mask-selection step,
 *    because the model only knows how to segment wounds.
 *
 * SAM 2 on Replicate was a third provider and has been **removed**: it was the
 * automatic mask generator, with no prompt input at all, so it segmented
 * everything in the frame and the wound had to be guessed out of the result
 * afterwards. It did not work well enough to be worth keeping as a fallback. The
 * fallback below these two is the on-device HSV mask, as it always was.
 */
export type SegmentationProvider = 'sam3' | 'fusegnet';

/** Wound-bed centroid in fractional image coordinates (0–1). */
export type ImagePoint = { xPct: number; yPct: number };

export type MaskConfidence = 'high' | 'medium' | 'low';

export type ImageSize = { width: number; height: number };

/**
 * Preference order: **SAM 3 first**.
 *
 * FUSegNet is the more specific model but not the more general one — its training
 * set is chronic *foot* ulcers, so it is the preferred boundary for DFUs and an
 * unknown quantity on a venous leg ulcer or a pressure injury. SAM 3's concept
 * prompt has no such restriction. Leading with the general model and keeping the
 * specialist behind it is the conservative order until the golden eval set says
 * otherwise; that decision is then a one-line env change, not a code change.
 *
 * Override with `SEGMENTATION_PROVIDERS` (comma-separated) to change the order or
 * to pin a single provider — e.g. `SEGMENTATION_PROVIDERS=fusegnet` to evaluate
 * the foot-ulcer model on its own.
 */
export const DEFAULT_PROVIDER_ORDER: readonly SegmentationProvider[] = ['sam3', 'fusegnet'];

const ALL_PROVIDERS: readonly string[] = ['sam3', 'fusegnet'];

/**
 * Parse `SEGMENTATION_PROVIDERS`. Unknown names are dropped rather than
 * throwing — a typo in an env var must not take the pipeline down, and the
 * health endpoint reports what was actually understood. An empty or
 * all-unknown value falls back to the default order.
 */
export function parseProviderOrder(raw: string | undefined | null): SegmentationProvider[] {
  if (!raw) return [...DEFAULT_PROVIDER_ORDER];
  const seen = new Set<string>();
  const order: SegmentationProvider[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (!ALL_PROVIDERS.includes(name) || seen.has(name)) continue;
    seen.add(name);
    order.push(name as SegmentationProvider);
  }
  return order.length > 0 ? order : [...DEFAULT_PROVIDER_ORDER];
}

// ---------------------------------------------------------------------------
// Image geometry
// ---------------------------------------------------------------------------

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

/**
 * Read pixel dimensions from a JPEG or PNG header without decoding the image.
 *
 * SAM 3's `point_prompts` are in PIXELS, but every point in this app is
 * fractional (0–1) so it survives resizing. Converting needs the real
 * dimensions, and a full `jpeg-js` decode to learn two numbers would cost
 * hundreds of milliseconds and a lot of memory inside a function that is
 * already holding the image. This walks the markers instead.
 *
 * Returns null when the format is unrecognised or truncated — callers then skip
 * the point prompt rather than sending a guessed coordinate, which would point
 * the model at the wrong part of the photo.
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  // PNG: 8-byte signature, then the IHDR chunk's width/height at 16..24.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const width = readUint32BE(bytes, 16);
    const height = readUint32BE(bytes, 20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // JPEG: SOI, then a chain of marker segments; the frame header (SOFn) carries
  // the dimensions. SOF4 (0xC4, DHT), SOF8 (0xC8) and SOF12 (0xCC, DAC) are not
  // frame headers and are skipped like any other segment.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1; // resync past fill bytes / padding
        continue;
      }
      const marker = bytes[offset + 1];
      // Standalone markers carry no length payload.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan
      const length = readUint16BE(bytes, offset + 2);
      if (length < 2) return null;
      const isFrameHeader =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isFrameHeader) {
        if (offset + 9 > bytes.length) return null;
        const height = readUint16BE(bytes, offset + 5);
        const width = readUint16BE(bytes, offset + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += 2 + length;
    }
  }

  return null;
}

/** Fractional point → integer pixel coordinate, clamped inside the frame. */
export function pointToPixels(point: ImagePoint, size: ImageSize): { x: number; y: number } {
  const x = Math.round(point.xPct * size.width);
  const y = Math.round(point.yPct * size.height);
  return {
    x: Math.min(size.width - 1, Math.max(0, x)),
    y: Math.min(size.height - 1, Math.max(0, y)),
  };
}

/** Strip a data-uri prefix and decode to bytes, or null if it isn't base64. */
export function dataUrlToBytes(value: string): Uint8Array | null {
  const base64 = value.replace(/^data:[^;,]*;base64,/, '');
  if (!base64 || /[^A-Za-z0-9+/=\s]/.test(base64)) return null;
  try {
    return Uint8Array.from(Buffer.from(base64, 'base64'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mask references
// ---------------------------------------------------------------------------

/**
 * Normalise whatever a backend called a mask into something fetchable.
 *
 * Accepts an http(s) url, a data uri, or bare base64 (which a Python handler
 * returning `base64.b64encode(png).decode()` produces, and which is the most
 * likely shape for a hand-rolled Modal endpoint). Bare base64 is assumed to be
 * PNG, because that is what a binary mask is written as.
 */
export function normaliseMaskRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:/i.test(trimmed)) return trimmed;
  // Bare base64 — require it to be long enough to be an image and to decode.
  if (trimmed.length < 64 || /[^A-Za-z0-9+/=\s]/.test(trimmed)) return null;
  return `data:image/png;base64,${trimmed.replace(/\s+/g, '')}`;
}

/** fal returns `{ url, content_type, ... }` objects; Modal might return a string. */
function maskRefFromAny(value: unknown): string | null {
  if (typeof value === 'string') return normaliseMaskRef(value);
  if (value && typeof value === 'object') {
    const url = (value as Record<string, unknown>).url;
    if (typeof url === 'string') return normaliseMaskRef(url);
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mask plausibility (conservative by default)
// ---------------------------------------------------------------------------

/**
 * A returned mask is not automatically a wound. A model that segments the whole
 * foot, the background, or two stray pixels still returns a mask with a
 * confident-looking score, and the tissue percentages measured inside it would
 * then be wrong in a way nothing downstream can see.
 *
 * These bounds are deliberately wide — they reject the failure modes (whole
 * frame / empty), not borderline clinical judgement.
 */
export const MIN_MASK_AREA_FRACTION = 0.0005; // 0.05 % of the frame
export const MAX_MASK_AREA_FRACTION = 0.6; // 60 % of the frame

export type MaskPlausibility = 'plausible' | 'empty' | 'too_small' | 'too_large';

export function maskPlausibility(areaPx: number, totalPx: number): MaskPlausibility {
  if (!Number.isFinite(areaPx) || areaPx <= 0 || totalPx <= 0) return 'empty';
  const fraction = areaPx / totalPx;
  if (fraction < MIN_MASK_AREA_FRACTION) return 'too_small';
  if (fraction > MAX_MASK_AREA_FRACTION) return 'too_large';
  return 'plausible';
}

export function describePlausibility(verdict: MaskPlausibility): string {
  switch (verdict) {
    case 'empty':
      return 'the model returned an empty mask';
    case 'too_small':
      return `the mask covers under ${MIN_MASK_AREA_FRACTION * 100}% of the frame`;
    case 'too_large':
      return `the mask covers over ${MAX_MASK_AREA_FRACTION * 100}% of the frame`;
    default:
      return 'the mask is a plausible size';
  }
}

// ---------------------------------------------------------------------------
// FUSegNet on Modal
// ---------------------------------------------------------------------------

/**
 * The request contract, verified against the deployed endpoint's own OpenAPI
 * schema (`GET {base}/openapi.json`, title "MendWise FUSegNet"):
 *
 *   POST {base}/segment
 *   { image_b64: string,          // JPEG/PNG base64; a data-uri prefix is allowed
 *     box?: [x0, y0, x1, y1],     // image pixels — see FUSEGNET_BOX note below
 *     size?: number,              // model input side, multiple of 32, default 512
 *     debug?: boolean }           // also returns an overlay PNG for eyeballing
 *   plus an optional `authorization` header the handler checks itself.
 *
 * `GET {base}/health` returns `{ ok, model, size }` and is the cheap liveness
 * check (it also warms a cold container).
 *
 * The response shape is *not* in the schema, so `parseFusegnetResponse` stays
 * tolerant about naming and `npm run check:segmentation` prints the endpoint's
 * actual keys — a mismatch is then a one-line `FUSEGNET_MASK_FIELD` fix.
 */
export const FUSEGNET_IMAGE_FIELD_DEFAULT = 'image_b64';

/**
 * The route the model is served at. `FUSEGNET_MODAL_URL` is normally the bare
 * `*.modal.run` origin, which 404s on its own — the FastAPI app mounts `/health`
 * and `/segment` beneath it. So the path is appended unless the configured URL
 * already has one, which also lets the whole endpoint be pinned in a single var.
 */
export const FUSEGNET_SEGMENT_PATH_DEFAULT = '/segment';
export const FUSEGNET_HEALTH_PATH = '/health';

/** Response keys searched, in order, for the binary wound mask. */
export const FUSEGNET_MASK_KEYS: readonly string[] = [
  'mask',
  'mask_png',
  'mask_base64',
  'mask_png_base64',
  'mask_url',
  'masks',
  'wound_mask',
  'segmentation',
  'output',
];

/** Response keys searched, in order, for a scalar confidence. */
export const FUSEGNET_SCORE_KEYS: readonly string[] = [
  'confidence',
  'score',
  'mean_probability',
  'mean_prob',
  'probability',
  'dice',
];

/** Response keys searched, in order, for a pixel area the model already counted. */
export const FUSEGNET_AREA_KEYS: readonly string[] = ['area_px', 'mask_area_px', 'wound_area_px', 'area'];

export const FUSEGNET_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Modal supports two auth shapes for a proxy-authed web endpoint: the
 * `Modal-Key` / `Modal-Secret` pair, or `Authorization: Bearer <id>.<secret>`.
 * We send the pair when both halves are present, fall back to a bearer token for
 * an endpoint doing its own check, and send nothing when neither is set (a public
 * endpoint — legal, and flagged in docs/SECURITY_AUDIT.md).
 */
export function modalAuthHeaders(env: Record<string, string | undefined>): Record<string, string> {
  if (env.MODAL_KEY && env.MODAL_SECRET) {
    return { 'Modal-Key': env.MODAL_KEY, 'Modal-Secret': env.MODAL_SECRET };
  }
  if (env.FUSEGNET_AUTH_TOKEN) return { Authorization: `Bearer ${env.FUSEGNET_AUTH_TOKEN}` };
  return {};
}

export type BackendRequest = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The exact request sent to the Modal endpoint, assembled in one place so the
 * adapter and `npm run check:segmentation` cannot drift apart. (The report
 * prompt was once duplicated between an endpoint and its test, and the test was
 * exercising a paraphrase — see docs/HANDOFF.md. Same mistake, avoided.)
 *
 * Returns null when FUSEGNET_MODAL_URL is unset.
 */
export function fusegnetRequest(
  env: Record<string, string | undefined>,
  imageDataUrl: string,
  /** `[x0, y0, x1, y1]` in pixels, when a caller has one. See `buildFusegnetBody`. */
  box?: readonly number[] | null,
): BackendRequest | null {
  if (!env.FUSEGNET_MODAL_URL) return null;
  const size = Number(env.FUSEGNET_SIZE);
  return {
    url: fusegnetUrl(env.FUSEGNET_MODAL_URL, env.FUSEGNET_SEGMENT_PATH ?? FUSEGNET_SEGMENT_PATH_DEFAULT),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...modalAuthHeaders(env) },
    body: JSON.stringify(
      buildFusegnetBody({
        imageDataUrl,
        imageField: env.FUSEGNET_IMAGE_FIELD,
        box: box ?? null,
        size: Number.isFinite(size) ? size : null,
      }),
    ),
    timeoutMs: positiveNumber(env.FUSEGNET_TIMEOUT_MS, FUSEGNET_DEFAULT_TIMEOUT_MS),
  };
}

export function buildFusegnetBody(args: {
  imageDataUrl: string;
  imageField?: string;
  /**
   * `[x0, y0, x1, y1]` in image pixels. The endpoint's own schema describes this
   * as coming "e.g. from SAM 3" — the deployment was built to be *refined after*
   * a box, not only run standalone.
   *
   * Nothing passes it yet: the chain is a fallback chain, so FUSegNet only runs
   * when SAM 3 did NOT produce anything to take a box from. Plumbed here because
   * it is part of the real contract, and because a SAM-3-box → FUSegNet-mask
   * refinement pass is the obvious next step once the eval set exists.
   */
  box?: readonly number[] | null;
  /** Model input side; must be a multiple of 32. The endpoint defaults to 512. */
  size?: number | null;
  /** Ask for an overlay PNG as well. Diagnostics only — never the measured mask. */
  debug?: boolean;
  /** Harmless extra keys are ignored by FastAPI-style handlers. */
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const field = args.imageField?.trim() || FUSEGNET_IMAGE_FIELD_DEFAULT;
  const body: Record<string, unknown> = { [field]: args.imageDataUrl };
  if (args.box && args.box.length === 4 && args.box.every((n) => Number.isFinite(n))) {
    body.box = args.box.map((n) => Math.round(n));
  }
  if (typeof args.size === 'number' && Number.isFinite(args.size) && args.size > 0) {
    body.size = Math.round(args.size);
  }
  if (args.debug) body.debug = true;
  return { ...body, ...(args.extra ?? {}) };
}

/**
 * Join the configured origin with a route. A URL that already carries a path is
 * left alone, so one var can pin the whole endpoint.
 */
export function fusegnetUrl(rawUrl: string, path: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname && parsed.pathname !== '/') return trimmed;
  } catch {
    return trimmed;
  }
  return `${trimmed}${path}`;
}

/** `GET {base}/health` — liveness, the loaded model's name, and its input size. */
export function fusegnetHealthUrl(env: Record<string, string | undefined>): string | null {
  const base = env.FUSEGNET_MODAL_URL;
  return base ? fusegnetUrl(base, FUSEGNET_HEALTH_PATH) : null;
}

export type FusegnetParsed = {
  mask: string | null;
  score: number | null;
  areaPx: number | null;
  /** Top-level keys of the response — surfaced so a contract mismatch is legible. */
  keys: string[];
};

export function parseFusegnetResponse(json: unknown, maskField?: string | null): FusegnetParsed {
  if (!json || typeof json !== 'object') return { mask: null, score: null, areaPx: null, keys: [] };
  const body = json as Record<string, unknown>;
  const keys = Object.keys(body);

  // An explicit override wins; otherwise try the known spellings in order.
  const candidates = maskField?.trim() ? [maskField.trim(), ...FUSEGNET_MASK_KEYS] : FUSEGNET_MASK_KEYS;

  let mask: string | null = null;
  for (const key of candidates) {
    const value = body[key];
    mask = maskRefFromAny(value);
    if (mask) break;
    // Some handlers return a list even for a single-mask model.
    if (Array.isArray(value)) {
      for (const item of value) {
        mask = maskRefFromAny(item);
        if (mask) break;
      }
      if (mask) break;
    }
  }

  return {
    mask,
    score: firstNumber(body, FUSEGNET_SCORE_KEYS),
    areaPx: firstNumber(body, FUSEGNET_AREA_KEYS),
    keys,
  };
}

// ---------------------------------------------------------------------------
// SAM 3 on fal.ai
// ---------------------------------------------------------------------------

export const SAM3_FAL_MODEL_DEFAULT = 'fal-ai/sam-3/image';

/**
 * The concept prompt. SAM 3's headline capability is that it takes a noun phrase
 * and returns every instance of it, which is exactly the "text-prompt 'wound' →
 * box → mask" step the build spec lists as the optional V2 of segmentation (§3).
 * SAM 3 does it in one call, so there is no Grounding DINO stage to add.
 */
export const SAM3_PROMPT_DEFAULT = 'wound';

/**
 * Build the fal input. Verified against the published `fal-ai/sam-3/image`
 * schema (Sam3ImageInput): image_url, prompt, point_prompts[{x,y,label,object_id}],
 * box_prompts, apply_mask, sync_mode, output_format, return_multiple_masks,
 * max_masks, include_scores, include_boxes.
 *
 * `apply_mask: false` matters: with it true, fal composites the mask onto the
 * photograph, and a composited photo fed to the HSI tissue classifier would be
 * measured as if it were tissue. We want the raw binary masks.
 */
export function buildSam3Input(args: {
  imageDataUrl: string;
  prompt?: string;
  point?: ImagePoint | null;
  size?: ImageSize | null;
  maxMasks?: number;
  syncMode?: boolean;
}): Record<string, unknown> {
  const maxMasks = Number.isFinite(args.maxMasks) ? Math.min(32, Math.max(1, Number(args.maxMasks))) : 4;
  const input: Record<string, unknown> = {
    // fal accepts a data uri anywhere it accepts a file url, so the image never
    // has to be uploaded to a third-party bucket first.
    image_url: args.imageDataUrl,
    prompt: args.prompt?.trim() || SAM3_PROMPT_DEFAULT,
    apply_mask: false,
    output_format: 'png',
    return_multiple_masks: true,
    max_masks: maxMasks,
    include_scores: true,
    sync_mode: Boolean(args.syncMode),
  };

  // The point prompt is additive: it only goes in when we know the pixel
  // dimensions, because `point_prompts` are pixel coordinates and a fractional
  // value sent as one would land in the top-left corner of the image.
  if (args.point && args.size) {
    const { x, y } = pointToPixels(args.point, args.size);
    input.point_prompts = [{ x, y, label: 1 }];
  }

  return input;
}

export type Sam3Parsed = {
  masks: string[];
  /** Per-mask confidence, aligned with `masks`, or null when fal didn't return any. */
  scores: number[] | null;
  keys: string[];
};

export function parseSam3Response(json: unknown): Sam3Parsed {
  if (!json || typeof json !== 'object') return { masks: [], scores: null, keys: [] };
  const body = json as Record<string, unknown>;
  const keys = Object.keys(body);

  const masks: string[] = [];
  const raw = Array.isArray(body.masks) ? body.masks : [];
  for (const item of raw) {
    const ref = maskRefFromAny(item);
    if (ref) masks.push(ref);
  }
  // Single-mask responses sometimes only populate `image`.
  if (masks.length === 0) {
    const single = maskRefFromAny(body.image);
    if (single) masks.push(single);
  }

  // Scores are only usable if they line up with `masks` INDEX FOR INDEX — they
  // are how a mask gets chosen. Dropping a null mid-array would shift every
  // later score onto the wrong mask and quietly pick the wrong boundary, so a
  // ragged or short array is discarded entirely rather than partially trusted.
  const raws = Array.isArray(body.scores)
    ? body.scores
    : Array.isArray(body.metadata)
      ? // `metadata` is the per-mask carrier when include_boxes is also set.
        body.metadata.map((m) =>
          m && typeof m === 'object' ? firstNumber(m as Record<string, unknown>, ['score']) : null,
        )
      : [];
  const aligned = raws.filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  const scores = aligned.length > 0 && aligned.length === masks.length ? aligned : null;

  return { masks, scores, keys };
}

export const SAM3_DEFAULT_TIMEOUT_MS = 60_000;
export const SAM3_FAL_BASE = 'https://fal.run';

/**
 * The exact request sent to fal, assembled in one place for the adapter and the
 * probe script alike. Returns null when FAL_KEY is unset.
 *
 * `imageBytes` is optional: it is only used to read the pixel dimensions needed
 * to place a point prompt. Without it, the concept prompt goes alone.
 */
export function sam3Request(
  env: Record<string, string | undefined>,
  args: { imageDataUrl: string; point?: ImagePoint | null; imageBytes?: Uint8Array | null },
): BackendRequest | null {
  if (!env.FAL_KEY) return null;
  const model = env.SAM3_FAL_MODEL ?? SAM3_FAL_MODEL_DEFAULT;
  const size = args.imageBytes ? imageSize(args.imageBytes) : null;
  return {
    url: `${SAM3_FAL_BASE}/${model}`,
    method: 'POST',
    headers: {
      // fal's scheme is `Key <token>`, not `Bearer <token>`.
      Authorization: `Key ${env.FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      buildSam3Input({
        imageDataUrl: args.imageDataUrl,
        prompt: env.SAM3_PROMPT,
        point: args.point ?? null,
        size,
        maxMasks: Number(env.SAM3_MAX_MASKS ?? 4),
        syncMode: env.SAM3_SYNC_MODE === 'true',
      }),
    ),
    timeoutMs: positiveNumber(env.SAM3_TIMEOUT_MS, SAM3_DEFAULT_TIMEOUT_MS),
  };
}

/** Index of the highest score, or null when there is nothing to rank. */
export function highestScoreIndex(scores: number[] | null | undefined): number | null {
  if (!scores || scores.length === 0) return null;
  let best = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i] > scores[best]) best = i;
  }
  return best;
}

/**
 * Score → confidence band. Deliberately coarse: the engine only consumes three
 * bands, and a model's scalar score is not calibrated to anything clinical.
 * A missing score is `medium`, never `high` — absence of evidence is not
 * evidence of a good boundary.
 */
export const SCORE_HIGH_THRESHOLD = 0.5;

export function confidenceFromScore(score: number | null | undefined): MaskConfidence {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'medium';
  return score >= SCORE_HIGH_THRESHOLD ? 'high' : 'medium';
}
