# MendWise — Guideline-Grounded Wound Assessment — Cursor Build Spec

> **How to use this in Cursor:** paste this whole file into the MendWise repo (suggested path `docs/MendWise_Assessment_Build_Spec.md`) and drive the build phase-by-phase. Each phase has concrete tasks + acceptance criteria. Keep the two source PDFs handy to transcribe the full rule tables: `CWCS Choice Guide_6524.pdf` (Australian Govt decision tree) and `Wound Assessment Quick Guide_3643.pdf` (Mölnlycke 10-step).

---

## 1. Context & goal

**Today:** MendWise does demo-grade HSV tissue segmentation — on-device (`react-native-fast-opencv`, native) and OpenCV.js in a Vercel Node function (web). That's a thin capability a frontier API can match. **No moat.**

**Goal:** an MVP for the **13 Oct 2026 pitch** (and the core of **Assessment 3, due 25 Sep**) that is demonstrably more than a wrapper: **objective measurement + a deterministic, auditable decision engine grounded in Australian Government + manufacturer clinical guidelines.**

**The two guides:**
- **CWCS (Australian Govt Dept of Health & Aged Care) — the decision engine.** Deterministic tree: `Tissue type` (Necrotic-ischaemic / Necrotic-non-ischaemic / Slough / Granulating / Epithelialising) × `Exudate` (Low/Mod/High) × `Infection` (Yes/No) → **1 of 26 pathways** → Primary + Secondary dressing category. Government lookup table, pure code, no AI.
- **Mölnlycke — the 10-step assessment protocol.** Order + referral/escalation triggers: Duration → Location/size/depth → Tissue perfusion → Surrounding skin → Edges/periwound (4 cm) → Wound bed composition → Exudate & odour → Pain/sensation → Infection (classic + subtle) → systemic red-flags.

**Design thesis:** SAM 2 (zero-shot) + OpenCV HSI extract objective features (wound mask, cm² via reference marker, tissue-% composition, periwound redness); a caged frontier VLM extracts the visual signs the rules need; the two guides become a **deterministic rules engine**; a frontier LLM composes the report from already-decided facts. **Deterministic core is authoritative; AI is advisory/orchestration only. No fine-tuning. Additive to the existing app.**

---

## 2. Design principles (the cage) — non-negotiable

1. **Determinism is authoritative.** The CWCS 26-pathway table and Mölnlycke triggers are pure, versioned, unit-tested code. AI produces *inputs*; code makes the *decision*.
2. **AI is caged.** No AI component ever emits a dressing pathway. SAM 2 = boundary; HSI = tissue %; VLM = strict-JSON enums only; LLM = narration of already-decided facts.
3. **Additive, not destructive.** New pipeline behind a `assessmentV2` feature flag and a new `/api/v1/assessments/*` namespace. Existing HSV flow is retained (repurposed as capture quality-gate + offline fallback + SAM 2 prompt seed).
4. **Web + native parity.** All heavy compute (SAM 2, VLM, LLM) is server-side so Expo-native and Expo-web hit the same API. On-device OpenCV stays for capture-time checks only.
5. **Conservative by default.** Low SAM confidence / no marker / VLM-vs-HSI conflict / poor image → "incomplete → retake or escalate", never a confident dressing call.

---

## 3. Tech decisions (resolved)

