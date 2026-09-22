---
title: Roadmap
description: Phases 0–2 are done. Phase 3 / backlog from HANDOFF.md NEXT — not from the pre-build plan doc.
---

Status here follows [`docs/HANDOFF.md`](https://github.com/minesh16/woundcare-test/blob/main/docs/HANDOFF.md). [`docs/PHASE2_PLAN.md`](https://github.com/minesh16/woundcare-test/blob/main/docs/PHASE2_PLAN.md) is useful for *why* things look the way they do; it is **stale on phase boundaries** (the SSE orchestrator and comparison screen were "Phase 3" in the plan and shipped in Phase 2).

Deadlines in that handoff: Assessment 3 due **25 Sep 2026**; pitch **13 Oct 2026**.

:::note
Items under **Next** are not shipped. Do not document them as live capability. Golden eval (`scripts/eval.mts`), prod `SUPABASE_URL`, SAM 2 latency tune, `wound_timeline` UI, ArUco, and ethics clearance are backlog.
:::

## Done

### Phase 0 — deterministic engine

- `engine.ts` / `engine.types.ts`: 26 CWCS pathways, `reconcileTissue` (necrotic > slough > granulating > epithelialising), `molnlyckeFlags`, `evaluate`
- Wired non-destructively through `rules.ts` so existing screens compile
- Offline tests for the original 66 outcomes still pass as a regression block inside the current 97

### Phase 1 — segmentation + measurement

- SAM 2 via Replicate (`api/segment.ts`, `_sam2.ts`, `_maskSelect.ts`)
- Marker / `pxPerCm` through both pipelines
- HSI tissue % with an `epithelial` class
- Real perfusion / ABPI / infection questionnaire inputs
- Photo upload (gallery) as well as camera

### Phase 2 — caged VLM + full pipeline + Supabase + plain language

- Tissue **inside the SAM 2 mask** (whole-frame was a real bug)
- Periwound band (`_tissueOps.ts`)
- AI Gateway adapter, caged VLM, evaluate, report (template-first)
- Reconciliation on exudate and infection, plus the **safety gate** (`pathwayWithheld`)
- Supabase schema + `_store.ts` (degrades without env)
- `src/copy/*` + Clinician view; manufacturer name removed from UI
- SSE `run.ts` orchestrator and `compare.tsx` (plan said Phase 3; code is here)

## Next (backlog)

From HANDOFF **NEXT**, in that order of emphasis:

<!-- docs-hook:auto:start:next -->
1. **Golden eval set** (~20–50 clinician-labelled images, Fitzpatrick-balanced) + `scripts/eval.mts` reporting pathway accuracy, referral sensitivity, and N/A rate. Highest-value remaining work. *Not started* (`eval.mts` is not in `scripts/`).
2. **Production Supabase** — set `SUPABASE_URL` (and confirm the service-role key) on the Vercel project, Production + Preview, then **redeploy**. Local migration is already applied.
3. **Exercise the gateway end to end in prod conditions; tune** `SAM2_POINTS_PER_SIDE` / `SAM2_MAX_MASKS` for latency.
4. **`wound_timeline` UI** + the `<40% area reduction in 4 weeks` trigger computed from **real history** (today it is a questionnaire flag). Table already exists.
5. **ArUco detection** — `pxPerCmFromMarkerSide` is ready; wire detection + a printable card. A point-promptable segmentation model would let `_maskSelect.ts` be deleted.
6. **La Trobe ethics clearance** before any real patient imagery.
<!-- docs-hook:auto:end:next -->

## Known issues that are not "features"

These are carry-overs, not roadmap bets:

- Verify the 26 dressing strings against `CWCS Choice Guide_6524.pdf`
- Clinical review of `src/copy/*`
- Periwound HSV thresholds unvalidated across skin tones
- Gateway credits for the pitch (Claude, and models that honour `temperature: 0`)
- Pre-existing `app-tabs.web.tsx` `/explore` typecheck error
- Depth remains `depthAssessed: false` everywhere (2D limitation by design)
