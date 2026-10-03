---
title: Legacy API
description: /api/analyze, /api/segment, the FUSegNet / SAM 3 / SAM 2 provider chain, mask selection, shared tissue ops, OpenCV.js loader.
---

Path: [`api/`](https://github.com/minesh16/woundcare-test/tree/main/api) (root-level handlers, not `v1/`)

These remain because the original web flow and the segmentation client still call them. Shared helpers (`_segmentation`, `_maskSelect`, `_tissueOps`, `cv`) are also imported by `/api/v1/assessments/*`.

If you touch anything under `api/`, read [Production status — deployment gotchas](/docs/operations/status/#if-you-are-touching-api-read-this-first) first.

<!-- docs-hook:auto:start:files -->
| File | HTTP | Role |
|---|---|---|
| `analyze.ts` | `POST /api/analyze` | Web OpenCV.js HSV + tissue (mask-restricted) + coin Hough + periwound |
| `segment.ts` | `POST /api/segment` | Wound boundary via the provider chain |
| `cv.ts` | (library) | `loadCv()` — OpenCV.js WASM singleton |
| `_segmentation.ts` | (library) | The chain: try → measure → reject → fall through, with `attempts` |
| `_segmentationParse.ts` | (library) | **Import-free.** Provider order, image-header reader, request builders, response parsers, plausibility bounds |
| `_fusegnet.ts` | (library) | Modal adapter (wound-specific CNN) |
| `_sam3.ts` | (library) | fal.ai `fal-ai/sam-3/image` adapter (concept prompt) |
| `_sam2.ts` | (library) | Replicate `meta/sam-2` adapter (last fallback) |
| `_maskSelect.ts` | (library) | Smallest mask containing the HSV centroid; `maskStats()` |
| `_tissueOps.ts` | (library) | `PERIWOUND_BAND_CM = 4`, `measurePeriwound`, `countMaskPixels` |
<!-- docs-hook:auto:end:files -->

## The provider chain

`SEGMENTATION_PROVIDERS` (comma-separated) sets the order. Default `fusegnet,sam3,sam2`. An unknown name is dropped rather than throwing; an all-unknown value falls back to the default, because a typo in an env var must not disable segmentation.

| Order | Provider | Prompt | Returns | Env |
|---|---|---|---|---|
| 1 | `fusegnet` | none — the model only segments wounds | one binary mask | `FUSEGNET_MODAL_URL` |
| 2 | `sam3` | text concept `"wound"` + a pixel point | every match, with scores | `FAL_KEY` |
| 3 | `sam2` | none — automatic generator | everything in the frame | `REPLICATE_API_TOKEN` |

FUSegNet leads because it is the only one trained on wounds: a wound-specific mask needs no disambiguation. SAM 3 is the generalist second choice, and its concept prompt is why the old "Grounding DINO → box → SAM 2" plan is unnecessary. SAM 2 stays as the third fallback.

Each provider's failure is **recorded, not swallowed** — `attempts: [{provider, status, ms, reason}]` is in the response, the SSE step summary and `audit_log.models.segmentationProvider`. A boundary from the third fallback should not look identical to one from the first.

### A mask is measured before it is trusted

`maskPlausibility` rejects a mask covering under **0.05%** or over **60%** of the frame and falls through to the next provider. This is not cosmetic: a mask of the whole limb rescales every tissue percentage, and nothing downstream can detect it — the CWCS tissue axis simply comes out wrong.

### Backend specifics worth not rediscovering

- **fal auth is `Authorization: Key <FAL_KEY>`**, not `Bearer`.
- **`apply_mask: false`** on the fal request. With it true, fal composites the mask onto the photo, and the HSI classifier would measure the composite as tissue.
- **SAM 3's `point_prompts` are pixels.** Every point in this app is fractional so it survives resizing, so `imageSize()` reads the real dimensions from the JPEG/PNG header (markers, not a full decode) and the point is **omitted** when the header is unreadable. A fraction sent as a pixel coordinate lands in the top-left corner and still returns a confident mask.
- **Modal proxy auth** is the `Modal-Key` + `Modal-Secret` pair, or `Authorization: Bearer <id>.<secret>`; `FUSEGNET_AUTH_TOKEN` covers an endpoint that checks its own token.
- **The FUSegNet response contract is adaptable without a code change.** `parseFusegnetResponse` tries several key spellings and accepts an http url, a data uri or bare base64; `FUSEGNET_MASK_FIELD` / `FUSEGNET_IMAGE_FIELD` override the request and response field names.
- `meta/sam-2` is a **versioned** Replicate model: `_sam2.ts` resolves the latest version via `GET /v1/models/{model}` (cached) and creates the prediction with `POST /v1/predictions` + `{ version, input }` + `Prefer: wait`. The official-model endpoint returns **404** for versioned models. Pin with `SAM2_REPLICATE_VERSION`.

### Checking it

- `npm run test:segmentation` — 96 offline assertions over the wire formats.
- `npm run check:segmentation` — a real call per configured provider, using the **same request builders** as the adapters, so a pass means the pipeline's request works. On an unparseable response it prints the endpoint's actual top-level keys. `--image=photo.jpg` to probe with a real wound.

`_maskSelect.ts` is no longer load-bearing — FUSegNet returns one mask — but it is still the disambiguator when SAM 3's concept prompt matches several regions.

<!-- docs-hook: last auto-checked against commit e8cef6a on 2026-10-03 -->
