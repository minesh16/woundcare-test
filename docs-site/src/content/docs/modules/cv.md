---
title: CV module
description: OpenCV pipeline, tissue classification, measurement, SAM 2 client, and platform splits.
---

Path: [`src/cv/`](https://github.com/minesh16/woundcare-test/tree/main/src/cv)

The capture-time vision stack. Native runs OpenCV on-device; web POSTs the same job to `/api/analyze`. SAM 2 is additive and flag-gated.

<!-- docs-hook:auto:start:files -->
| File | Role |
|---|---|
| `tissueClassifier.ts` | HSV (named HSI in the product docs) pixel classes + `breakdownFromBuffer` |
| `measureArea.ts` | 20c coin calibration, `pxPerCmFromMarkerSide` (ArUco-ready, unused) |
| `opencvPipeline.ts` | Orchestrates native / web / fallback `analyzeWoundImage` |
| `opencvNative.ts` | Stub Metro falls through from; real impls are platform files |
| `opencvNative.native.ts` | `react-native-fast-opencv` pipeline; passes wound mask into tissue % |
| `opencvNative.web.ts` | Throws — web must not pretend to have on-device OpenCV |
| `segment.ts` | Client for `POST /api/segment` (SAM 2), no-op unless `assessmentV2` |
<!-- docs-hook:auto:end:files -->

## Key exports

### `tissueClassifier.ts`

- `classifyPixel(r,g,b)` → `granulation | slough | necrosis | epithelial | other`
- `breakdownFromBuffer(buffer, channels, woundMask?)` — pixels with `woundMask[i] === 0` are **skipped** (not counted as `other`). Empty considered-set currently returns a uniform 20% stub.
- `toPercentages(breakdown)`
- `classifyPeriwoundPixel` → `red | macerated | normal` (first-pass thresholds; **not validated across skin tones**)

Epithelial is checked before slough/granulation so pale-pink new skin is not counted as granulation.

### `measureArea.ts`

- `COIN_DIAMETER_CM = 2.852`, `COIN_AREA_CM2`
- `px2ToCm2`, `pxPerCmFromCoinAreaPx2`, `formatArea`
- `pxPerCmFromMarkerSide(markerSidePx, markerSideCm)` — ready; nothing calls it yet

### `opencvPipeline.ts`

- `uriToBase64` — resize to width 1024 JPEG via `expo-image-manipulator`
- `analyzeWoundImage` / `analyzeWoundBase64` — web → `EXPO_PUBLIC_ANALYZE_URL` default `/api/analyze`; native → `runOpenCvPipeline`; both catch and use `runFallbackPipeline`

### `segment.ts`

- `segmentWoundBase64` / `segmentWoundUri` → `SegmentResult | null`
- Returns `null` when the flag is off or the request fails (conservative)

## Wiring

`analyze.tsx` always calls `analyzeWoundImage`, then `segmentWoundUri(..., result.hsvCentroid)`. The overlay is the SAM mask when present.

Server-side duplicates of the tissue math live in `api/analyze.ts`, `api/_tissueOps.ts`, and `api/v1/assessments/tissue.ts` so Vercel functions do not import Metro-only native modules.
