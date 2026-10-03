# MendWise — Build Handoff (current state → next steps)

**Read first:** [MendWise_Assessment_Build_Spec.md](./MendWise_Assessment_Build_Spec.md) — the full architecture, API, data flow and phases. [PHASE2_PLAN.md](./PHASE2_PLAN.md) — the Phase 2+ plan this build followed. This file is the *current state* and the *next task*.

**Repo:** `/Users/minesh/Agents/woundcare-test` (Expo React Native + Expo-web on Vercel).
**Deadlines:** Assessment 3 (product architecture + MVP) due **25 Sep 2026**; pitch **13 Oct 2026**.

---

## The cage (non-negotiable invariants)

1. **Determinism is authoritative.** The CWCS 26-pathway table + Mölnlycke triggers (`src/decision/engine.ts`) make the dressing/referral decision. AI only produces *inputs* and *narrates* outputs — it never emits a pathway.
2. **AI is caged.** Segmentation = boundary (SAM 3 on fal.ai → FUSegNet on Modal); OpenCV HSI = tissue %; frontier VLM = strict-JSON enums only (`generateObject` + Zod, `temperature: 0`); frontier LLM = report from already-decided facts.
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

**SAM 2 has since been REMOVED** (3 Oct 2026) — see the segmentation section below. It was
the automatic mask generator, with no point/box prompt input, so it segmented everything in
frame and the wound had to be guessed back out by HSV centroid in `_maskSelect.ts`. It did
not work well enough to keep even as a fallback. `api/_sam2.ts` and `REPLICATE_API_TOKEN`
are gone; Replicate is no longer a processor. Everything else in this section still holds:
marker calibration, HSI tissue-%, the questionnaire inputs and photo upload are unchanged.

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
- Analyze screen: the model mask rendered as an overlay, plain tissue labels, technical detail behind a
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
| Segmentation | SAM 3 → FUSegNet — see `segmentation.active` in the health response. `FAL_KEY` and `FUSEGNET_MODAL_URL` (+ its auth token) still need setting on the Vercel project |
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
- `npm run test:segmentation` — **123/123** segmentation wire formats (see the section below)

`npm run typecheck` — only the pre-existing `app-tabs.web.tsx` `/explore` error.

Live checks (need `.env.local`, gitignored — see `supabase/README.md`):
- `npm run check:gateway` — probes real model access per role
- `npm run check:segmentation` — probes the SAM 3 and FUSegNet endpoints with a real call
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

## DONE — Segmentation backends: SAM 3 (fal.ai) + FUSegNet (Modal)

The boundary step is no longer one model on one host. `api/_segmentation.ts` is a facade
over two providers, tried in order (`SEGMENTATION_PROVIDERS`, default below):

| Order | Provider | Host | Prompt | Returns |
|---|---|---|---|---|
| 1 | `sam3` | fal.ai `fal-ai/sam-3/image` | text concept `"wound"` + pixel point | every match, with scores |
| 2 | `fusegnet` | Modal (`FUSEGNET_MODAL_URL`) | none — wound-only model | one binary wound mask |

Below both, the fallback is the on-device HSV mask, as it always was.

**Why SAM 3 leads.** FUSegNet is the more *specific* model, not the more *general* one: its
training set is chronic **foot** ulcers, so it is the preferred boundary for DFUs and an
unknown quantity on a venous leg ulcer or a pressure injury. Leading with the generalist and
keeping the specialist behind it is the conservative order until the golden eval set says
otherwise — and that decision is then one env var, not a code change. SAM 3's concept prompt
also collapses the spec's optional V2 plan (§3: "Grounding DINO text-prompt 'wound' → box →
SAM 2") into a single call, because SAM 3 takes the noun phrase directly.

**SAM 2 on Replicate was removed, not demoted.** It was the *automatic* mask generator — no
prompt input at all — so it segmented every object in the frame and the wound had to be
recovered afterwards by HSV centroid. It did not work well enough to be worth keeping even
as a fallback, so `api/_sam2.ts`, `REPLICATE_API_TOKEN` and the `SAM2_*` vars are gone.
Consequence worth noting in the processor register: **Replicate is no longer a processor**;
fal.ai and Modal are (see `docs/SECURITY_AUDIT.md` MW-07).

