# MendWise — Phase 2 & beyond: implementation plan

**Read first:** [MendWise_Assessment_Build_Spec.md](./MendWise_Assessment_Build_Spec.md) (architecture) and [HANDOFF.md](./HANDOFF.md) (state after Phases 0–1).
This file is the *plan* for Phase 2 (caged VLM + full pipeline + Supabase + plain-language UI), Phase 3 (orchestrator + demo) and the post-pitch backlog.

Everything below obeys the cage: determinism authoritative, AI caged to inputs/narration, additive behind `assessmentV2`, conservative by default, no fine-tuning.

Phase 2 has three workstreams that can proceed in parallel:
- **A — Pipeline:** mask-restricted tissue, caged VLM, reconciliation, evaluate, report.
- **B — Data:** Supabase schema, persistence, audit log.
- **C — Presentation:** plain-language UI, remove manufacturer references from the app.

---

## 0. Carry-overs that Phase 2 must close first

| # | Item | Where | Why it blocks |
|---|---|---|---|
| 0.1 | **HSI tissue % is computed over the whole image, not inside the wound mask.** `runPipeline` calls `breakdownFromBuffer(blurred.data, …)` on the full frame. | `api/analyze.ts:~120`, `src/cv/tissueClassifier.ts`, `src/cv/opencvNative.native.ts` | The CWCS tissue axis is currently contaminated by skin/background pixels. Every pathway downstream inherits that error. **Fix before wiring the VLM**, or the VLM-vs-HSI reconciliation compares against noise. |
| 0.2 | Selected SAM 2 mask is rendered as a text summary, not an overlay. | `src/app/analyze.tsx` | The pitch demo needs the boundary visible. |
| 0.3 | The 26 CWCS dressing strings are transcribed from a page image, unverified against `CWCS Choice Guide_6524.pdf`. | `src/decision/engine.ts` | Assessment-3 correctness. Non-code task; assign it now. |

*(Confirmed already done, previously listed here in error: `EXPO_PUBLIC_ASSESSMENT_V2` is set in Vercel Production; the Vercel project is Git-connected. `.vercelignore` already excludes `ios`/`android`, which is why the symlink issue no longer applies.)*

---

## 1. Shape of the work

### 1.1 State lives in Supabase (spec §7 as written)

The V2 endpoints are genuinely stateful: `POST /api/v1/assessments` creates a row, each subsequent call loads and updates it by `{id}`. This is the spec's shape and it is what makes the audit trail and the longitudinal timeline real rather than demo-only.

Two rules that matter more than the schema:

- **All writes go through the Vercel functions using the service-role key.** The Expo client never holds it — `EXPO_PUBLIC_*` values are inlined into the bundle at build time, including the web bundle. The client talks only to `/api/v1/*`.
- **Endpoint handlers stay pure functions of `(state, input) → state'`**, with load/save as a thin wrapper in `_store.ts`. This keeps every handler unit-testable with no database, and keeps the engine path identical between the granular endpoints and the Phase-3 `run` orchestrator.

Offline/degraded behaviour: if Supabase is unreachable, handlers fall back to operating on the state the client posted, return the result, and queue the audit record to stdout (Vercel logs). A DB outage must never block a clinical result or the pitch demo.

### 1.2 New files

```
src/assessment/state.ts        # AssessmentState + VlmFeatures types, shared client↔api (type-only)
src/assessment/client.ts       # fetch helpers: createAssessment(), vlmFeatures(), evaluateRemote(), report(), runStream()
src/decision/engine.ts         # EXTENDED (single runtime file invariant holds)
src/decision/vlm.schema.ts     # Zod schema + enum types — imported by api and by the schema test
src/copy/plainLanguage.ts      # clinical term → patient-facing wording (workstream C)
src/copy/referrals.ts          # referral code → friendly title / what to do / urgency (workstream C)

api/v1/assessments/_gateway.ts     # AI Gateway client, model resolution, availability probe
api/v1/assessments/_store.ts       # Supabase load/save + audit write (service-role, server-only)
api/v1/assessments/_controller.ts  # deterministic state machine: segment→tissue→vlm→evaluate→report
api/v1/assessments/index.ts        # POST → { assessment_id }
api/v1/assessments/tissue.ts       # HSI inside the mask + periwound band
api/v1/assessments/vlm-features.ts # caged VLM, generateObject + Zod, temperature 0
api/v1/assessments/evaluate.ts     # runs src/decision/engine.ts server-side
api/v1/assessments/report.ts       # report LLM from decided facts only
api/v1/assessments/run.ts          # Phase 3 — SSE orchestrator

supabase/migrations/               # schema (§4)
scripts/test-rules.mts             # EXTENDED — reconciliation + conflict-gate assertions
scripts/test-vlm-schema.mts        # NEW — schema/cage tests, no network
scripts/test-copy.mts              # NEW — banned-terminology guard for UI copy (§5)
```