| Concern | Decision | Notes |
|---|---|---|
| Frontier VLM + LLM | **Vercel AI Gateway** (AI SDK `ai@^6`, `provider/model` strings) | OIDC auth (`vercel env pull`, no keys); failover, cost tags, per-user limits, **audit logging** (regulatory asset). Resolve model IDs via `gateway.getAvailableModels()` — don't hardcode; pick a current vision-capable model for the VLM. |
| VLM cage mechanism | **AI SDK `generateObject` + Zod schema, `temperature: 0`** | Guarantees strict-JSON enums, no free text in the decision path. |
| Wound segmentation | **SAM 2 (image predictor, zero-shot)** on a GPU endpoint (Replicate / fal / Modal) | **Not** on AI Gateway (Gateway is LLM/VLM/image-gen only). No fine-tuning. |
| SAM 2 prompting | **Auto point-prompt seeded from existing HSV centroid + user-tap fallback** | Reuses current HSV code as the seed. Optional V2: Grounding DINO text-prompt "wound" → box → SAM 2 for fully-automatic location. |
| Tissue typing | **OpenCV HSI** inside the SAM mask → % granulation/slough/necrotic/epithelial | Runs in the SAM 2 Python service (or sibling). This is the "OpenCV HSI framework". |
| Measurement | **Reference marker in frame** (ArUco / coin) → px-per-cm → cm² | Auto-detect; if absent, gate to "add marker or enter manually". |
| Image input | **Camera capture AND file/gallery upload** | Same quality gate + marker detection for both paths. |
| Decision logic | **Single deterministic Assessment Engine, two rule modules** (Mölnlycke frame + CWCS output) over shared `AssessmentState` | See §6. |
| Data | **Supabase** (already used on WardCast) | `assessments`, `assessment_images`, `wound_timeline`, `rules_version`, `audit_log`. De-identified. |

---

## 4. Component architecture

```
┌─────────────────────────── CLIENT (Expo RN + Expo web) ───────────────────────────┐
│  Capture: camera OR photo upload + reference-marker overlay +                       │
│           on-device OpenCV quality gate (react-native-fast-opencv / OpenCV.js:      │
│           blur / exposure / marker present) → also emits HSV centroid (SAM seed)    │
│  Assessment wizard: 10-step Mölnlycke order (auto-filled imageable steps + Q&A)     │
│  Results: CWCS pathway + dressing + referral flags + longitudinal tracking + export │
│  Offline fallback: existing HSV → provisional tissue estimate only                  │
└───────────────────────────────────────┬─────────────────────────────────────────────┘
                                         │ HTTPS /api/v1
┌────────────────────── ORCHESTRATION / BFF (Vercel Node functions) ───────────────────┐
│  Agentic controller = deterministic state machine: sequences tools, enforces the     │
│  cage, retries, low-confidence escalation, assembles the record.                     │
└───┬─────────────────────┬──────────────────────┬─────────────────────┬───────────────┘
    │                     │                      │                     │
    ▼                     ▼                      ▼                     ▼
┌────────────┐   ┌──────────────────┐   ┌────────────────────┐  ┌────────────────────┐
│ SAM 2 +    │   │ Vercel AI Gateway │   │ DETERMINISTIC       │  │ Vercel AI Gateway  │
│ HSI + marker│  │ CAGED VLM         │   │ ASSESSMENT ENGINE   │  │ REPORT LLM         │
│ (GPU,Python)│  │ generateObject +  │   │ (Mölnlycke frame +  │  │ generateText from  │
│ mask, cm²,  │  │ Zod, temp 0 →     │   │  CWCS output, one   │  │ DECIDED facts →    │
│ tissue %    │  │ JSON enums        │   │  shared state)      │  │ clinician+patient  │
└────────────┘   └──────────────────┘   └─────────┬──────────┘  └────────────────────┘
                                                   │
                                       ┌───────────▼───────────┐
                                       │ DATA (Supabase)       │
                                       │ assessments, images,  │
                                       │ wound_timeline,       │
                                       │ rules_version,        │
                                       │ audit_log (de-ident.) │
                                       └───────────────────────┘
```

---

## 5. Data flow (image → assessment)