### Files
- `api/_segmentationParse.ts` — **import-free**, like `engine.ts`, so `test:segmentation`
  can load it under `node --experimental-strip-types`. Holds the provider order parsing,
  the JPEG/PNG header reader, the request builders, the response parsers and the mask
  plausibility bounds. The HTTP adapters import *from* it; nothing imports *into* it.
- `api/_sam3.ts` — fal adapter. Auth is `Authorization: Key <FAL_KEY>` (**not** `Bearer`).
- `api/_fusegnet.ts` — Modal adapter.
- `api/_segmentation.ts` — the chain: try, measure, reject, fall through, record attempts.
- `api/v1/assessments/segment.ts` — the granular step the spec's §7 names and the repo
  was missing. Delegates to the same facade as `run`.
- `api/_maskSelect.ts` — gained `maskStats()` and `totalPx` on a selection; still the
  disambiguator when SAM 3's concept prompt matches several regions.

### The FUSegNet contract — verified, not assumed
Request read from the deployment's own schema (`GET {base}/openapi.json`, title
"MendWise FUSegNet"); response read off a real authenticated call, because the schema
declares it as an untyped object:

```
GET  {base}/health   → { ok, model: "FUSegNet (efficientnet-b7, pscse)", size: 512 }
POST {base}/segment  → { image_b64, box?: [x0,y0,x1,y1], size?: 512, debug?: false }
                       + an `authorization: Bearer <token>` header the handler checks itself
         responds   → { mask_png_b64: <bare base64 PNG>,   // not `mask`, not a data uri
                        area_px: 3346,
                        mean_prob: 0.95,
                        regions: { regions_found, regions_kept, regions_dropped,
                                   multiple_regions, min_region_px },
                        width, height, crop: [x0,y0,x1,y1], size: 512,
                        model: "fusegnet-effb7-pscse", latency_ms }
```

`model` is now what goes in `audit_log.models.segmentation` — the endpoint knows which
weights ran and we don't, so a label we invented was the worse record. `regions.multiple_regions`
is carried into `SegmentationOutcome.multipleRegions` (satellite lesions, two wounds in one
frame) and **recorded, not acted on**: acting on it is a clinical judgement that belongs to
the engine. `crop` echoes the box the model ran on — the full frame when no `box` is sent.

Three things this cost, all now guarded by tests:
- **`FUSEGNET_MODAL_URL` is the bare origin, which 404s.** The FastAPI app mounts its routes
  beneath it, so `fusegnetUrl()` appends `/segment` unless the configured URL already has a
  path (which lets one var pin the whole endpoint). `FUSEGNET_SEGMENT_PATH` overrides it.
- **The request field is `image_b64`, not `image`.** That is now the default.
- **The response field is `mask_png_b64`**, which the first tolerance list did not have —
  `mask_png_base64` was close and did not match. This is precisely what the probe's
  "print the real keys" path exists for, and it took one commit to close rather than a
  debugging session.

`/health` is hit first by the probe: it is free, it names the loaded weights, and it warms a
cold container so the first real call does not absorb a model load and time out.

**`box` is interesting.** The endpoint's own schema describes it as `[x0,y0,x1,y1]` "e.g.
from SAM 3" — it was built to be *refined after* a box, not only run standalone. Nothing
passes one yet, because in a fallback chain FUSegNet only runs when SAM 3 produced nothing to
take a box from. It is plumbed through `buildFusegnetBody`/`fusegnetRequest` because it is
part of the real contract, and because **SAM 3 box → FUSegNet mask refinement is the obvious
next architecture** once the eval set exists. That would be a different pipeline shape from
this fallback chain, so it is flagged rather than quietly built.

### Behaviour that is new, not just rewired
- **A mask is measured before it is trusted.** `maskPlausibility` rejects a mask under
  0.05% or over 60% of the frame and moves to the next provider. A mask of the whole leg
  is not a boundary error downstream — it silently rescales every tissue percentage, and
  nothing after it can tell.
- **Every attempt is recorded** (`attempts: [{provider, status, ms, reason}]`) and lands in
  the step summary, the API response and `audit_log.models.segmentationProvider`. A
  boundary from the fallback provider is a different result from the same photo; it should
  not look identical.
- **`TissueSummary.maskSource` is now `'model' | 'hsv'`**, not `'sam2' | 'hsv'`, with the
  provider in a separate `maskProvider` field (validated against the known set, because it
  arrives over HTTP and ends up in the audit log). The tissue step is handed a mask, not a
  provider — it must not claim to know which model drew it.