Dependencies to add: `ai@^6`, `zod` (pin explicitly — currently only transitive), `@supabase/supabase-js`.

---

## 2. Workstream A — pipeline

### 2.1 Fix tissue-inside-mask (closes 0.1)

- `tissueClassifier.breakdownFromBuffer` gains an optional `mask?: Uint8Array` (same w×h, non-zero = inside). Pixels outside the mask are skipped entirely — they do not land in `other`.
- `api/v1/assessments/tissue.ts` accepts `{ base64, mask?, pxPerCm? }`:
  1. Decode the image; decode the SAM 2 mask PNG (reuse `pngjs`, as `api/_maskSelect.ts` already does) and resize to the analysis resolution.
  2. No mask supplied → fall back to the HSV `combined` mask, and mark `maskSource: 'hsv'`.
  3. Tissue % over in-mask pixels only.
  4. **Periwound band:** dilate the mask by `4 cm × pxPerCm` (spec §5.4) minus the mask itself; report `periwound.rednessPct` and `periwound.maceration` from HSI in that ring. If `pxPerCm` is null, do not guess — return `periwound: null` with a `no_scale` reason.
- Response: `{ tissue_pct{…}, maskSource, maskAreaPx, periwound, tissue_type_candidate }`.
- Native parity: mirror the mask restriction in `src/cv/opencvNative.native.ts` so the offline path is consistent.

**Acceptance:** a synthetic image with a known coloured disc on a contrasting background returns ≥95 % of the disc's class inside the mask and ~0 % background contamination. Add as a fixture test.

### 2.2 The AI Gateway adapter (`_gateway.ts`)

- AI SDK v6, `provider/model` strings through the Vercel AI Gateway. OIDC auth in prod (`vercel env pull` locally); never hardcode provider keys.
- **Model resolution:** `gateway.getAvailableModels()` at cold start, cached in module scope. Pick the first vision-capable model from a short ordered preference list; `MENDWISE_VLM_MODEL` / `MENDWISE_LLM_MODEL` override for pinning. Never hardcode a single id.
- **`isGatewayConfigured()`** mirrors `isSam2Configured()`. Unconfigured or failing → callers return `{ source: 'unavailable', reason }` and the engine proceeds without the VLM axis. The demo never breaks on an AI failure; it degrades to "incomplete".
- One retry with backoff on 5xx/timeout, then give up. Hard timeout (~20 s) so `run` can't hang the SSE stream.

### 2.3 Caged VLM features (`vlm-features.ts`)

- Schema in `src/decision/vlm.schema.ts`, exactly spec §7 (infection_signs ×5, edge_type, visual_exudate, tissue_corroboration, image_flags) — every field an enum or enum array, **`uncertain` always available**, no free-text field anywhere.
- `generateObject({ model, schema, temperature: 0, messages: [{ role:'user', content: [image, maskedCrop, periwoundCrop, prompt] }] })`.
- Prompt rules: the model is a *feature extractor*; it must not name a dressing, a pathway or a treatment; unclear → `uncertain`. The schema makes violation structurally impossible — the prompt just improves yield.
- Crops are produced server-side from the mask + the 4 cm dilation (reuse §2.1), so the VLM sees the wound bed and periwound ring, not the whole scene.
- Response: `{ source: 'gateway'|'unavailable', features?, model?, latencyMs, reason? }`.

**Acceptance:** response validates against the schema; two identical calls at `temperature: 0` return identical JSON; with the gateway env removed, the endpoint returns `unavailable` and `evaluate` still answers (as "incomplete").

