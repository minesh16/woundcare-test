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

## DONE — the review step, and the main flow on `run` (3 Oct 2026)

```
capture → analyze (quality gate + model draft) → review (approve / adjust / draw)
        → location → questions → result (server pipeline + audit) → compare
```

Both gaps recorded below are now closed. The section is kept because the reasoning is
the record of why the architecture and the app had drifted apart.

### The review screen — `src/app/review.tsx`
Three outcomes, all recorded:

| action | what it does | mask used | provider attribution |
|---|---|---|---|
| **Approve** | the model's outline is correct | the model's **original mask**, untouched | the model |
| **Adjust** | edit the model's outline, pre-seeded with it | rasterised from the clinician's polygon | the model |
| **Reject → draw** | outline the wound from scratch, empty editor | rasterised from the clinician's polygon | **null — clinician** |

Approve is deliberately **lossless**: it uses the mask the model produced, not a
re-rasterisation of the traced outline, so approving changes nothing about what is
measured. Only adjust and draw go through the polygon.

A rejected boundary is attributed to nobody but the clinician — `provider: null`,
`source: 'clinician'`. Letting a hand-drawn outline inherit "fusegnet" would be a false
record of which model drew it.

### Geometry — `api/_maskGeometry.ts` (import-free, 55 tests)
- `traceOutline` — largest 4-connected region → Moore-neighbour contour walk →
  Douglas-Peucker simplification → fractional polygon. Largest region only, because a
  contour that jumped between blobs would enclose the healthy skin between them. Moore
  tracing rather than "collect boundary pixels and sort them", which self-crosses on any
  concave shape, and wounds are concave.
- `rasterisePolygon` — scanline, even-odd, sampled at row centres. Even-odd matters: a
  min/max-x fill would fill the notch that makes a shape concave.
- `validatePolygon` — strict, because this is caller-supplied data that decides which
  pixels count as wound (`docs/SECURITY_AUDIT.md` MW-12).
- The load-bearing test is the **round trip** — rasterise → trace → rasterise, asserting
  IoU ≥ 0.97 on square, concave and blob shapes, plus resolution-independence across a 4×
  change. A bug in that loop silently moves the wound edge and every tissue percentage
  inherits it.

### `POST /api/v1/assessments/mask`
Polygon (fractional) → PNG mask. Server-side because **Expo-native has no canvas**, so
this is the only way both platforms turn the same polygon into the same mask (§2.4 parity).
Plausibility is **reported, never enforced**: the automatic gate exists to catch a *model*
returning nonsense, and here a human has deliberately drawn this boundary. The UI warns
once and a second Save accepts it — the clinician is the authority on this screen.

### `run` honours an approved boundary
`RunInput.approvedBoundary` makes the orchestrator **skip segmentation entirely**. That is
the point: re-segmenting would measure tissue inside a *different* boundary from the one a
human signed off, and the audit record's approval field would name an approval that did not
apply to the mask used.

`SegmentSummary` gained `approval` and `source: 'clinician'`; the audit log gained
`models.segmentationApproval`. For an assurance reviewer that field is the difference
between "a model decided where the wound was" and "a clinician approved where the wound
was" — and its **absence** says the boundary was never reviewed.

### Verified live through `vercel dev`
```
POST /api/segment            → 36-point outline traced from FUSegNet's mask
POST .../mask                → 8,430px / 3.22% of frame, plausible
     invalid polygons        → 400 with the reason (2 points / out of range / not an array)
POST .../run (approved)      → segment ok 0ms "Using the clinician-adjusted boundary."
                               tissue ok 1.8s  maskProvider=fusegnet area=8430px
                               vlm ok 9.8s · evaluate ok 1ms pathway 22 · report ok 26s
audit_log row                → "segmentationApproval": "adjusted",
                                "segmentationProvider": "fusegnet"
[boundary] log               → approval adjusted, 36 points, 3.22% (shoelace 3.19%)
```
`segment` at **0 ms** is the proof the chain was skipped rather than re-run.

### Known issues / carry-overs
- **The editor is tap-based, not drag-based.** Tap to add, tap a point to select, tap
  again to move; Undo / Clear. Dragging is the natural gesture but pan handling differs
  between Expo-web and native, and a half-working drag on one platform is worse than a tap
  that behaves identically on both. Freehand is the obvious follow-up.