- **SAM 3's point prompt is in pixels.** Ours are fractional, so `imageSize()` reads the
  real dimensions from the JPEG/PNG header (no full decode) and the point is **omitted**
  rather than guessed when the header is unreadable. A fraction sent as a pixel coordinate
  lands in the top-left corner of the photo and still returns a confident mask.
- **`apply_mask: false` on the fal request.** With it true, fal composites the mask onto the
  photograph, and the HSI classifier would measure a composited photo as tissue.
- `/api/segment` and `/api/v1/assessments/segment` have `maxDuration: 180` — two GPU
  backends at a 60 s timeout each, plus mask fetch and decode, do not fit in 60.

### Verify
- `npm run test:segmentation` — **123/123**, offline. Provider-order parsing (including that
  the removed `sam2` is not accepted and does not disable segmentation), the JPEG/PNG header
  reader, pixel conversion and clamping, both request shapes, URL joining, both response
  shapes (fal `Image` unwrapping, `metadata` scores, ragged-score rejection, and the real
  FUSegNet response as read off the live call), Modal auth precedence, and every
  plausibility bound.
- `npm run check:segmentation` — **live** probe, in chain order. Sends the request the
  adapters send (the builders are shared, so the probe cannot verify a lookalike) and prints
  the endpoint's actual response keys when nothing parses. `--image=path/to/wound.jpg` to
  probe with a real photo; the synthetic image only tests the wire format.
- `GET /api/v1/assessments/health` reports `segmentation.order`, per-provider `configured`,
  and `segmentation.active` — the first provider that will actually answer.

### Running it locally — two traps that make a working build look broken
`npx vercel dev` (the CLI is **not** installed globally; `npx` works, scope `replytic/mendwise`,
already linked via the gitignored `.vercel/`) is the faithful test: Expo web build plus `/api`
on one origin. But:

1. **It injects the project's *Development* environment**, and every var on this project is
   Production/Preview only. Straight `npx vercel dev` therefore boots with
   `segmentation: false`, `store: false` and the `/docs` gate answering
   `reason=unconfigured` — a configuration artefact that looks exactly like broken code.
   Export the local env instead: `set -a; . ./.env.local; set +a; npx vercel dev`.
2. **`EXPO_PUBLIC_ASSESSMENT_V2` must be set**, or `ASSESSMENT_V2` is false and
   `segmentWoundUri()` returns `null` before it ever reaches the API — the app silently runs the
   old HSV-only flow and segmentation appears to do nothing. It now lives in `.env.local`.
3. **Metro caches the inlined value, and this one is the real trap.** `EXPO_PUBLIC_*` vars are
   folded into the bundle at build time and the transform is cached, so setting the var changes
   nothing on the next build — a stale bundle looks exactly like a correct one. It cost a wrong
   claim in this file: "verified through `vercel dev` with both fixes applied" was true of the
   API (curl against the endpoints) and **false of the client**, whose bundle still had
   `has(''.trim()...)`. The fix is `npx expo export -p web --output-dir dist --clear`;
   `vercel dev` runs `expo export` *without* `--clear`, so it will not do this for you.

   **Check the artefact, not the config.** In the served bundle,
   `new Set(['true','1','yes','on']).has("true"...)` is on and `has(''...)` is off. That the env
   var is set proves nothing.

With both applied, `GET /api/v1/assessments/health` locally reports
`segmentation.active: "sam3"`, store true, and `/docs/` 302s to the gate *without*
`reason=unconfigured`.

**`npx vercel env ls` confirmed (3 Oct 2026):** `FAL_KEY`, `FUSEGNET_AUTH_TOKEN` and
`FUSEGNET_MODAL_URL` are all present and correctly spelled on **Production and Preview**, and
`REPLICATE_API_TOKEN` is gone. One gap: **`EXPO_PUBLIC_ASSESSMENT_V2` is Production-only**, so a
*preview* deployment will run with V2 off and look like segmentation is broken there too.

### Pre-existing: deep links 404 in production
The Expo static export writes `capture.html`, `analyze.html`, … and `vercel.json` sets no
`cleanUrls`, so `/capture` is a **404** and `/capture.html` a 200 — confirmed identically on
`vercel dev` and on `mendwise.vercel.app`, so it predates this work. Client-side navigation from
`/` is unaffected, which is why nobody has hit it; a hard refresh or a shared deep link on any
route but `/` breaks. `"cleanUrls": true` in `vercel.json` is the one-line fix, deliberately not
applied here as it is unrelated to segmentation.