### 2.4 Reconciliation — the bridge (engine work; highest-risk item)

The only place VLM output touches the decision, and it is deterministic code.

Extend `EngineInputs` additively (all optional, so the existing 66 assertions are untouched):

```ts
vlm?: {
  infectionSigns: Record<'erythema'|'warmth'|'purulent'|'malodour'|'friableGranulation', Tri>;
  edgeType: EdgeType; visualExudate: VisualExudate; tissueCorroboration: Tri3; imageFlags: ImageFlag[];
};
periwound?: { rednessPct: number | null; maceration: boolean | null };
```

Rules (added to `engine.ts`, keeping it one self-contained runtime file):

- **Tissue** — HSI inside the mask is authoritative. `tissueCorroboration === 'disagrees'` does **not** change the tissue type; it downgrades confidence one step and adds a note. Two disagreement sources (VLM disagrees *and* no class ≥ threshold) → `incomplete`.
- **Exudate** — the Q&A answer is authoritative. VLM `visual_exudate` is used only when the Q&A answer is absent, and confidence is then capped at `medium`. Differ by more than one band → downgrade + note.
- **Infection** — conservative OR, not a vote: `'yes'` if Q&A says yes, **or** ≥2 classic VLM signs are `present`, **or** `purulent_discharge === 'present'`. `'no'` only when Q&A says no and no VLM sign is `present`. Otherwise `null` → `incomplete`. Never infer `no` from the VLM alone.
- **Image flags** — `low_light`/`blur` → confidence downgrade; `no_marker` corroborates the existing `markerFound === false` gate.
- **Hard safety gate (spec §11.6):** blur flagged, **or** no marker *and* no manual size, **or** an unresolved tissue conflict → `status: 'incomplete'` and the pathway is **withheld** even if the axes resolve. Today the engine still emits a pathway at `low` confidence; this changes that. Deliberate behaviour change — implement as a separately named gate with its own tests so it is auditable.
- Bump `CWCS_RULES_VERSION` to `cwcs-2024.1+recon.1`.

**Tests (extend `scripts/test-rules.mts`, target ~100 assertions):** each reconciliation rule, each conflict path, the new safety gate, plus a regression block asserting that with `vlm` absent the pre-existing 66 outcomes are byte-identical.

### 2.5 `evaluate` endpoint

Thin: load state → validate → `evaluate(inputs)` → persist result + audit record. No AI. Exists so web, native and the `run` orchestrator share one execution path and one audit write point.

### 2.6 Report LLM (`report.ts`)

- Input is a **whitelist**: the `EngineResult` (axes, pathway id, primary/secondary, referrals, notes, confidence, rules_version), area cm², tissue %, body zone. No image, no raw Q&A free text, no identifiers.
- `generateText`, two outputs: `clinician_report` (structured, cites "per Australian Government CWCS, pathway N" + rules version) and `patient_summary` (plain English — must use the §5 term map, target ~grade 8).
- The prompt forbids introducing any new clinical recommendation; a post-check rejects output containing a pathway number other than the decided one, or a dressing string outside `primary ∪ secondary`. Failure → deterministic template.
- **The deterministic template ships first and is always available:** a pure function rendering both documents from `EngineResult` with no AI. The pitch must survive a gateway outage.

**Acceptance:** report never contains a pathway id or dressing absent from the engine result (asserted against a canned result); with the gateway off, the template still renders both documents.

---

## 3. Workstream B — Supabase

### 3.1 Schema (`supabase/migrations/`)

| Table | Purpose | Notes |
|---|---|---|
| `assessments` | one row per assessment: state JSON, derived axes, pathway id, referrals, confidence, `rules_version`, status | de-identified; no name/DOB/MRN columns exist at all |
| `assessment_images` | storage path, capture source (camera/upload), quality metrics, `px_per_cm`, mask path | image bytes in Supabase Storage, not the table |
| `wound_timeline` | one row per visit per `wound_id`: area cm², tissue %, pathway | powers §4.3 and the healing-rate trigger |
| `rules_version` | one row per deployed engine version + deploy timestamp | makes historical results reproducible |
| `audit_log` | one row per `evaluate`: input hash, derived axes, every referral flag, `rules_version`, model ids, per-step status | **the regulatory asset** |

