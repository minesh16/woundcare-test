# MendWise — Build Handoff (current state → next steps)

**Read first:** [MendWise_Assessment_Build_Spec.md](./MendWise_Assessment_Build_Spec.md) — the full architecture, API, data flow and phases. [PHASE2_PLAN.md](./PHASE2_PLAN.md) — the Phase 2+ plan this build followed. This file is the *current state* and the *next task*.

**Repo:** `/Users/minesh/Agents/woundcare-test` (Expo React Native + Expo-web on Vercel).
**Deadlines:** Assessment 3 (product architecture + MVP) due **25 Sep 2026**; pitch **13 Oct 2026**.

---

## The cage (non-negotiable invariants)

1. **Determinism is authoritative.** The CWCS 26-pathway table + Mölnlycke triggers (`src/decision/engine.ts`) make the dressing/referral decision. AI only produces *inputs* and *narrates* outputs — it never emits a pathway.
2. **AI is caged.** Segmentation = boundary (FUSegNet on Modal → SAM 3 on fal.ai → SAM 2 on Replicate); OpenCV HSI = tissue %; frontier VLM = strict-JSON enums only (`generateObject` + Zod, `temperature: 0`); frontier LLM = report from already-decided facts.
3. **Additive, never destructive.** New work sits behind an `assessmentV2` flag + `/api/v1/assessments/*`. The existing HSV flow stays as capture quality-gate + offline fallback + SAM prompt-seed.
4. **Conservative by default.** No marker / low confidence / conflicting signals → "incomplete → retake or escalate", never a confident dressing call.
5. **No model fine-tuning.** Pre-trained segmentation (zero-shot SAM, published FUSegNet weights) + frontier VLM/LLM. We train nothing.

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

**Superseded by the FUSegNet + SAM 3 section below.** SAM 2 on Replicate is now the
*third* provider in a chain, not the only one. Everything in this section still describes
how it behaves when it is reached.

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

### Production status (mendwise.vercel.app, 23 Sep 2026)
`GET /api/v1/assessments/health` is the authoritative answer to "what does this deployment have".

| Capability | State |
|---|---|
| Deterministic engine | ✅ always — never depends on anything below |
| AI Gateway (VLM + report) | ✅ `openai/gpt-5` / `gemini-2.5-flash` on the free tier |
| Segmentation | chain of three — see `segmentation.active` in the health response. SAM 2 was the only one until the FUSegNet + SAM 3 work below; `FUSEGNET_MODAL_URL` and `FAL_KEY` still need setting on the Vercel project |
| Supabase persistence + audit | ✅ live since 23 Sep 2026 — rows are being written again |
| Docs site at `/docs` | ✅ live, passphrase-gated (`DOCS_PASSPHRASE`) |

Verified live against prod: all 7 v1 endpoints reach their handlers; `evaluate` returns pathway 16
with the correct axes; the safety gate withholds the pathway and returns both plain-English reasons
on a blurred/no-scale input; `report` returns `source: llm` having passed the cage check.

**Resolved 23 Sep 2026 — the store was never missing, it was misspelled.** The Vercel project had
`SUABASE_URL`, so `process.env.SUPABASE_URL` was `undefined` and health honestly reported `false`.
That got written down here as "missing" and stayed that way for two days, during which assessments
computed correctly and persisted nothing. Renamed and redeployed; `capabilities.store` is now `true`.

Keep two things from this:
- **A misspelled env var is indistinguishable from an absent one at runtime.** `vercel env ls` shows
  the spelling; the health endpoint cannot. Check the list, not just the boolean.
- **Vercel binds env vars at deploy time**, so fixing a name does nothing until the next deploy.

It failed quietly because the engine has no database dependency — a dark store cannot block a
clinical result, it can only drop the audit trail, which is the whole point of the schema.

### Deployment gotchas (both cost a bad prod deploy — don't rediscover them)
1. **Vercel functions do not resolve tsconfig `paths`.** Any `src/` module reachable from `api/`
   must use relative imports. An aliased *value* import typechecks clean, bundles clean under Metro,
   works in the app — and throws at module load in the deployed function (`report.ts` and `run.ts`
   returned 500 while their siblings were fine). `import type` is safe; it is erased before
   bundling. Guarded by `npm run test:imports`.
2. **A nested `api/**/index.ts` is not routed to its directory path.** `/api/v1/assessments`
   404'd while every sibling resolved, so the create route is an explicit `create.ts`.
3. `maxDuration` for plain Vercel Node functions comes from `vercel.json`, not from an
   `export const config` in the handler (that is Next.js route-segment config).
4. **Routing Middleware must be `middleware.ts` (or `.js`) at the repo root.** As `middleware.mjs`
   it was never bundled — silently, with no build warning — so the `/docs` gate did not run and
   every docs page answered 200 to anyone. A missing auth gate fails *open* and looks identical to
   a working one from a logged-in browser. Verify from outside after any change to it:
   `curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://mendwise.vercel.app/docs/`
   should print a `302` to `/docs/gate/`, and **without** `reason=unconfigured` (which would mean
   the middleware ran but could not see `DOCS_PASSPHRASE`).

