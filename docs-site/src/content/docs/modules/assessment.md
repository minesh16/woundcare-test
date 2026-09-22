---
title: Assessment module
description: V2 state shape, client fetch helpers, deterministic report template, and shared report prompt.
---

Path: [`src/assessment/`](https://github.com/minesh16/woundcare-test/tree/main/src/assessment)

Added in Phase 2. Easy to miss in older pipeline docs.

<!-- docs-hook:auto:start:files -->
| File | Role |
|---|---|
| `state.ts` | `AssessmentState`, step types, `newAssessmentId` |
| `client.ts` | Flag-gated fetch helpers + SSE consumer |
| `reportTemplate.ts` | Deterministic clinician + patient documents |
| `reportPrompt.ts` | Report LLM system prompt (zero imports — shared with smoke test) |
<!-- docs-hook:auto:end:files -->

## `state.ts`

Shared by Expo and Vercel. De-identified by construction — no name / DOB / MRN field, and there should never be one. `woundId` groups visits of the same wound; it is client-generated.

`StepName`: `quality | segment | tissue | vlm | evaluate | report`.  
`StepStatus`: `ok | degraded | failed | skipped`.

Empty slots mean "did not run or degraded", not a default measurement.

## `client.ts`

Every helper returns `null` when `ASSESSMENT_V2` is off **or** the request fails. Native must not `fetch('/api/…')` — there is no page origin — so `apiUrl()` prefixes `EXPO_PUBLIC_API_BASE`.

| Export | Endpoint |
|---|---|
| `createAssessment` | `POST /api/v1/assessments/create` |
| `analyzeTissueRemote` | `POST /api/v1/assessments/tissue` |
| `vlmFeatures` | `POST /api/v1/assessments/vlm-features` |
| `evaluateRemote` | `POST /api/v1/assessments/evaluate` |
| `baselineRemote` | `POST /api/v1/assessments/baseline` (never feeds the engine) |
| `composeReportRemote` | `POST /api/v1/assessments/report` |
| `runAssessmentStream` | `POST /api/v1/assessments/run` (SSE; parses by hand, EventSource cannot POST) |

## `reportTemplate.ts`

Pure function of `EngineResult` + optional area / zone / tissue %. Uses `src/copy/*` for patient wording and clinical terms for the clinician document. **Relative imports only** — this file is reachable from `api/` and Vercel does not resolve `@/`.

`result.tsx` always exports the template documents so a saved JSON report does not depend on the gateway.

## `reportPrompt.ts`

`buildReportSystemPrompt(termMap)` — the only copy of the report system prompt. `report.ts` and `scripts/smoke-live.mts` both import it so the test cannot accidentally exercise a paraphrase.