- RLS on every table, deny-by-default. The service role is the only writer; there is no anon write path.
- `audit_log` is append-only (no update/delete grant), which is the property that makes it worth anything in a regulatory conversation.
- Storage bucket private, signed URLs with short TTL.

### 3.2 Order of work

`_store.ts` and the audit record come first and work without the DB (stdout). Then the migrations, then wire the writes. That way workstream A is never blocked on workstream B, and the audit trail exists from day one.

### 3.3 Data posture

Consented or public images only until La Trobe ethics clears. No patient identifiers anywhere in the schema — the demo uses a client-generated `wound_id` with no back-reference to a person.

---

## 4. Phase 3 — orchestrator + demo

### 4.1 `POST /api/v1/assessments/{id}/run` (SSE)

- `_controller.ts` is a **deterministic state machine**, not an agent: `quality-gate → segment → tissue → vlm → evaluate → report`, with explicit per-step `ok | degraded | failed` and a fixed escalation policy. It sequences tools and enforces the cage; it never chooses a clinical output.
- Streams `event: step` frames (`{step, status, ms, summary}`) then a final `event: result`. Vercel Functions stream on the default Node runtime — no `runtime: 'edge'`.
- Every step degrades independently: SAM 2 unavailable → HSV mask + confidence downgrade; VLM unavailable → engine runs without the VLM axis; report LLM unavailable → template; Supabase unavailable → result returned, audit to stdout. Only the engine is non-optional.
- Client: a progress view over the stream — it makes the whole pipeline legible in about fifteen seconds, which is most of the demo's persuasive work.

### 4.2 Comparison screen ("MendWise vs raw frontier API")

Same photo, two columns: (a) a single unguided VLM call producing prose; (b) the MendWise run producing cm², tissue %, pathway N, referral flags, rules version, audit id. Build this early in Phase 3, not the night before.

### 4.3 Timeline

`wound_timeline` per visit, plus the "<40 % area reduction in 4 weeks → specialist team" trigger computed from real history rather than a questionnaire answer. If persistence slips, ship it from `savedReports` in the zustand store — the trigger logic is pure code and is the interesting part.

---

## 5. Workstream C — plain-language UI

Two changes, one mechanism.

### 5.1 Remove manufacturer references from the app

`Mölnlycke` currently appears in the UI at `src/app/questions.tsx:105` ("Mölnlycke Step 3…"). Remove it there and anywhere it surfaces in rendered copy.

**Keep the name in the engine, types and docs** — `src/decision/engine.ts`, `engine.types.ts`, `rules.ts`, `types.ts` cite it in comments and it is the provenance of the referral logic. Provenance belongs in the code and the audit record; it does not belong on a patient's screen. The Australian Government CWCS citation *does* stay visible (as "Australian Government wound care guide"), because guideline-grounding is the product claim and the regulatory labelling.

Guard: `scripts/test-copy.mts` fails if a banned term appears in `src/copy/`, `src/app/` or `src/components/` rendered strings. Cheap, and it stops the jargon creeping back.

### 5.2 Plain-language layer

The result page today renders raw engine strings. `result.dressingCategory` is literally *"CWCS pathway 14 — slough, moderate exudate, infection: yes. Primary: …"*, and `rationale` includes engine messages like *"ABPI < 0.5 → urgent vascular referral (critical ischaemia)"* and *"Probe-to-bone positive → urgent referral (possible osteomyelitis)"*.

**Do not soften the engine strings.** They are the clinical record and the audit trail, and `scripts/test-rules.mts` asserts on them. Instead add a presentation layer keyed by the stable `code` fields the engine already emits (`probe_to_bone`, `critical_ischaemia`, `necrotic_tissue`, `lops`, …):

- `src/copy/referrals.ts` — `code → { title, whatThisMeans, whatToDo, urgencyLabel }`.
- `src/copy/plainLanguage.ts` — the term map, also reused in the §2.6 `patient_summary` prompt so app and report speak the same way.
- `ResultPanel.tsx` renders from these, never from raw engine text.

Suggested term map (for review by the clinical contact before it ships — plain wording that is *wrong* is worse than jargon):

