# MendWise — Build Handoff (current state → next steps)

**Read first:** [MendWise_Assessment_Build_Spec.md](./MendWise_Assessment_Build_Spec.md) — the full architecture, API, data flow and phases. [PHASE2_PLAN.md](./PHASE2_PLAN.md) — the Phase 2+ plan this build followed. This file is the *current state* and the *next task*.

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

## DONE — Phase 1 (segmentation + measurement)

SAM 2 boundary via Replicate (`api/segment.ts` + `api/_sam2.ts` + `api/_maskSelect.ts`), marker
calibration (`pxPerCm` through both pipelines), HSI tissue-% with an `epithelial` class, real
perfusion/ABPI/infection questionnaire inputs, and photo upload. Details in git history; the
carry-overs that mattered are closed below.

**Replicate call shape (still true, worth keeping):** `meta/sam-2` is a *versioned* model, so
`_sam2.ts` resolves the latest version via `GET /v1/models/{model}` (cached) and creates the
prediction via `POST /v1/predictions` with `{ version, input }` + `Prefer: wait`. The official-model
endpoint returns **404** for versioned models. Pin with `SAM2_REPLICATE_VERSION` to skip the lookup.
It is the *automatic* mask generator — no point/box prompt input — which is why `_maskSelect.ts`
picks the wound mask by HSV centroid.

---

## DONE — Phase 2 (caged VLM + full pipeline + Supabase + plain-language UI)

Plan: [PHASE2_PLAN.md](./PHASE2_PLAN.md).

### A — pipeline
- **Tissue is now measured inside the wound mask.** `breakdownFromBuffer` already took a
  `woundMask`; nothing passed one, so the CWCS tissue axis was being computed over the whole frame
  (skin and background included) and every pathway inherited that error. Both `api/analyze.ts` and
  `src/cv/opencvNative.native.ts` now pass the mask.
- **Periwound band** (`api/_tissueOps.ts`, shared by the legacy and V2 endpoints): dilate the mask
  by `4 cm × pxPerCm`, subtract the mask, classify redness/maceration in the ring. With no scale it
  returns `null` — 4 cm cannot be expressed in pixels without one, so it is not guessed.
- `api/v1/assessments/_gateway.ts` — AI Gateway adapter. Resolves models via
  `getAvailableModels()` (env override `MENDWISE_VLM_MODEL` / `MENDWISE_LLM_MODEL`), 20 s timeout,
  one retry, and turns every failure into `unavailable` rather than an exception.
- `api/v1/assessments/vlm-features.ts` — `generateObject` + Zod + `temperature: 0` against
  `src/decision/vlm.schema.ts`. Every field is an enum; there is no free-text channel.
- `api/v1/assessments/tissue.ts`, `evaluate.ts`, `report.ts`, `index.ts`, `run.ts` (SSE),
  `baseline.ts` (the ungrounded comparison arm). Each step has a callable core so `_controller.ts`
  doesn't self-fetch over HTTP.

### B — engine (the highest-risk work)
`reconcileExudate` and `reconcileInfection` in `src/decision/engine.ts`, plus a safety gate:

- **Tissue:** HSI is authoritative. A VLM `disagrees` costs confidence; it never changes the class.
  Disagreement *and* a weak measurement → incomplete.
- **Exudate:** the answer wins. The VLM only fills a missing answer, capped at medium confidence.
- **Infection:** conservative OR — purulence alone, or two classic signs, means yes. The VLM can
  never establish `no`, and a "no" answer alongside a visible sign yields null, not no.
- **Safety gate:** blur, or no scale and no hand-entered size, or an unresolved tissue conflict now
  **withholds** the pathway (`pathwayWithheld`, `gateCodes`) instead of stating it at low
  confidence. This is a deliberate behaviour change from Phase 0.
- `CWCS_RULES_VERSION` → `cwcs-2024.1+recon.1`.