### Documentation site (`/docs`)
Starlight lives in `docs-site/` and is copied into `dist/docs` by `scripts/build-vercel.mjs`
(the root `buildCommand`). It is **not** a second Vercel project. `/docs` is passphrase-gated
(`DOCS_PASSPHRASE` → `POST /api/docs-unlock` HttpOnly cookie; `middleware.ts` matcher is
`/docs` only). The Expo app and `/api/v1/*` stay public. Local authoring: `cd docs-site && npm run dev`
(now at `http://localhost:4321/docs/`).

Live and verified 23 Sep 2026: `/docs/*` 302s to the gate without a cookie, the gate page itself
stays open, a wrong passphrase gets a 401 from `/api/docs-unlock`, and the app and `/api/v1/*` are
unaffected. `DOCS_PASSPHRASE` is set on Production and Preview. If it is ever removed, the gate
shows `reason=unconfigured` and fails closed. The workspace is trusted in Cursor Settings → Hooks,
so the docs-check hook loads.

### Verify
`npm test` runs all five offline suites:
- `npm run test:rules` — **97/97** (was 66; the 66 are asserted unchanged when no VLM is supplied)
- `npm run test:cage` — 15/15 schema + report-cage assertions, no network
- `npm run test:copy` — terminology guard over `src/app`, `src/components`, `src/copy`
- `npm run test:imports` — catches the alias-in-a-function bug above
- `npm run test:segmentation` — **96/96** segmentation wire formats (see the section below)

`npm run typecheck` — only the pre-existing `app-tabs.web.tsx` `/explore` error.

Live checks (need `.env.local`, gitignored — see `supabase/README.md`):
- `npm run check:gateway` — probes real model access per role
- `npm run check:segmentation` — probes the FUSegNet and SAM 3 endpoints with a real call
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

## DONE — Segmentation backends: FUSegNet (Modal) + SAM 3 (fal.ai)

The boundary step is no longer one model on one host. `api/_segmentation.ts` is a facade
over three providers, tried in order (`SEGMENTATION_PROVIDERS`, default below):

| Order | Provider | Host | Prompt | Returns |
|---|---|---|---|---|
| 1 | `fusegnet` | Modal (`FUSEGNET_MODAL_URL`) | none — wound-only model | one binary wound mask |
| 2 | `sam3` | fal.ai `fal-ai/sam-3/image` | text concept `"wound"` + pixel point | every match, with scores |
| 3 | `sam2` | Replicate `meta/sam-2` | none — automatic generator | everything in the frame |

**Why FUSegNet leads.** It is the only one of the three trained on wounds, so there is
nothing to disambiguate: the "model segmented the foot, not the ulcer" failure that
`_maskSelect.ts` exists to work around cannot happen. SAM 3 is the generalist second
choice and does collapse the spec's optional V2 plan (§3: "Grounding DINO text-prompt
'wound' → box → SAM 2") into a single call, because SAM 3 takes the noun phrase directly.
SAM 2 stays, unchanged and working, as the third fallback — additive, never destructive.

### Files
- `api/_segmentationParse.ts` — **import-free**, like `engine.ts`, so `test:segmentation`
  can load it under `node --experimental-strip-types`. Holds the provider order parsing,
  the JPEG/PNG header reader, the request builders, the response parsers and the mask
  plausibility bounds. The HTTP adapters import *from* it; nothing imports *into* it.
- `api/_fusegnet.ts` — Modal adapter. Proxy auth is `Modal-Key`/`Modal-Secret` when both
  are set, else `Authorization: Bearer <FUSEGNET_AUTH_TOKEN>`, else unauthenticated.
- `api/_sam3.ts` — fal adapter. Auth is `Authorization: Key <FAL_KEY>` (**not** `Bearer`).
- `api/_segmentation.ts` — the chain: try, measure, reject, fall through, record attempts.
- `api/v1/assessments/segment.ts` — the granular step the spec's §7 names and the repo
  was missing. Delegates to the same facade as `run`.
- `api/_maskSelect.ts` — gained `maskStats()` and `totalPx` on a selection; still selects
  by centroid for the two providers that return more than one mask.

### Behaviour that is new, not just rewired
- **A mask is measured before it is trusted.** `maskPlausibility` rejects a mask under
  0.05% or over 60% of the frame and moves to the next provider. A mask of the whole leg
  is not a boundary error downstream — it silently rescales every tissue percentage, and
  nothing after it can tell.
- **Every attempt is recorded** (`attempts: [{provider, status, ms, reason}]`) and lands in
  the step summary, the API response and `audit_log.models.segmentationProvider`. A
  boundary from the third fallback is a different result from the same photo; it should not
  look identical.
- **`TissueSummary.maskSource` is now `'model' | 'hsv'`**, not `'sam2' | 'hsv'`, with the
  provider in a separate `maskProvider` field. The tissue step is handed a mask, not a
  provider — it must not claim to know which model drew it.
- **SAM 3's point prompt is in pixels.** Ours are fractional, so `imageSize()` reads the
  real dimensions from the JPEG/PNG header (no full decode) and the point is **omitted**
  rather than guessed when the header is unreadable. A fraction sent as a pixel coordinate
  lands in the top-left corner of the photo and still returns a confident mask.
