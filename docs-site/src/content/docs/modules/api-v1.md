---
title: V2 assessments API
description: /api/v1/assessments/* — create, tissue, VLM, evaluate, report, run (SSE), health, baseline, store, gateway, controller.
---

Path: [`api/v1/assessments/`](https://github.com/minesh16/woundcare-test/tree/main/api/v1/assessments)

Additive namespace. Core functions are callable without HTTP so `_controller.ts` does not self-fetch.

<!-- docs-hook:auto:start:files -->
| File | HTTP | Role |
|---|---|---|
| `create.ts` | `POST /api/v1/assessments/create` | Open a de-identified record, return `{ assessment_id }` |
| `tissue.ts` | `POST /api/v1/assessments/tissue` | HSI inside mask + periwound |
| `vlm-features.ts` | `POST /api/v1/assessments/vlm-features` | Caged `generateObject` |
| `evaluate.ts` | `POST /api/v1/assessments/evaluate` | `evaluate()` + audit write |
| `report.ts` | `POST /api/v1/assessments/report` | Template + optional LLM + cage check |
| `run.ts` | `POST /api/v1/assessments/run` | SSE orchestrator — **shipped** |
| `health.ts` | `GET /api/v1/assessments/health` | Capability probe (env names only) |
| `baseline.ts` | `POST /api/v1/assessments/baseline` | Ungrounded `generateText`; never feeds the engine |
| `_controller.ts` | — | `runAssessment()` state machine |
| `_gateway.ts` | — | Model resolution, 45 s timeout, degrade to `unavailable` |
| `_store.ts` | — | Service-role load/save/audit/timeline; stdout fallback |
<!-- docs-hook:auto:end:files -->

There is **no** `index.ts`. A nested `api/**/index.ts` did not route to `/api/v1/assessments` on Vercel (404 while siblings worked). Create is explicitly `create.ts`.

## Gateway preference order

From `_gateway.ts` (preferences, not a hardcoded single id). Free-tier reachable models sit at the tail.

**VLM:** Claude Opus 5 → Claude Sonnet 5 → Gemini 2.5 Pro → **Gemini 2.5 Flash** → GPT-5 mini → GPT-5.

**LLM:** Claude Sonnet 5 → Claude Opus 5 → **GPT-5** → GPT-5 mini → Gemini 2.5 Flash.

`callGateway` skips a candidate on 4xx / `isRetryable: false` (a restricted-model 403 used to be retried, doubling latency). `isGatewayConfigured()` is true if `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, or `VERCEL` is set.

`GET /health?models=true` lists resolved candidates (extra round-trip, opt-in).

## Store rules

1. Service-role key never leaves the server. Never `EXPO_PUBLIC_SUPABASE_*` — Expo inlines those into the client bundle, web included.
2. DB is never on the critical path. `isStoreConfigured()` requires **both** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Production currently has the key but not the URL.