### C — data
`supabase/migrations/0001_assessments.sql` — five tables, RLS deny-by-default, `audit_log`
append-only (update/delete revoked). `_store.ts` writes as the service role from the functions only;
`SUPABASE_*` env vars must **not** carry an `EXPO_PUBLIC_` prefix (Expo inlines those into the
client bundle). With Supabase unset everything still works and the audit record goes to stdout.

### D — presentation
- `src/copy/plainLanguage.ts` + `src/copy/referrals.ts`: engine `code`s → what it means / what to
  do. The engine's own strings are untouched — they are the clinical record.
- Result screen restructured: what to do → what we saw → dressing (with "Australian Government
  wound care guide (pathway N)" as provenance) → why → **Clinician view** toggle carrying the exact
  terms, pathway id, referral codes, gates and rules version.
- Manufacturer name removed from the UI (it stays in the engine, types and docs as provenance).
- Analyze screen: SAM 2 mask rendered as an overlay, plain tissue labels, technical detail behind a
  toggle. ABPI bands moved behind a clinician toggle on the questions screen.

### Verified live (21 Sep 2026)
- **AI Gateway works.** `npm run check:gateway` probes each candidate model with a real call — the
  model *listing* is the catalogue, not your entitlements, so listing membership proves nothing.
- **This account is on the free gateway tier.** Every Anthropic model and `gemini-2.5-pro` are
  restricted; `gemini-2.5-flash`, `gpt-5`, `gpt-5-mini` work. The preference lists in `_gateway.ts`
  are ordered so the free-tier models sit at the tail — the pipeline runs today and picks up the
  better models automatically once credits are added, with no code change. `callGateway` advances to
  the next candidate when a model is restricted.
- **`npm run smoke:live` — 15/15.** Real caged VLM call (schema-valid enums, no free text), identical
  output on a repeat call, engine consuming the features, report LLM passing the cage check, both
  documents produced. On one run Gemini returned `tissueCorroboration: 'disagrees'` and the engine
  correctly held the tissue class and downgraded confidence to medium — the reconciliation working
  on real model output rather than a fixture.
- **Supabase schema applied** (`npm run db:migrate`) — all 5 tables, RLS enabled with no policies,
  and `UPDATE`/`DELETE`/`TRUNCATE`/`TRIGGER` revoked from `anon`/`authenticated` on `audit_log`.
- **Supabase round-trip verified.** `_store.ts` writes and reads back through the service-role
  client, and the audit row was confirmed present *in Postgres* — `writeAudit` falls back to stdout
  when the DB is unreachable, so "it didn't throw" is not proof of a write. The persisted row
  carries `models: {vlm, llm}`. `smoke:live` deletes its own rows unless `SMOKE_KEEP_ROWS=true`.

### Found and fixed while verifying
- `TRUNCATE` is **not** mediated by RLS, and Supabase grants it to `anon` by default — so the
  "append-only audit log" claim was false until it was revoked. Now revoked on all five tables.
- `callGateway` retried non-retryable failures (a 403 restricted-model error), doubling latency and
  cost before degrading. It now stops on 4xx / `isRetryable: false`.
- The gateway timeout was 20s; a reasoning model's vision pass measured ~28s, so the ceiling was
  aborting work that would have succeeded. Now 45s, with fast non-reasoning models preferred.
- `buildAuditRecord` was storing a step *summary string* in `models.vlm` instead of the model id.
  The state now carries `vlmModel` and the audit log records the real id.
- **`temperature: 0` is silently ignored by reasoning models** (the GPT-5 family). The cage does not
  depend on it — the Zod schema is what bounds the output — but reproducibility does, which is why
  the model id is now in the audit log. Documented in `_gateway.ts`.
- The report system prompt was duplicated between the endpoint and the smoke test, so the test was
  exercising a paraphrase. Extracted to `src/assessment/reportPrompt.ts`; both import it.

### Verify
`npm test` runs all three offline suites:
- `npm run test:rules` — **97/97** (was 66; the 66 are asserted unchanged when no VLM is supplied)
- `npm run test:cage` — 15/15 schema + report-cage assertions, no network
- `npm run test:copy` — terminology guard over `src/app`, `src/components`, `src/copy`

`npm run typecheck` — only the pre-existing `app-tabs.web.tsx` `/explore` error.

Live checks (need `.env.local`, gitignored — see `supabase/README.md`):
- `npm run check:gateway` — probes real model access per role
- `npm run smoke:live` — real VLM + report call, engine, cage check, Supabase round-trip
- `npm run db:migrate` — idempotent; applies the schema and prints the resulting grants

### Known issues / carry-overs
- ⚠️ **The plain-language wording in `src/copy/*` has not been reviewed by a clinician.** Plain
  language that is subtly wrong is worse than jargon, because it will be believed. This is the top
  non-code item.
- ⚠️ **Verify the 26 dressing strings in `engine.ts` against `CWCS Choice Guide_6524.pdf`** before
  any graded submission — still transcribed from a page image.
- The periwound HSV thresholds (`classifyPeriwoundPixel`) are a first pass and have not been
  validated against known images, particularly across skin tones.
- ⚠️ **Gateway credits.** On the free tier the VLM pass runs on `gemini-2.5-flash` and takes ~15s.
  For the pitch, add credits so it uses Claude — better vision *and* it honours `temperature: 0`.
- **`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are only in local `.env.local`.** They still need
  adding to the Vercel project (Production + Preview), server-side — never `EXPO_PUBLIC_`, which
  Expo inlines into the client bundle including web. Until then deployed functions log audit
  records to stdout instead of writing rows.
- The deployed endpoints' request/response wrappers are covered by typecheck only — Node's
  type-stripping needs `.ts` extensions that the api/ files (correctly) don't use, so `smoke:live`
  exercises everything they delegate to but not the handlers themselves. Hit them once deployed.
- Pre-existing, unrelated typecheck error in `src/components/app-tabs.web.tsx` (stale `/explore`).
- `src/decision/engine.ts` must stay one self-contained runtime file (types via `import type`) so
  `test:rules` runs under `node --experimental-strip-types`. The Zod mirror lives separately in
  `vlm.schema.ts`, and the report cage check in `reportCage.ts`, for the same reason.

---

## NEXT — remaining Phase 3 + backlog

1. **Golden eval set** (~20–50 clinician-labelled images, Fitzpatrick-balanced) + `scripts/eval.mts`
   reporting pathway accuracy, referral sensitivity and N/A rate. Highest-value remaining work.
2. Apply the Supabase migration and set the two server-side env vars.
3. Exercise the gateway end to end; tune `SAM2_POINTS_PER_SIDE` / `SAM2_MAX_MASKS` for latency.
4. `wound_timeline` UI + the "<40 % area reduction in 4 weeks" trigger from real history.
5. ArUco detection (`pxPerCmFromMarkerSide` is ready); a point-promptable segmentation model would
   let `_maskSelect.ts` be deleted entirely.
6. La Trobe ethics clearance before any real patient imagery.

## Paste-into-Cursor prompt (Composer / agent)

> You are continuing the MendWise wound-assessment app. Read `docs/MendWise_Assessment_Build_Spec.md`, `docs/HANDOFF.md` and `docs/PHASE2_PLAN.md` first, and obey the cage invariants (determinism authoritative; AI caged; additive behind `assessmentV2`; no fine-tuning). Phases 0–2 are DONE and green — do not regress them: `npm test` must stay at 97 + 15 + 4 passing, and `npm run typecheck` must not add errors beyond the pre-existing `app-tabs.web.tsx` one. Pick up from the "NEXT" section of `HANDOFF.md`. Before writing Expo code, check the versioned docs at https://docs.expo.dev/versions/v57.0.0/ (see `AGENTS.md`). Show me a short plan before large edits.