1. **Capture (client)** — camera OR upload; include reference marker; on-device OpenCV quality gate (blur/exposure/marker). Reject & re-prompt on fail. Emit HSV centroid as SAM seed. Upload via signed URL.
2. **Segment (→ SAM 2)** — point-prompt = HSV centroid (or user tap) → mask + confidence.
3. **Calibrate (marker)** — detect ArUco/coin → px-per-cm → wound area cm².
4. **Tissue typing (HSI)** — pixels within mask → tissue % composition; periwound band (dilate mask by 4 cm via scale) → redness/maceration.
5. **Caged VLM pass (AI Gateway)** — masked + periwound crops + Zod schema → JSON enums (infection classic+subtle signs, edge type, visual exudate, tissue corroboration, image flags).
6. **Structured Q&A (client ⇄ orchestrator, optionally VLM-guided)** — un-imageable Mölnlycke inputs: duration, exudate amount, pain/VAS, sensation/LOPS, perfusion (ABPI), history.
7. **Assessment Engine (deterministic)** — Mölnlycke module gates completeness + computes referral/escalation flags → reconciliation derives the 3 CWCS axes → CWCS module → pathway 1–26 + dressing → merge (escalation supersedes).
8. **Report (AI Gateway LLM)** — finalized record → clinician report + patient summary.
9. **Persist + track** — write assessment + audit log; update `wound_timeline` (area-reduction % vs prior visits); return to client.

---

## 6. The deterministic Assessment Engine — how the two guides blend

**One engine, two rule modules, one shared `AssessmentState`, run in sequence. They are not two separate systems.**

