# MendWise — Build Handoff (current state → next steps)

**Read first:** [MendWise_Assessment_Build_Spec.md](./MendWise_Assessment_Build_Spec.md) — the full architecture, API, data flow and phases. This file is the *current state* and the *next task*.

**Repo:** `/Users/minesh/Agents/woundcare-test` (Expo React Native + Expo-web on Vercel).
**Deadlines:** Assessment 3 (product architecture + MVP) due **25 Sep 2026**; pitch **13 Oct 2026**.

---

## The cage (non-negotiable invariants)

1. **Determinism is authoritative.** The CWCS 26-pathway table + Mölnlycke triggers (`src/decision/engine.ts`) make the dressing/referral decision. AI only produces *inputs* and *narrates* outputs — it never emits a pathway.
2. **AI is caged.** SAM 2 = boundary; OpenCV HSI = tissue %; frontier VLM = strict-JSON enums only (`generateObject` + Zod, `temperature: 0`); frontier LLM = report from already-decided facts.
3. **Additive, never destructive.** New work sits behind an `assessmentV2` flag + `/api/v1/assessments/*`. The existing HSV flow stays as capture quality-gate + offline fallback + SAM prompt-seed.
4. **Conservative by default.** No marker / low confidence / conflicting signals → "incomplete → retake or escalate", never a confident dressing call.
5. **No model fine-tuning.** Zero-shot SAM 2 + frontier VLM/LLM only.

---

## DONE — Phase 0 (deterministic engine + tests)

- `src/decision/engine.types.ts` — engine types (erased at runtime; import via `import type`).
- `src/decision/engine.ts` — **the whole engine, one self-contained runtime file**:
  - `CWCS_PATHWAYS` — all **26 pathways** (tissue × exudate × infection → primary/secondary), version `cwcs-2024.1`.
  - `lookupPathway`, `getPathwayById` — CWCS lookup.
  - `reconcileTissue` — precedence **necrotic > slough > granulating > epithelialising**; necrotic split into ischaemic/non-ischaemic by perfusion; presence threshold `TISSUE_PRESENCE_THRESHOLD = 10`.
  - `molnlyckeFlags` — 10-step referral triggers (probe-to-bone, systemic/spreading infection, ABPI<0.5, ABPI>1.4→TBPI, DFU, LOPS, black-necrotic→MDT), urgency-ordered.
  - `evaluate` — `reconcile → flags → CWCS lookup → merge`, with completeness + confidence gates.
- `scripts/test-rules.mts` — **66 assertions, all green.** Run: `npm run test:rules`.
- Wired non-destructively into `src/decision/rules.ts` (`assess()` now returns the CWCS pathway + referrals; `AssessmentResult` gained optional fields), so every existing screen still compiles and renders.

**Verify:** `npm run test:rules` (66/66) and `npm run typecheck` (clean on Phase-0 files).

### Known issues / carry-overs
- ⚠️ **Verify the 26 dressing strings in `engine.ts` against the source PDF** (`CWCS Choice Guide_6524.pdf`) before any graded submission — transcribed from the page image.
- Pre-existing, unrelated typecheck error in `src/components/app-tabs.web.tsx` (stale `/explore` route) — not from Phase 0.
- Engine is intentionally one runtime file so it runs under `node --experimental-strip-types` with no build step. Keep runtime cross-file imports out of it, or the test's Node type-stripping will need explicit `.ts` extensions.

---

## IN PROGRESS — Phase 1 (segmentation + measurement)

Goal: replace demo HSV with SAM 2 boundary + HSI tissue-% inside the mask + real cm² via a reference marker, and add photo-upload.