- **Tracing loses a little area.** FUSegNet's 8,840 px mask traced and re-rasterised to
  8,430 px — about 4.6% smaller, from the `OUTLINE_TOLERANCE` simplification on a small
  shape. It only affects *adjust* (approve is lossless), and the clinician is editing the
  outline anyway, but tightening the tolerance for small masks is worth doing.
- **No clinician identity.** The approval is recorded; *who* approved is not, because the
  system has no authentication at all (`SECURITY_AUDIT.md` MW-01). An approval without an
  approver is weaker evidence than it looks, and MW-01 is now a blocker for the audit
  trail's value, not just for access control.
- `review` is behind `assessmentV2`: with the flag off, `analyze` still goes straight to
  `/location` and the old flow is untouched.
- Expo's typed-route file (`.expo/types/router.d.ts`) is regenerated by `expo start`, **not**
  by `expo export`. After adding a screen, `npx expo start` once or `typecheck` fails on the
  new route while the app itself works.

### Still to do here
The main flow now writes an audit row, but `result.tsx` renders the **on-device** engine
result and runs the server pipeline alongside it for the VLM axis, the written report and
the audit. Those two should not be able to disagree. Reconciling them — or rendering the
server result once it lands — is the obvious next step, and is why the on-device result is
still what the screen states today.

---

## DONE — measure the approved outline; one result on screen (3 Oct 2026)

**The bug this fixes.** On the demo leg ulcer with a 20c coin, the result screen said
"7% granulation / 77% slough / no size reference" while the server, inside the approved SAM 3
outline, measured 82% granulation / 17% slough. Three independent causes:

| cause | where | fix |
|---|---|---|
| The screen's decision came from the on-device HSV pass, whose mask covered the **whole leg + coin**; skin falls in the slough hue band | `result.tsx` → `assess(session)` → `session.cv` | Everything reads `measuredView(session)` (`src/assessment/measured.ts`): the approved outline's measurement when it exists, HSV only in the legacy flow. The screen renders the **server's** engine result (the one the audit row records) |
| The coin was only searched for when the capture switch was on, and it defaulted to off | `capture.tsx` | Default on |
| With the switch on, `HoughCircles`' **first** circle was taken — a phantom centred on the wound at 2× the coin's radius: 84.5 px/cm vs a true 42.1, so area ~4× too big at "high" confidence | `api/analyze.ts` | `api/_coin.ts`: radius bounds, reject circles touching the approved outline, require ≥ 0.6 rim edge support (coin 0.96, every phantom ≤ 0.44) |