### Local API dev server
`npm run dev:api` (`scripts/dev-server.mts`, run under `tsx`) serves the `api/` files over
HTTP on :3000. It exists because `npm run web` has **no** `/api` routes and `vercel dev` needs
the Vercel CLI, which is not installed — so until now the deployed handlers' request/response
wrappers were covered by `typecheck` only. That is the gap this file used to record as "hit
them once deployed"; it is now closable locally.

It mirrors Vercel's filesystem routing deliberately, including that a nested `api/**/index.ts`
is **not** routed to its directory path. A route that 404s there 404s here.

`tsx`, not `node --experimental-strip-types`: the `api/` modules use extensionless relative
imports (correctly — Vercel requires it) and Node's ESM resolver will not resolve those.

### Live results (3 Oct 2026, local `.env.local`)
**Both providers verified end to end, through the real HTTP handlers.**

- **SAM 3.** Request accepted, pixel point prompt placed, 1 mask at score 0.803, fetched from
  fal's CDN, decoded and measured at 8,111 px — against ~8,090 px of ellipse geometry in the
  synthetic probe image. That 0.3% agreement is the proof `apply_mask: false` really returns a
  **binary mask** and not a composited photograph. Latency 1.0–3.5 s typical, one 19.9 s outlier.
- **FUSegNet.** `/health` 200 with the weights loaded; `/segment` 200 in ~2.1 s with a mask
  that decodes to **3,346 px — exactly its own reported `area_px`**, which cross-checks the
  decode path end to end. Cold-start on `/health` measured at 1.4 s warm, 12.5–13.4 s cold.
- `npm run smoke:live` — **15/15**, unchanged: the VLM, engine, report cage and Supabase
  round-trip are unaffected by any of this.

**The whole pipeline, over HTTP, against the real handlers.** Run three times — twice through
`npm run dev:api` and once through `npx vercel dev` (the real Vercel function runtime), with the
same outcome every time:

| step | status | ms | note |
|---|---|---|---|
| segment | ok | 2.3–2.4 s | `fusegnet` **after 1 other provider** — the fallback path |
| tissue | ok | 1.5–1.9 s | `maskSource: model`, `maskProvider: fusegnet`, 8,840 px |
| vlm | ok | 8.2–9.4 s | `google/gemini-2.5-flash` |
| evaluate | ok | 0 ms | pathway 22, no gates, confidence high |
| report | ok | 36–39 s | `source: llm`, `openai/gpt-5` |

And the audit row in Postgres now carries both fields:

```json
"models": { "vlm": "google/gemini-2.5-flash", "llm": "openai/gpt-5",
            "segmentation": "fusegnet-effb7-pscse",
            "segmentationProvider": "fusegnet" }
```

versus an older row reading `"segmentation": "meta/sam-2"` with no provider at all. `/api/segment`
and `/api/v1/assessments/segment` both 200 with the same outcome, so the granular route and the
orchestrator genuinely share one implementation.

**`MolnlyckeInputs` is typed `boolean`, and a caller sending the string `'no'` gets the trigger
it meant to clear** — `'no'` is truthy, so a first probe payload produced spurious
`probe_to_bone` and `diabetes_tbpi` referrals. The engine is right and the payload was wrong,
and the failure direction is safe (extra referrals, never fewer), but it is a live instance of
MW-12 in `docs/SECURITY_AUDIT.md` ("no request-body validation on ingress"): a Zod schema on
the way in would have rejected it. Worth fixing when MW-12 is.

**The finding that matters more than either pass — FUSegNet has no abstain.** On the synthetic
probe image, which contains an ellipse and no wound:

| | SAM 3 | FUSegNet |
|---|---|---|
| result | **no match** for `"wound"` | 3,346 px mask |
| confidence | — | `mean_prob` **0.95** |

The generalist correctly declined; the specialist confidently segmented something that is not
a wound, and would have done so on a photo of a carpet. So:
- `mean_prob` is "how sure the network is about the pixels it chose", **not** "is there a
  wound here". It can only ever *downgrade* confidence in this codebase; it can never
  establish that a boundary is real. Commented at `FUSEGNET_SCORE_KEYS`.