- **Mölnlycke module = the FRAME (completeness + safety).** Owns the 10 steps, which inputs are required, and the **referral/red-flag triggers**: probe-to-bone → urgent (osteomyelitis); ABPI < 50–70 mmHg / ABPI < 0.5 / TBI < 30–50 → urgent vascular; diabetes or ABPI > 1.4 → TBPI; systemic infection → urgent; DFU or <40% healing in 4 weeks → MDT; black necrotic tissue → MDT; LOPS → MDT; erythema > 2 cm → spreading infection. Runs as **(a) a gate** (enough valid inputs to proceed?) and **(b) an overlay** (any urgent trigger that overrides?).
- **Reconciliation = the BRIDGE.** Collapses raw features into the 3 CWCS axes: HSI % + VLM tissue call → single `tissue_type` via **precedence necrotic > slough > granulating > epithelialising** (PDF 2's own rule: "if slough + granulation, follow slough"); Q&A → `exudate_level` (Low/Mod/High); classic + subtle signs (VLM + Q&A) → `infection` (Yes/No).
- **CWCS module = the OUTPUT (dressing selection).** `(tissue_type, exudate_level, infection) → pathway_id (1–26) → {primary[], secondary[]}`. Encoded from PDF 2 as a versioned table.
- **Merge → `AssessmentResult`.** CWCS dressing recommendation annotated/overridden by Mölnlycke escalation flags. **Safety flags always win** (e.g., black necrotic → MDT referral outranks the dressing).

```
gatherInputs(state)
  → molnlyckeModule.validate(state)         // completeness gate + required-input list
  → molnlyckeModule.flags(state)            // referrals / red-flags / escalations
  → reconcile(state)                        // → { tissue_type, exudate_level, infection, confidence }
  → cwcsModule.lookup(axes)                 // → { pathway_id, primary[], secondary[] }
  → merge(cwcsResult, flags, confidence)    // escalation supersedes; low confidence → "incomplete"
  → AssessmentResult
```

Both modules are pure functions, fully unit-testable with no ML, and can be built **immediately** (this is the Assessment 3 deliverable and the moat).

---

## 7. API structure (`/api/v1`, versioned)

```
POST   /api/v1/assessments                      → { assessment_id }
POST   /api/v1/assessments/{id}/images          → { image_id, source:"camera"|"upload",
                                                    quality:{blur,exposure,marker_found}, hsv_centroid }
POST   /api/v1/assessments/{id}/segment         → { mask, confidence, wound_area_cm2,
                                                    calibration:{marker_found, px_per_cm} }
POST   /api/v1/assessments/{id}/tissue          → { tissue_pct:{granulation,slough,necrotic,
                                                    epithelial,other}, periwound_redness, tissue_type_candidate }
POST   /api/v1/assessments/{id}/vlm-features    → { infection_signs{...}, edge_type,
                                                    visual_exudate, tissue_corroboration, image_flags }  // Zod, temp 0
PATCH  /api/v1/assessments/{id}/inputs          → structured Q&A (Mölnlycke steps) + next prompt
POST   /api/v1/assessments/{id}/evaluate        → { tissue_type, exudate_level, infection, cwcs_pathway_id,
                                                    primary[], secondary[], referrals[], flags[], confidence, rules_version }
POST   /api/v1/assessments/{id}/report          → { clinician_report, patient_summary }
GET    /api/v1/assessments/{id}                 → full record + audit trail
GET    /api/v1/wounds/{wound_id}/timeline       → longitudinal series (area, tissue %, pathway)

# App-facing orchestrator (fans out segment→tissue→vlm→evaluate→report, streams progress via SSE for the demo):
POST   /api/v1/assessments/{id}/run  (SSE)      → step events → final evaluate+report payload
```

**Caged VLM Zod schema (example):**
```ts
z.object({
  infection_signs: z.object({
    erythema: z.enum(['present','absent','uncertain']),
    warmth: z.enum(['present','absent','uncertain']),
    purulent_discharge: z.enum(['present','absent','uncertain']),
    malodour: z.enum(['present','absent','uncertain']),
    subtle_friable_granulation: z.enum(['present','absent','uncertain']),
  }),
  edge_type: z.enum(['healthy','rolled_epibole','undermined','callused','macerated','uncertain']),
  visual_exudate: z.enum(['none','low','moderate','high','very_high','uncertain']),
  tissue_corroboration: z.enum(['agrees','disagrees','uncertain']),
  image_flags: z.array(z.enum(['low_light','blur','no_marker'])),
})
// generateObject({ model: <gateway vision model>, schema, temperature: 0, messages: [image + question] })
```

---

## 8. Target module layout (in the Expo + Vercel repo)

```
src/                         # Expo app (native + web export)
  capture/                   # camera + UPLOAD, marker overlay, on-device OpenCV gate (existing HSV here + centroid)
  assessment/                # 10-step wizard, results, tracking
  offline/                   # HSV fallback
api/v1/assessments/          # Vercel Node functions (orchestrator + granular endpoints)
  _controller.ts             # agentic state machine + cage enforcement
  _gateway.ts                # Vercel AI Gateway calls (VLM generateObject, report generateText)
  _sam2.ts                   # adapter → SAM 2 GPU endpoint
packages/shared/             # AssessmentState + result types (client + api)
packages/rules/              # DETERMINISTIC engine — build FIRST, no ML
  cwcs.table.json            # 26 pathways transcribed from PDF 2 (versioned)
  cwcs.ts                    # lookup
  molnlycke.ts               # 10-step required inputs + referral/escalation triggers
  reconcile.ts               # tissue precedence + axis derivation + confidence gates
  engine.ts                  # gather→validate→flags→reconcile→lookup→merge
  *.test.ts                  # full coverage of all 26 pathways + every trigger
services/sam2/               # Python GPU service: SAM 2 zero-shot + OpenCV HSI + marker calibration
supabase/migrations/         # assessments, images, wound_timeline, rules_version, audit_log
```

---

## 9. Build phases (mapped to A3 = 25 Sep, pitch = 13 Oct)

**Phase 0 — `packages/rules` (now → 25 Sep). No ML. This is Assessment 3 + the moat.**
- Transcribe all 26 CWCS rows from the PDF into `cwcs.table.json`; implement `cwcs.ts` lookup.
- Implement `molnlycke.ts` (required inputs per step + all referral/escalation triggers) and `reconcile.ts` (tissue precedence, axis derivation, confidence gates) and `engine.ts` (merge, escalation supersedes).
- **Acceptance:** `npm test` green; tests assert every one of the 26 pathways and every Mölnlycke trigger; mixed tissue (slough+granulation) resolves to slough.

**Phase 1 — Segmentation + measurement (25 Sep → 2 Oct).**
- Stand up SAM 2 GPU endpoint; `api/.../segment` wires HSV-centroid seed + user-tap fallback.
- Marker calibration → cm²; port HSV → HSI tissue % inside the mask; add photo-upload path + on-device quality gate.
- **Acceptance:** marker-in-frame test image returns plausible `px_per_cm` and `wound_area_cm2` within tolerance of a hand-measured control; upload and camera both produce a mask.

**Phase 2 — Caged VLM + full pipeline (3 Oct → 9 Oct).**
- `vlm-features` via AI Gateway `generateObject` (Zod, temp 0); `evaluate` runs the engine end-to-end → pathway + referrals; report LLM; `wound_timeline`.
- **Acceptance:** VLM response validates against the schema with no free-text decision; `evaluate` returns a pathway + referral flags; safety gate returns "incomplete" on no-marker/blur/conflict.

**Phase 3 — Orchestrator + demo (10 Oct → 13 Oct).**
- `run` SSE orchestrator; "MendWise vs raw frontier API" comparison screen; rehearse.
- **Acceptance:** one `run` call streams steps and returns cm² + auditable CWCS pathway; side-by-side shows grounded/measured output vs ungrounded prose.

---

## 10. Regulatory / safety posture (thread throughout)

- Label everywhere: "Guideline-based decision support / research prototype — not a medical device; confirm with a clinician." Dressing output shown as "per Australian Govt CWCS, pathway N."
- Conservative-by-default escalation; **full `audit_log` (inputs → rules_version → pathway) = the regulatory-asset seed**, reinforced by AI Gateway request logs.
- No real patient data in the demo without ethics clearance; use consented/public images.

---

## 11. Verification (end-to-end)

1. **Rules engine (no ML):** `packages/rules` tests assert all 26 CWCS pathways + every Mölnlycke trigger + tissue precedence.
2. **Segmentation + calibration:** marker-in-frame image → `marker_found`, plausible `px_per_cm`, `wound_area_cm2` within tolerance of a control; upload + camera both segment.
3. **Tissue typing:** known-tissue reference crops (from PDF 2's examples) → dominant class matches.
4. **Caged VLM:** response validates against Zod schema; no free-text decision; deterministic at temp 0.
5. **Full pipeline:** `POST /run` on a curated golden set (~20–50 clinician-labelled images, balanced across Fitzpatrick skin tones) → compare derived `cwcs_pathway_id` + flags vs label; record accuracy + N/A rate.
6. **Safety gates:** no-marker / blurred / conflicting image → "incomplete → retake/escalate", never a confident pathway.
7. **Integration/regression:** with `assessmentV2` off, existing flows unchanged; offline mode still returns the provisional HSV estimate.
8. **Demo:** `run` output vs a raw frontier-API call on the same photo — cm² + auditable CWCS pathway vs ungrounded prose.

---

## 12. Open items for the team (non-code)

- Transcribe the **full** 26-row CWCS table + the Mölnlycke trigger thresholds verbatim from the PDFs into `packages/rules` (Phase 0 depends on this).
- Choose SAM 2 host (Replicate fastest to wire; Modal for warm containers).
- Confirm a current vision-capable model via `gateway.getAvailableModels()`.
- Build the golden eval set (clinician-labelled, skin-tone balanced) — this is the seed of the proprietary data moat.
- La Trobe ethics clearance before any real patient imagery.

---

## Source guides

- **CWCS Choice Guide** (`CWCS Choice Guide_6524.pdf`) — Australian Government, Department of Health and Aged Care. Wound Assessment decision tree (tissue × exudate × infection → 26 dressing pathways) + Consumable Choice Guide (primary/secondary dressing per pathway).
- **Wound Assessment Quick Guide** (`Wound Assessment Quick Guide_3643.pdf`) — Mölnlycke. 10-step local wound assessment + referral triggers. *Corporate/product-promotional content (specific brand dressings) is deliberately excluded from the engine; only the clinical assessment methodology and escalation logic are used.*