| Engine term | Patient-facing |
|---|---|
| granulation | new healing tissue (red or pink) |
| slough | soft yellow or cream tissue |
| necrosis / necrotic | dark, dead tissue |
| epithelialising | new skin forming across the wound |
| exudate | fluid coming from the wound |
| tissue perfusion | blood flow to the area |
| ABPI | a circulation test your clinician can do |
| erythema > 2 cm | redness spreading more than 2 cm from the wound |
| maceration | soggy, waterlogged skin at the edges |
| probe-to-bone / osteomyelitis | the wound may reach the bone — this needs urgent care |
| MDT referral | a specialist wound care team |
| debridement | a clinician removing the dead tissue |
| LOPS | reduced feeling in the foot |
| CWCS pathway N | *(moved to a provenance line, not a heading)* |

### 5.3 Result page structure

Rewrite the scan result page around what the person needs, in this order:

1. **What to do** — the single clearest action, colour-coded (see someone now / within 48 hours / routine care). This is `urgency`, but phrased as an instruction, not a label.
2. **What we saw** — one short sentence per finding, using the term map, with the measurement in cm² when a marker was present and an explicit "we could not measure size" when it wasn't.
3. **Suggested dressing type** — plain category names, with *"based on the Australian Government wound care guide (pathway N)"* as small provenance text underneath.
4. **Why** — the rationale, rewritten as short sentences.
5. **Clinician view** — a toggle revealing the exact clinical terms, pathway id, referral codes, confidence and `rules_version`. This is how the plain-language layer is achieved without losing the clinical/regulatory value: nothing is deleted, it is one tap away.
6. Disclaimer stays visible throughout: research prototype, not a medical device.

Also pass over `questions.tsx` (drop the guideline citation, put the ABPI band question behind the clinician toggle since patients will not have the number) and `analyze.tsx` (`Granulation / Slough / Necrosis / Epithelial` bar labels → plain terms, exact terms in the clinician view).

**Acceptance:** no banned term in rendered copy (`test-copy.mts` green); a non-clinician reader can state the required action and the reason after reading the result page once; the clinician toggle shows pathway id, referral codes and rules version unchanged.

---

## 6. Beyond the pitch (backlog, ranked)

1. **Golden eval set** (~20–50 clinician-labelled images, Fitzpatrick-balanced) + `scripts/eval.mts` reporting pathway accuracy, referral sensitivity and N/A rate. The data moat, and what turns the demo into evidence. Start collecting during Phase 2.
2. **Verify the 26 CWCS dressing strings** against the source PDF (0.3).
3. **ArUco marker detection** — `pxPerCmFromMarkerSide` already exists; wire detection plus a printable marker card. More robust than the coin/Hough path, which is fragile on skin.
4. **Point-promptable segmentation** — swap `SAM2_REPLICATE_MODEL` for a point-prompt model and delete `_maskSelect.ts`; removes a whole class of selection failure.
5. **Depth / 3D** — `depthAssessed: false` everywhere today. LiDAR on supported iPhones or stereo capture is the honest path; state the 2D limitation until then.
6. **Ethics (La Trobe)** before any real patient imagery.
7. **Clinical review of the plain-language map** (§5.2) — and of the result page as a whole.

---

## 7. Sequencing

| Slot | A — Pipeline | B — Data | C — Presentation |
|---|---|---|---|
| Now | 0.1 mask-restricted tissue | `_store.ts` + audit record (stdout) | term map drafted, sent for clinical review |
| Next | 2.2 gateway + 2.3 VLM endpoint (schema and tests first, network last) | migrations + RLS | `src/copy/*`, remove manufacturer ref, `test-copy.mts` |
| Then | **2.4 reconciliation + tests** (highest-risk correctness work) | wire writes | result page rewrite + clinician toggle |
| Then | 2.5 evaluate, 2.6 report (template first, LLM second) | `wound_timeline` | 0.2 mask overlay, analyze/questions copy |
| Then | 4.1 SSE orchestrator | — | 4.2 comparison screen |
| Parallel | — | — | 6.1 golden set collection |

**Invariants at every step:** `npm run test:rules` green, `npm run typecheck` adds no errors, flag off ⇒ the existing demo flow unchanged, and no AI component ever emits a pathway.