- `maskPlausibility` is doing real work rather than defensive decoration — it is the only
  thing standing between a confident non-wound mask and the tissue classifier.
- It is a second, independent argument for SAM 3 leading, alongside the foot-ulcer one.
- Probing SAM 3's mask path at all needed `SAM3_PROMPT="red ellipse"`, since it will not
  invent a wound on request.

### Known issues / carry-overs
- ⚠️ **Neither model has been judged on a real wound.** The probe's synthetic image proves
  the wire format, the decode path and the plausibility gate — it cannot say anything about
  boundary *quality*. `npm run check:segmentation --image=<consented photo>` is the first
  real look, and the golden eval set is the actual answer.
- ⚠️ **The credentials are on Vercel but the CODE is not.** As of 3 Oct 2026 these 8 commits
  are unpushed, so `https://mendwise.vercel.app/api/v1/assessments/health` still answers with
  the **old** shape — no `segmentation` block, and `REPLICATE_API_TOKEN: false` giving
  `segmentation: false`. Production therefore has **no boundary provider at all** and falls
  back to the on-device HSV mask on every assessment. Push and redeploy; then
  `segmentation.active` should read `sam3`.
- **FUSegNet is a foot-ulcer model with no abstain**, which is why it sits second. The golden
  eval set is what should settle the order, not the reasoning above.
- Latency is sampled, not measured: SAM 3 1.0–3.5 s with a 19.9 s outlier; FUSegNet ~2.1 s
  warm, 12.5–13.4 s cold on `/health`. The `*_TIMEOUT_MS` ceilings are still guesses.
- `regions.multiple_regions` is recorded and unused. If it turns out to flag satellite
  lesions reliably, it is a candidate engine input — but that needs clinical grounding, not
  a plumbing decision.

---

## NEXT — remaining Phase 3 + backlog

1. **Add `FAL_KEY`, `FUSEGNET_MODAL_URL` and `FUSEGNET_AUTH_TOKEN` to the Vercel project**
   (Production **and** Preview, server-side) and redeploy. Both providers are verified
   locally; the deployment has neither, so it is currently falling back to the on-device HSV
   mask on every assessment. `REPLICATE_API_TOKEN` can be deleted at the same time.
   Confirm with `GET /api/v1/assessments/health` → `segmentation.active`.
2. **Golden eval set** (~20–50 clinician-labelled images, Fitzpatrick-balanced) + `scripts/eval.mts`
   reporting pathway accuracy, referral sensitivity and N/A rate. Highest-value remaining work —
   and now also the thing that settles whether FUSegNet or SAM 3 should lead the chain, which is
   a one-line `SEGMENTATION_PROVIDERS` change rather than a code change. FUSegNet is
   currently second because it is a foot-ulcer model; the eval set is what should move it.
3. Apply the Supabase migration and set the two server-side env vars.
4. Measure per-provider boundary latency end to end and tune the `*_TIMEOUT_MS` ceilings
   against what the chain actually costs. Then consider the **SAM 3 box → FUSegNet mask**
   refinement pass the Modal endpoint's `box` parameter was built for.
5. `wound_timeline` UI + the "<40 % area reduction in 4 weeks" trigger from real history.
6. ArUco detection (`pxPerCmFromMarkerSide` is ready). `_maskSelect.ts` is no longer
   load-bearing — FUSegNet returns one wound mask and SAM 3 usually returns one match — but
   it is still the disambiguator when SAM 3 finds several, so it stays until the eval set
   shows the chain never needs it.
7. La Trobe ethics clearance before any real patient imagery.

## Paste-into-Cursor prompt (Composer / agent)

> You are continuing the MendWise wound-assessment app. Read `docs/MendWise_Assessment_Build_Spec.md`, `docs/HANDOFF.md` and `docs/PHASE2_PLAN.md` first, and obey the cage invariants (determinism authoritative; AI caged; additive behind `assessmentV2`; no fine-tuning). Phases 0–2 and the FUSegNet/SAM 3 segmentation chain are DONE and green — do not regress them: `npm test` must stay at 97 + 15 + 4 + 2 + 123 passing, and `npm run typecheck` must not add errors beyond the pre-existing `app-tabs.web.tsx` one. Pick up from the "NEXT" section of `HANDOFF.md`. Before writing Expo code, check the versioned docs at https://docs.expo.dev/versions/v57.0.0/ (see `AGENTS.md`). Show me a short plan before large edits.