Found on the way and fixed: **the outline editor's canvas was square** while a portrait photo was
`contain`-fitted inside it, so tapped points (fractions of the canvas) and model outlines
(fractions of the image) disagreed — an unchanged "Adjust → Save" grew the wound from 2.85% to
5.92% of the frame. The canvas now takes the photo's aspect ratio (`expo-image` `onLoad`); the same
action now gives 2.71% (IoU 0.96 with the model's mask).

### Flow now
```
review: Approve/Adjust/Draw → POST /measure (tissue %, coin, area/length/width/perimeter inside
        the outline) → POST /correction (one row, server-computed IoU) → location → questions
result: check  — "What was measured" (outline + the coin circled; "That is not the coin")
                 + tissue confirm (§4.3) — no pathway shown yet
        deciding — /run with approvedBoundary + tissueOverride; new SSE `decision` event at ~19 s
        decided  — server engine result rendered; report follows (~60–110 s); on-device engine
                   only if the server is unreachable, and the screen says so
```

### Files
- `api/_coin.ts` (import-free) — coin choice. `api/_measure.ts` — `detectCoin`, `measureMaskGeometry`
  (`minAreaRect` length/width, `arcLength` perimeter, cm via the coin).
- `api/v1/assessments/measure.ts` — requires an approved mask; never falls back to HSV (422).
  `analyzeTissue({ measure: true })` does the work so tissue and size share one decode and one grid.
- `api/v1/assessments/correction.ts` + `supabase/migrations/0002_segmentation_corrections.sql`
  (**applied**). Insert-only for anon; reads via `segmentation_correction_stats()` (security
  definer, aggregates only). Mask PNGs stored only for `public_dataset`/`synthetic` — enforced in
  code (`mayStoreMasks`) **and** by a CHECK constraint. `session.imageSource` defaults to
  `consented_demo` (no masks kept); there is no UI to change it yet.
- Engine: `EngineInputs.tissueOverride` + `applyTissueOverride`; a confirmation also resolves the
  `tissue_conflict` gate. Rules version → **`cwcs-2024.1+recon.2`**.
- SAM 3 confidence bands per spec §3.1: ≥ 0.80 high, ≥ 0.50 medium, else low (was: ≥ 0.5 high).
- `compare.tsx` now runs the grounded arm on the approved outline with the same inputs.
- `npm run db:migrate` applies every file in `supabase/migrations/` in order.

### Verified
- `npm test`: 107 + 15 + 4 + 2 + 125 + 55 + 23 (new `test:measure`) = **331 passing**; typecheck
  only the pre-existing `app-tabs.web.tsx` error.
- Headless Chromium through `vercel dev`, the whole web flow on the demo photo: coin 42.0 px/cm,
  **12.4 cm², 4.8 × 3.4 cm**, 82/17/0 tissue, decision at ~19 s (pathway 15, tissue confirmed as
  slough), report at ~110 s, no console errors. A coin-less crop of the same photo: no scale, no
  false coin.

### Known issues / carry-overs
- The tissue axis is precedence, not majority: 17% slough ⇒ slough pathway. The confirm step is
  where a clinician overrides it; the copy no longer says "mostly".
- The periwound band is capped (`MAX_PERIWOUND_KERNEL = 151` px), so at ~42 px/cm it is ~1.8 cm,
  not 4 cm.
- `hashInputs` passes `Object.keys(inputs).sort()` as a `JSON.stringify` replacer, which also
  filters NESTED keys — most of the tissue/VLM detail never reaches the audit hash.
- The rasterised polygon is 1024 × 1024 regardless of the photo's aspect (fine for fractional
  resampling, but loses vertical resolution on portrait photos).

---

## DONE — segmentation build spec Phases 1–5 (3 Oct 2026)

Spec: `WoundCare/MendWise_Segmentation_Build_Spec.md`. Flow is now
`capture → location → analyze → review → questions → result` — location moved before analysis
(§6.4) so it can decide whether FUSegNet gives a second opinion.

### Phase 1 — SAM 3 + review
- `/segment` (§3.2): `{ base64, prompts?: { text, points[{xPct,yPct,label}], box }, body_zone }` →
  `{ source: sam3|fusegnet|hsv, mask, score, box, confidence, model, latencyMs, outline, frame,
  secondOpinion, promptConflict, attempts, reason }`. `/api/segment` is an alias of the same handler.
