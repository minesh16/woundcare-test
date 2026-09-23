---
title: Decision module
description: Engine, types, VLM schema, report cage, and the session adapter.
---

Path: [`src/decision/`](https://github.com/minesh16/woundcare-test/tree/main/src/decision)

Behavioural deep-dive: [Decision engine](/docs/architecture/decision-engine/). This page is the file map.

<!-- docs-hook:auto:start:files -->
| File | Runtime? | Role |
|---|---|---|
| `engine.ts` | yes | The whole engine: pathways, reconcile*, molnlyckeFlags, evaluate |
| `engine.types.ts` | types only | `EngineInputs`, `EngineResult`, `VlmFeatures`, … |
| `reportCage.ts` | yes | `violatesCage(text, result)` — wrong pathway / invented dressing |
| `rules.ts` | yes | `toEngineInputs`, `assess` (session → UI `AssessmentResult`) |
| `types.ts` | types + defaults | `ScanSession`, `CvResult`, questionnaire unions, body zones |
| `vlm.schema.ts` | yes (Zod) | Runtime mirror of `VlmFeatures`; `VLM_SYSTEM_PROMPT` |
<!-- docs-hook:auto:end:files -->

## Why the split

`engine.ts` cannot import Zod (or anything else at runtime). Tests load it with type-stripping. The Zod schema therefore lives in `vlm.schema.ts`, and the report post-check in `reportCage.ts`, both importable from `api/` via **relative** paths.

`import type` from `engine.types.ts` is erased and is safe everywhere, including Vercel functions.

## Key exports

`engine.ts`: `CWCS_RULES_VERSION`, `TISSUE_PRESENCE_THRESHOLD`, `CWCS_PATHWAYS`, `lookupPathway`, `getPathwayById`, `reconcileTissue`, `reconcileExudate`, `reconcileInfection`, `molnlyckeFlags`, `evaluate`.

`vlm.schema.ts`: `vlmFeaturesSchema`, `triSchema`, `VLM_SYSTEM_PROMPT`.

`rules.ts`: `assess`, `toEngineInputs`, `CLASSIFICATION_LABELS`, `URGENCY_LABELS`, `URGENCY_ACTIONS`.

`types.ts` questionnaire exudate uses `none | moderate | heavy` (UI). The engine uses `low | moderate | high`. `toEngineInputs` maps `none → low`, `heavy → high`.

<!-- docs-hook: last auto-checked against commit 72b0cc6 on 2026-09-23 -->