1. ✅ **SAM 2 endpoint (Replicate, direct — NOT via AI Gateway)** — `api/segment.ts` (Vercel Node) + `api/_sam2.ts` adapter, gated by `assessmentV2`. Returns `{ source, mask, combinedMask, masks, selection, confidence, point, model }`. **Degrades conservatively** to `source:'unavailable'` (→ existing HSV mask) when `REPLICATE_API_TOKEN` is unset or the call fails.
   - **Why not the gateway:** the Vercel AI Gateway only serves text/image/video/speech/embeddings/reranking models (Replicate is not a gateway provider). SAM 2 (segmentation) is off-gateway by design — the Vercel↔Replicate integration simply provisions `REPLICATE_API_TOKEN` into the project, which the adapter reads directly.
   - **Replicate call shape:** `meta/sam-2` is a **versioned** (community-style) model, *not* a Replicate "official" model, so the adapter resolves the latest version via `GET /v1/models/{model}` (cached) and creates the prediction via `POST /v1/predictions` with `{ version, input }` + `Prefer: wait`. (The official-model endpoint `POST /v1/models/{owner}/{name}/predictions` returns **404** for versioned models — this was the initial prod bug.) Pin with `SAM2_REPLICATE_VERSION` to skip the lookup.
   - **Model note:** `meta/sam-2` is the *automatic* mask generator — verified schema: input `{ image, points_per_side, pred_iou_thresh, stability_score_thresh, use_m2m }`; output `{ combined_mask, individual_masks }`. **No point/box prompt input.**
   - ✅ **Wound-mask selection (Option 1)** — `api/_maskSelect.ts` (uses `pngjs`) fetches + decodes `individual_masks`, keeps masks whose pixel at the HSV centroid (`CvResult.hsvCentroid`) is set, and picks the **smallest** (tight wound vs whole-image blob). `segment.ts` returns `mask` = selected wound mask (else `combinedMask`), plus `selection {index, maskUrl, areaPx}`; selected → confidence `high`. Conservative: decode/fetch failures skipped, no match → `combinedMask`, all failure → HSV fallback.
   - **Deploy status:** shipped to prod (`mendwise`) via a **clean Git deployment** (project is *not* Git-connected; deploy triggered from `main` through the Vercel API — local `vercel deploy`/"Redeploy" fails with `source_archive_invalid_symlink` because the local `ios/Pods` tree contains an absolute symlink). `/api/segment` verified reachable in prod; `REPLICATE_API_TOKEN` present.
   - **Remaining:** set `EXPO_PUBLIC_ASSESSMENT_V2=true` in Vercel Production (build-time inlined → needs a rebuild) so the client actually calls `/api/segment`; render the selected mask overlay on the photo in `analyze.tsx` (currently a text summary); tune `SAM2_POINTS_PER_SIDE` / `SAM2_MAX_MASKS` for latency; **connect Git** in Vercel (mendwise → Settings → Git) so pushes auto-deploy; optional future: swap `SAM2_REPLICATE_MODEL` to a point-promptable model to drop selection entirely.
2. ✅ **Marker calibration** — `pxPerCmFromCoinAreaPx2` / `pxPerCmFromMarkerSide` in `src/cv/measureArea.ts`; `CvResult.pxPerCm` threaded through web + native pipelines + analyze UI. (ArUco detection itself not yet wired — coin path live; `pxPerCmFromMarkerSide` ready for it.)
3. ✅ **HSI tissue-% + `epithelial` class** — added to `classifyPixel`/`TissueBreakdown`/`toPercentages` (`tissueClassifier.ts`), threaded through `CvResult` → analyze UI → `rules.ts` (`epithelial` now real, no longer `0`).
4. ✅ **Perfusion + real infection inputs** — `perfusion`, `abpiBand`, `infectionSigns`, `spreadingRedness` added to `QuestionnaireAnswers` + `questions.tsx` (optional, non-blocking). `rules.ts → toEngineInputs` now feeds real `perfusion`, `molnlycke.abpi`, `molnlycke.spreadingErythemaOver2cm`, and an explicit `infection` axis (proxy retained only as fallback).
5. ✅ **Photo upload** — already present in `capture.tsx` (`pickFromGallery` via `expo-image-picker`), same downstream analyze/quality path as camera.

**Flag:** `EXPO_PUBLIC_ASSESSMENT_V2=true` enables the SAM 2 pass (`src/config/featureFlags.ts`). Default OFF keeps the existing demo flow byte-for-byte unchanged.

**Acceptance:** marker-in-frame image returns plausible `px_per_cm` + `wound_area_cm2` within tolerance of a hand-measured control (needs a physical control shot); camera and upload both produce a mask (HSV today; SAM 2 once token set); engine consumes real tissue/perfusion/infection ✅.

**Verify:** `npm run test:rules` (66/66) ✅ and `npm run typecheck` (only the pre-existing `app-tabs.web.tsx` error) ✅.

Phases 2 (caged VLM via Vercel AI Gateway + report LLM + orchestrator) and 3 (SSE `run` + demo) follow — see the build spec §9.

---

## Paste-into-Cursor prompt (Composer / agent)

> You are continuing the MendWise wound-assessment app. Read `docs/MendWise_Assessment_Build_Spec.md` and `docs/HANDOFF.md` first, and obey the cage invariants (determinism authoritative; AI caged; additive behind `assessmentV2`; no fine-tuning). Phase 0 (the deterministic CWCS/Mölnlycke engine in `src/decision/engine.ts` + `scripts/test-rules.mts`) is DONE and green — do not regress it (`npm run test:rules` must stay 66/66; `npm run typecheck` must not add errors). Implement **Phase 1** (SAM 2 boundary via a Replicate/Modal endpoint + `api/segment.ts`, HSV-centroid prompt with tap fallback, ArUco/coin cm² calibration, HSI tissue-% with a new `epithelial` class threaded through `CvResult` + UI, ABPI/perfusion + explicit infection questionnaire inputs, and photo upload). Keep the existing demo flow working. Before writing Expo code, check the versioned docs at https://docs.expo.dev/versions/v57.0.0/ (see `AGENTS.md`). Show me a short plan before large edits.
