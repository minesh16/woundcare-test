---
title: Legacy API
description: /api/analyze, /api/segment, the SAM 3 / FUSegNet provider chain, mask selection, shared tissue ops, OpenCV.js loader.
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
| `_sam3.ts` | (library) | fal.ai `fal-ai/sam-3/image` adapter (concept prompt) |
| `_fusegnet.ts` | (library) | Modal adapter (wound-specific CNN) |
| `_maskSelect.ts` | (library) | Smallest mask containing the HSV centroid; `maskStats()` |
| `_tissueOps.ts` | (library) | `PERIWOUND_BAND_CM = 4`, `measurePeriwound`, `countMaskPixels` |
<!-- docs-hook:auto:end:files -->

## The provider chain

`SEGMENTATION_PROVIDERS` (comma-separated) sets the order. Default `sam3,fusegnet`. An unknown name is dropped rather than throwing; an all-unknown value falls back to the default, because a typo in an env var must not disable segmentation.

| Order | Provider | Prompt | Returns | Env |
|---|---|---|---|---|
| 1 | `sam3` | text concept `"wound"` + a pixel point | every match, with scores | `FAL_KEY` |
| 2 | `fusegnet` | none — the model only segments wounds | one binary mask | `FUSEGNET_MODAL_URL` |

Below both, the fallback is the on-device HSV mask.

SAM 3 leads because FUSegNet is the more *specific* model, not the more *general* one: it is trained on chronic **foot** ulcers, so it is the preferred boundary for DFUs and an unknown quantity on a venous leg ulcer or a pressure injury. Leading with the generalist is the conservative order until the golden eval set settles it — and that is then one env var, not a code change. SAM 3's concept prompt is also why the old "Grounding DINO → box → SAM 2" plan is unnecessary.

:::note[SAM 2 was removed, not demoted]
SAM 2 on Replicate (`meta/sam-2`) used to be a third provider. It was the *automatic* mask generator — no prompt input at all — so it segmented every object in frame and the wound had to be recovered afterwards by HSV centroid. It did not work well enough to keep even as a fallback. `api/_sam2.ts`, `REPLICATE_API_TOKEN` and the `SAM2_*` vars are gone, and **Replicate is no longer a processor** — which matters for the processor register (`docs/SECURITY_AUDIT.md` MW-07).
:::

Each provider's failure is **recorded, not swallowed** — `attempts: [{provider, status, ms, reason}]` is in the response, the SSE step summary and `audit_log.models.segmentationProvider`. A boundary from the third fallback should not look identical to one from the first.

### A mask is measured before it is trusted

`maskPlausibility` rejects a mask covering under **0.05%** or over **60%** of the frame and falls through to the next provider. This is not cosmetic: a mask of the whole limb rescales every tissue percentage, and nothing downstream can detect it — the CWCS tissue axis simply comes out wrong.

### Backend specifics worth not rediscovering

- **fal auth is `Authorization: Key <FAL_KEY>`**, not `Bearer`.
- **`apply_mask: false`** on the fal request. With it true, fal composites the mask onto the photo, and the HSI classifier would measure the composite as tissue.
- **SAM 3's `point_prompts` are pixels.** Every point in this app is fractional so it survives resizing, so `imageSize()` reads the real dimensions from the JPEG/PNG header (markers, not a full decode) and the point is **omitted** when the header is unreadable. A fraction sent as a pixel coordinate lands in the top-left corner and still returns a confident mask.
- **Modal proxy auth** is the `Modal-Key` + `Modal-Secret` pair, or `Authorization: Bearer <id>.<secret>`; `FUSEGNET_AUTH_TOKEN` covers an endpoint that checks its own token.
- **The FUSegNet response is not in its schema** (declared as an untyped object), so it was read off a live call:

  ```json
  { "mask_png_b64": "<bare base64 PNG>", "area_px": 3346, "mean_prob": 0.95,
    "regions": { "regions_found": 3, "regions_kept": 1, "regions_dropped": 2,
                 "multiple_regions": false, "min_region_px": 50 },
    "width": 256, "height": 256, "crop": [0, 0, 256, 256], "size": 512,
    "model": "fusegnet-effb7-pscse", "latency_ms": 1162 }
  ```

  `model` goes into `audit_log.models.segmentation` — the endpoint knows which weights ran and we don't. `regions.multiple_regions` is recorded as `multipleRegions` and deliberately not acted on. `crop` echoes the box the model ran on. `parseFusegnetResponse` stays tolerant anyway, and `FUSEGNET_MASK_FIELD` overrides it.
- **`box` (`[x0,y0,x1,y1]` pixels) exists on the FUSegNet request** and its schema describes it as coming "e.g. from SAM 3" — the endpoint was built to be refined after a box. Nothing passes one yet, because in a fallback chain FUSegNet only runs when SAM 3 produced nothing. A SAM 3 box → FUSegNet mask refinement pass is the obvious next architecture.
- **`FUSEGNET_MODAL_URL` is the bare `*.modal.run` origin, and it 404s on its own.** The FastAPI app mounts `/health` and `/segment` beneath it, so `fusegnetUrl()` appends the route unless the configured URL already has a path. `FUSEGNET_SEGMENT_PATH` overrides it. This cost the first live probe.
- **The FUSegNet request field is `image_b64`** and the response field is **`mask_png_b64`** (bare base64, no data-uri prefix). Neither is what you would guess; `mask_png_base64` was in the first tolerance list and did not match.
- **Hit `GET {base}/health` first.** It is free, names the loaded weights (`FUSegNet (efficientnet-b7, pscse)`, size 512) and warms a cold container, so the first real call does not absorb a model load and time out.

### Checking it

- `npm run test:segmentation` — 123 offline assertions over the wire formats, including the real FUSegNet response shape.
- `npm run check:segmentation` — a real call per configured provider, using the **same request builders** as the adapters, so a pass means the pipeline's request works. On an unparseable response it prints the endpoint's actual top-level keys. `--image=photo.jpg` to probe with a real wound.

`_maskSelect.ts` is no longer load-bearing — FUSegNet returns one mask — but it is still the disambiguator when SAM 3's concept prompt matches several regions.

### Verified live, 3 Oct 2026

Both providers pass end to end.

- **SAM 3**: one mask at score 0.803, fetched and decoded at 8,111 px against ~8,090 px of known ellipse geometry in the probe image. That 0.3% agreement is the proof `apply_mask: false` returns a **binary mask** rather than a composited photo. 1.0–3.5 s typical.
- **FUSegNet**: `/segment` 200 in ~2.1 s, mask decodes to **3,346 px — exactly its own reported `area_px`**, which cross-checks the decode path. `/health` 1.4 s warm, 12.5–13.4 s cold.

:::caution[FUSegNet has no abstain — and this is the important result]
The probe image contains an ellipse and no wound. SAM 3 correctly returned **no match** for `"wound"`. FUSegNet returned a 3,346 px mask at `mean_prob` **0.95**, and would do the same on a photo of a carpet.

So `mean_prob` means "how sure the network is about the pixels it chose", **not** "is there a wound here". In this codebase it can only ever *downgrade* confidence — it can never establish that a boundary is real. That makes the plausibility gate load-bearing rather than defensive decoration, and it is a second independent argument for SAM 3 leading, alongside the foot-ulcer one.
:::

<!-- docs-hook: last auto-checked against commit ea3f028 on 2026-10-03 -->
