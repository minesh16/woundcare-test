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

## NEXT — Phase 1 (segmentation + measurement)  [start here]

Goal: replace demo HSV with SAM 2 boundary + HSI tissue-% inside the mask + real cm² via a reference marker, and add photo-upload.

1. **SAM 2 endpoint** — host on Replicate (fastest) or Modal; add `api/segment.ts` (Vercel Node) that calls it. Prompt point = HSV centroid (reuse `src/cv/tissueClassifier.ts` / `opencvPipeline.ts`) with a user-tap fallback. Return `{ mask, confidence }`.
2. **Marker calibration** — detect ArUco/coin → `px_per_cm` → wound area cm² (extend `src/cv/measureArea.ts`).
3. **HSI tissue-% inside the mask** — upgrade `tissueClassifier.ts`; **add the `epithelial` class** (currently `rules.ts` passes `epithelial: 0`), and thread it through `CvResult` + the analyze UI.
4. **Perfusion + real infection inputs** — collect ABPI/perfusion + explicit infection signs in the questionnaire so `reconcileTissue`/`molnlyckeFlags` get real values (they're stubbed to `perfusion: 'unknown'` and a provisional infection proxy in `rules.ts` → `toEngineInputs`).
5. **Photo upload** — add gallery/file upload alongside camera (repo already has `expo-image-picker`); same quality gate.

**Acceptance:** marker-in-frame image returns plausible `px_per_cm` + `wound_area_cm2` within tolerance of a hand-measured control; camera and upload both produce a mask; engine consumes real tissue/perfusion/infection.

Phases 2 (caged VLM via Vercel AI Gateway + report LLM + orchestrator) and 3 (SSE `run` + demo) follow — see the build spec §9.

---

## Paste-into-Cursor prompt (Composer / agent)

> You are continuing the MendWise wound-assessment app. Read `docs/MendWise_Assessment_Build_Spec.md` and `docs/HANDOFF.md` first, and obey the cage invariants (determinism authoritative; AI caged; additive behind `assessmentV2`; no fine-tuning). Phase 0 (the deterministic CWCS/Mölnlycke engine in `src/decision/engine.ts` + `scripts/test-rules.mts`) is DONE and green — do not regress it (`npm run test:rules` must stay 66/66; `npm run typecheck` must not add errors). Implement **Phase 1** (SAM 2 boundary via a Replicate/Modal endpoint + `api/segment.ts`, HSV-centroid prompt with tap fallback, ArUco/coin cm² calibration, HSI tissue-% with a new `epithelial` class threaded through `CvResult` + UI, ABPI/perfusion + explicit infection questionnaire inputs, and photo upload). Keep the existing demo flow working. Before writing Expo code, check the versioned docs at https://docs.expo.dev/versions/v57.0.0/ (see `AGENTS.md`). Show me a short plan before large edits.