- **`apply_mask: false` on the fal request.** With it true, fal composites the mask onto the
  photograph, and the HSI classifier would measure a composited photo as tissue.
- `/api/segment` and `/api/v1/assessments/segment` have `maxDuration: 180` — three GPU
  backends at 60 s each do not fit in 60.

### Verify
- `npm run test:segmentation` — **96/96**, offline. Covers provider-order parsing, the
  JPEG/PNG header reader, pixel conversion and clamping, both request shapes, both
  response shapes (including fal `Image` unwrapping and `metadata` scores), the Modal auth
  precedence, and every plausibility bound.
- `npm run check:segmentation` — **live** probe. Sends the request the adapters send (the
  builders are shared, so the probe cannot verify a lookalike) and prints the endpoint's
  actual response keys when nothing parses. `--image=path/to/wound.jpg` to probe with a
  real photo; the synthetic image only tests the wire format.
- `GET /api/v1/assessments/health` now reports `segmentation.order`, per-provider
  `configured`, and `segmentation.active` — the first provider that will actually answer.

### Known issues / carry-overs
- ⚠️ **The Modal response contract is assumed, not verified.** `parseFusegnetResponse` tries
  `mask`, `mask_png`, `mask_base64`, `mask_png_base64`, `mask_url`, `masks`, `wound_mask`,
  `segmentation`, `output`, accepts an http url / data uri / bare base64, and reads a score
  from `confidence`, `score`, `mean_probability`, `mean_prob`, `probability` or `dice`. If
  the deployed handler uses something else, `FUSEGNET_MASK_FIELD` and
  `FUSEGNET_IMAGE_FIELD` adapt it with no code change. **Run `npm run check:segmentation`
  once against the real endpoint** — that is what closes this item.
- ⚠️ **No live run yet.** `.env.local` has no `FUSEGNET_MODAL_URL`, `FAL_KEY` or
  `REPLICATE_API_TOKEN`, so nothing here has been exercised against a GPU. The offline
  suite proves the wire format; it cannot prove the endpoints agree with it.
- **FUSegNet is a foot-ulcer model.** Its training distribution is DFUs. On a venous leg
  ulcer or a pressure injury, SAM 3's concept prompt may well be the better boundary —
  which is an argument for the chain order being an env var, and for the golden eval set
  being the thing that settles it rather than this paragraph.
- The two new providers' latency is unmeasured. A cold Modal container loading
  EfficientNet weights is the slow case; `FUSEGNET_TIMEOUT_MS` defaults to 60 s.

---

## NEXT — remaining Phase 3 + backlog

1. **Run `npm run check:segmentation` against the live Modal + fal endpoints.** The FUSegNet
   response contract is assumed, not verified, and nothing in the chain has touched a GPU yet.
   This is the cheapest high-value item and it gates everything below that needs a real mask.
   Then add `FUSEGNET_MODAL_URL` + `FAL_KEY` (and the Modal auth pair) to the Vercel project,
   Production **and** Preview, and redeploy — Vercel binds env vars at deploy time.
2. **Golden eval set** (~20–50 clinician-labelled images, Fitzpatrick-balanced) + `scripts/eval.mts`
   reporting pathway accuracy, referral sensitivity and N/A rate. Highest-value remaining work —
   and now also the thing that settles whether FUSegNet or SAM 3 should lead the chain, which is
   a one-line `SEGMENTATION_PROVIDERS` change rather than a code change.
3. Apply the Supabase migration and set the two server-side env vars.
4. Measure per-provider boundary latency end to end; tune `SAM2_POINTS_PER_SIDE` /
   `SAM2_MAX_MASKS` and the three `*_TIMEOUT_MS` ceilings against what the chain actually costs.
5. `wound_timeline` UI + the "<40 % area reduction in 4 weeks" trigger from real history.
6. ArUco detection (`pxPerCmFromMarkerSide` is ready). `_maskSelect.ts` is no longer
   load-bearing — FUSegNet returns one wound mask and SAM 3 usually returns one match — but
   it is still the disambiguator when SAM 3 finds several, so it stays until the eval set
   shows the chain never needs it.
7. La Trobe ethics clearance before any real patient imagery.

## Paste-into-Cursor prompt (Composer / agent)

> You are continuing the MendWise wound-assessment app. Read `docs/MendWise_Assessment_Build_Spec.md`, `docs/HANDOFF.md` and `docs/PHASE2_PLAN.md` first, and obey the cage invariants (determinism authoritative; AI caged; additive behind `assessmentV2`; no fine-tuning). Phases 0–2 and the FUSegNet/SAM 3 segmentation chain are DONE and green — do not regress them: `npm test` must stay at 97 + 15 + 4 + 2 + 96 passing, and `npm run typecheck` must not add errors beyond the pre-existing `app-tabs.web.tsx` one. Pick up from the "NEXT" section of `HANDOFF.md`. Before writing Expo code, check the versioned docs at https://docs.expo.dev/versions/v57.0.0/ (see `AGENTS.md`). Show me a short plan before large edits.