- SAM 3 request: every prompt on `object_id: 1`, `max_masks` 3, `include_boxes`, **`sync_mode` on**
  (masks inline, not on fal's public CDN), 25 s timeout, image downscaled to 1024 on the LONGER edge
  (`api/_image.ts`). The HSV centroid is no longer sent.
- Mask choice is the spec rule (`selectByPrompts`): drop masks that miss a + or contain a −, take the
  top score; none left → top score + `promptConflict`, confidence low. `_maskSelect.ts` is deleted
  (mask I/O moved to `_maskIO.ts`, which also closes the SSRF, MW-04: data URIs or `*.fal.media` only).
- No model answers → the server returns the HSV mask as `source: 'hsv'` (`_hsvMask.ts`, now one
  implementation shared with `/api/analyze` and the tissue step) for the clinician to correct.
- Review screen: **+ Wound / − Not wound taps and Box** re-ask SAM 3 (400 ms debounce, spinner),
  confidence chip + source label, Undo / **Reset to AI**, **Retake photo**; **Adjust points** is now
  drag-based (`react-native-gesture-handler`, 44 pt targets) with tap-to-move kept as the fallback.
  Two web traps fixed on the way, both would make a drag stop after ~4 px: gestures must be created
  once (`useMemo`, handlers via a ref), and the `<img>` must be `pointerEvents="none"` or the
  browser's native image drag cancels the pointer stream.
- Round-trip IoU test raised to the spec's 0.98 (passes).

### Phase 2 — correction log, final-mask pipeline, inputs
- `POST /approve` writes the correction row (server-computed IoU, areas, `boundary_changed`, edits,
  taps, box, ms-to-approve, second-opinion fields); `POST /correction` adds the tissue confirmation
  + Monk tone. Masks are stored only for `synthetic` / `public_dataset` (code + DB CHECK).
  The capture screen asks where the photo is from.
- The image model gets wound-bed and periwound **crops cut from the approved mask** (`_crops.ts`).
- Questions: palpated warmth (replaces yes/no warmth and OVERRIDES the image's warmth), induration,
  oedema, undermining/tunnelling (+ o'clock), depth mm, Monk tone (stratification only).
- Engine `recon.3` (tested): dark-skin rule (Monk ≥ 7 + "no redness" → uncertain); palpated
  warmth / induration count as infection signs; undermining → MDT referral; image
  `deepStructuresVisible` → urgent referral (probe-to-bone family).

### Phase 3 — colour
- White balance from a printed **white reference patch** (`_whiteBalance.ts` + `detectWhitePatch`):
  bright, card-sized, rectangular, not the wound, not the coin. Printable card:
  `docs-site/public/reference-card.svg`. No patch → `no_marker`, tissue confidence capped at medium
  (so a coin-only photo now reads "medium" — by design, spec §5).
- `TISSUE_RELATIVE=1`: periwound-relative classifier (ΔE vs the patient's own skin). `/measure`
  always returns both results under `comparison`; flag OFF by default.
- Acceptance: fixture test (warm cast moves tissue less with WB on) **and** live on the demo photo —
  neutral 82/17 → warm cast 77/23 → warm cast + card, gains (0.88, 0.97, 1.21), **82/17 restored**.
- The periwound band is a true 4 cm now (was capped at ~1.8 cm) and excludes the coin.

### Phase 4 — FUSegNet second opinion
- On a SAM 3 boundary, when `FUSEGNET_TRIGGER` (`foot` default | `all`) matches the location:
  FUSegNet runs on SAM 3's box; agreement IoU → confidence (≥ 0.8 high, 0.5–0.8 medium → review
  shows both outlines and lets the clinician pick, < 0.5 / multiple regions / nothing kept → low →
  review asks for a tap). Any FUSegNet failure → skipped, SAM 3 alone (mock-tested: 401, 5xx,
  timeout). FUSegNet is still the fallback when SAM 3 fails.

### Phase 5 — module API (sandbox)
- `api/_http.ts` `endpoint()` wraps every module: API key (`x-api-key`, hashed in `api_keys`, scoped
  per module) → production keys refused until ARTG → rate limit (per key; per key+IP for the app key;
  heavy endpoints get ¼) → JSON + **Zod** (`_contracts.ts`, MW-12) → `Idempotency-Key` replay →
  **approval binding** → envelope (`request_id`, `api_version`, `engine_version`, `model_versions`,
  `regulatory_status: "investigational"`, `degraded`/`reason`) → sandbox PNG watermark → `api_calls`
  audit row (hashes only).
- `/measure`, `/tissue`, `/vlm-features`, `/run` require an `approval_id` bound to SHA-256 of the
  image bytes and of the final mask's pixels → 403 `approval_required` / `approval_invalid` /
  `approval_mismatch`. `/run` has no segmentation path left — no auto-approval.
- The app uses the same endpoints with its own sandbox key (`EXPO_PUBLIC_MENDWISE_API_KEY` =
  `MENDWISE_APP_KEY`; public by definition — a gate, not identity). It encodes the photo ONCE
  (`session.imageBase64`) because approvals bind to exact bytes.
- Also from the security audit P0: canonical SHA-256 audit hash (MW-05; old 8-char hashes are not
  comparable), server-minted unguessable ids (MW-02, MW-06), upstream error text no longer returned
  (MW-13), security headers in `vercel.json` (MW-08; CSP in **Report-Only** for now).
- OpenAPI 3.1 from the Zod contracts: `GET /api/v1/openapi`, `npm run build:openapi` →
  `docs-site/public/openapi.json` + `modules/api-reference.md` (with the not-for-clinical-use banner).
- Mint a key: `npm run api:key -- --org=acme --scopes=segment,approve,measure`.
- Migration **0003** (applied): `api_keys`, `approvals`, `api_rate_limits` (+ atomic RPC),
  `idempotency_records`, `api_calls`, correction second-opinion columns. All service-role only.

### Verified (3 Oct 2026)
- `npm test` **460 passing**: rules 125, cage 17, copy 4, imports 2, segmentation 163, geometry 55,
  measure 43, api-core 34, chain 17 (mocked fal/Modal). Typecheck: only the old `app-tabs` error.
- `npm run check:api` (live, mints and revokes its own test keys): **43/43** — 401 without a key on
  every module, scope and production gates, 429 + Retry-After, the `'no'`-as-boolean 400, idempotency
  replay/conflict, envelope + watermark, `/tissue` and `/run` 403 without approval, 403 on a swapped
  image or mask, full segment → approve → measure → tissue → correction → run, api_calls rows.
- `npm run bench:segment` on 10 public FUSeg validation images: **p50 6.1 s** (< 8 s ✓), one positive
  tap → mask contains it **9/9** ✓ (the 10th label is empty), mean draft IoU vs ground truth 0.63.
- Headless Chromium, whole flow on the demo photo: tap re-segments, box re-segments (SAM 3 0.95),
  drag moves a point exactly, approve → measure (42.0 px/cm, 12.4 cm²) → tissue confirm → decision
  at ~25 s → report; no console errors. HSV fallback checked with both model keys unset.
- `npm run smoke:live` (now under tsx): 14/15 — the failure is the pre-existing "two identical VLM
  calls agree" check; the gateway models are not deterministic even at temperature 0.

### Findings to act on
- **FUSegNet reports `multiple_regions: true` on almost every FUSeg image** (it keeps a second speck
  even inside SAM 3's box), so under the spec rule nearly every foot wound reads "low" and asks for a
  tap. And SAM 3's tight box starves FUSegNet on small wounds (a 28 px box → it kept nothing; with
  more context it finds the wound). Both are calibration questions for the eval set — the rule is
  implemented as specified, not loosened.
- SAM 3 latency spikes (one call 12 s); `vercel dev` adds compile time on first use.
- A tap that lands inside an over-large mask satisfies the selection rule without improving it
  (FUSeg 0177: IoU 0.10 before and after) — "− Not wound" taps or a box are what fix that case.

### To deploy (not done — local only, nothing committed)
- Vercel env (Production **and** Preview): `MENDWISE_APP_KEY`, `EXPO_PUBLIC_MENDWISE_API_KEY` (same
  value), plus the existing `FAL_KEY`, `FUSEGNET_*`; optional `FUSEGNET_TRIGGER`, `TISSUE_RELATIVE`.
- Migrations 0002 and 0003 are already applied to the Supabase project in `.env.local`.
- Test rows from verification are in `segmentation_corrections`, `approvals` and `api_calls`
  (assessment ids `scan-…`, `check-api-…`, `wb-…`); the `check-api` keys are revoked.

---

## Superseded — the gap this replaced

**There was no `review` screen.** `src/app/` is `index, capture, location, analyze, questions,
result, compare`; `analyze.tsx` pushes straight to `/location`. The SAM 3 draft happens — a
proxied browser run shows `POST /api/analyze` then `POST /api/segment` — but no screen lets a
clinician adjust or approve the boundary before the tissue percentages are measured inside it.
For a decision-support tool whose whole claim is an auditable human-checkable chain, the missing
approval step is the most significant product gap, not a cosmetic one.

**And the main flow does not use the V2 orchestrator.** `runAssessmentStream` /
`/api/v1/assessments/run` is imported by **`compare.tsx` only**. capture→result uses
`/api/analyze` + `/api/segment` and then the **client-side** engine, so on a normal assessment:
the caged VLM never runs, the report LLM never runs, and nothing is persisted or audited.
Everything verified in the sections above about the full pipeline is real, and is currently
reachable only from the comparison screen.

### What that cost, and the stopgap
`writeAudit` is only called from `evaluate.ts` and `_controller.ts`. `/api/segment` and
`/api/analyze` persist nothing — so for every real assessment through the app there was **no
record at all of which model drew the boundary**. The provider was returned in the response,
shown in the Technical-detail toggle, and discarded.

`logSegmentation()` in `api/_segmentation.ts` now emits one structured `[segment]` line from all
three call sites (`/api/segment`, `/api/v1/assessments/segment`, and the orchestrator) with
provider, model, promptMode, confidence, mask area and %, scores, multipleRegions, and the full
attempt chain with reasons. Vercel retains function logs, and `writeAudit` already uses the same
stdout fallback.

It is a **stopgap, not the fix**. A boundary call is not an assessment, so writing an `audit_log`
row per segment would put rows in there that no clinical decision corresponds to. The real fix is
for the app's main flow to go through `run`, which audits properly — which is the same change the
`review` screen needs, since an approve step implies a server round-trip anyway.

---

## NEXT — remaining Phase 3 + backlog

1. ~~Reconcile the two engine results on `result.tsx`~~ — done (see "measure the approved
   outline" above). Still open: record *who* approved a boundary, which needs MW-01
   (authentication) — an approval with no approver is weaker evidence than it looks.
2. **Add `FAL_KEY`, `FUSEGNET_MODAL_URL` and `FUSEGNET_AUTH_TOKEN` to the Vercel project**
   (Production **and** Preview, server-side) and redeploy. Both providers are verified
   locally; the deployment has neither, so it is currently falling back to the on-device HSV
   mask on every assessment. `REPLICATE_API_TOKEN` can be deleted at the same time.
   Confirm with `GET /api/v1/assessments/health` → `segmentation.active`.
3. **Golden eval set** (~20–50 clinician-labelled images, Fitzpatrick-balanced) + `scripts/eval.mts`
   reporting pathway accuracy, referral sensitivity and N/A rate. Highest-value remaining work —
   and now also the thing that settles whether FUSegNet or SAM 3 should lead the chain, which is
   a one-line `SEGMENTATION_PROVIDERS` change rather than a code change. FUSegNet is
   currently second because it is a foot-ulcer model; the eval set is what should move it.
4. Apply the Supabase migration and set the two server-side env vars.
5. Measure per-provider boundary latency end to end and tune the `*_TIMEOUT_MS` ceilings
   against what the chain actually costs. Then consider the **SAM 3 box → FUSegNet mask**
   refinement pass the Modal endpoint's `box` parameter was built for.
6. `wound_timeline` UI + the "<40 % area reduction in 4 weeks" trigger from real history.
7. ArUco detection (`pxPerCmFromMarkerSide` is ready). (`_maskSelect.ts` is gone — the spec's
   prompt-based selection replaced it.)
9. Calibrate the second-opinion rule and SAM 3 confidence bands on the eval set (see "Findings
   to act on" above); then flip the CSP from Report-Only to enforcing, and turn on Vercel WAF
   rate limiting + Preview Deployment Protection (MW-03, MW-16 — platform settings, not code).
8. La Trobe ethics clearance before any real patient imagery.

## Paste-into-Cursor prompt (Composer / agent)

> You are continuing the MendWise wound-assessment app. Read `docs/MendWise_Assessment_Build_Spec.md`, `docs/HANDOFF.md` and `docs/PHASE2_PLAN.md` first, and obey the cage invariants (determinism authoritative; AI caged; additive behind `assessmentV2`; no fine-tuning). Phases 0–2 and the FUSegNet/SAM 3 segmentation chain are DONE and green — do not regress them: `npm test` must stay at 460 passing (rules 125, cage 17, copy 4, imports 2, segmentation 163, geometry 55, measure 43, api 34, chain 17), and `npm run typecheck` must not add errors beyond the pre-existing `app-tabs.web.tsx` one. Pick up from the "NEXT" section of `HANDOFF.md`. Before writing Expo code, check the versioned docs at https://docs.expo.dev/versions/v57.0.0/ (see `AGENTS.md`). Show me a short plan before large edits.
