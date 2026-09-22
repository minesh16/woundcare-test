---
title: Legacy API
description: /api/analyze, /api/segment, SAM 2 adapter, mask selection, shared tissue ops, OpenCV.js loader.
---

Path: [`api/`](https://github.com/minesh16/woundcare-test/tree/main/api) (root-level handlers, not `v1/`)

These remain because the original web flow and the SAM 2 client still call them. Shared helpers (`_sam2`, `_maskSelect`, `_tissueOps`, `cv`) are also imported by `/api/v1/assessments/*`.

If you touch anything under `api/`, read [Production status — deployment gotchas](/docs/operations/status/#if-you-are-touching-api-read-this-first) first.

<!-- docs-hook:auto:start:files -->
| File | HTTP | Role |
|---|---|---|
| `analyze.ts` | `POST /api/analyze` | Web OpenCV.js HSV + tissue (mask-restricted) + coin Hough + periwound |
| `segment.ts` | `POST /api/segment` | SAM 2 + centroid mask selection |
| `cv.ts` | (library) | `loadCv()` — OpenCV.js WASM singleton |
| `_sam2.ts` | (library) | Replicate `meta/sam-2` adapter |
| `_maskSelect.ts` | (library) | Smallest individual mask containing HSV centroid |
| `_tissueOps.ts` | (library) | `PERIWOUND_BAND_CM = 4`, `measurePeriwound`, `countMaskPixels` |
<!-- docs-hook:auto:end:files -->

## Replicate call shape

`meta/sam-2` is a **versioned** model. `_sam2.ts` resolves the latest version via `GET /v1/models/{model}` (cached) and creates the prediction with `POST /v1/predictions` + `{ version, input }` + `Prefer: wait`. The official-model endpoint returns **404** for versioned models. Pin with `SAM2_REPLICATE_VERSION` to skip the lookup.

Env: `REPLICATE_API_TOKEN` (required), `SAM2_REPLICATE_MODEL` (default `meta/sam-2`), `SAM2_POINTS_PER_SIDE`, `SAM2_MAX_MASKS`. Tuning those for latency is [roadmap](/docs/roadmap/).

`_maskSelect.ts` is the reason a point-promptable model is desirable later — it could be deleted if SAM accepted a point/box.
