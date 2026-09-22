---
title: Production status
description: What works on mendwise.vercel.app today, the live health endpoint, and the api/ deployment gotchas that have already broken prod.
---

:::danger[Do not trust this page indefinitely]
The source of truth for a given deployment is **[`GET /api/v1/assessments/health`](https://mendwise.vercel.app/api/v1/assessments/health)** (optional `?models=true`). Re-check it. The snapshot below is a point in time.
:::

## Snapshot — 23 Sep 2026

Fetched from production during this docs build:

```json
{
  "ok": true,
  "capabilities": {
    "gateway": true,
    "store": true,
    "segmentation": true
  },
  "env": {
    "AI_GATEWAY_API_KEY": true,
    "VERCEL_OIDC_TOKEN": false,
    "SUPABASE_URL": true,
    "SUPABASE_SERVICE_ROLE_KEY": true,
    "REPLICATE_API_TOKEN": true
  },
  "models": { "vlm": [], "llm": [] },
  "engine": "always available — the deterministic decision never depends on any of the above"
}
```

`models` is empty unless you pass `?models=true` (that query hits the gateway).

<!-- docs-hook:auto:start:capabilities -->
| Capability | Production | Meaning when false |
|---|---|---|
| Deterministic engine | Always | Never depends on anything below |
| AI Gateway (VLM + report) | Live (`capabilities.gateway: true`) | VLM and report LLM degrade to unavailable / template |
| SAM 2 | Live (`REPLICATE_API_TOKEN` present) | Falls back to HSV mask |
| Supabase persistence + audit | Live (`capabilities.store: true`) | Assessments still compute; nothing is persisted; `audit_log` rows go to **stdout** |
<!-- docs-hook:auto:end:capabilities -->

`isStoreConfigured()` requires **both** URL and service-role key, and both are now present.

### How the store was dark until 23 Sep 2026

It was never missing. The variable existed on the Vercel project spelled **`SUABASE_URL`**, so `process.env.SUPABASE_URL` read `undefined` and the health endpoint reported exactly that — which then got written down here and in `HANDOFF.md` as "missing". Two days of assessments computed correctly and persisted nothing.

Two lessons worth keeping:

- A typo in an env var name is indistinguishable from an absent one at runtime. `vercel env ls` shows the spelling; the health endpoint cannot.
- **Vercel binds env vars at deploy time.** Correcting the name is not enough on its own — the project must be redeployed before a function sees it.

The engine has no database dependency, which is why this failed quietly: a dark store cannot block a clinical result, it can only drop the audit trail, which is the whole point of the schema.

Also verified against prod on 21 Sep 2026 (from `HANDOFF.md`, not re-hit as a full smoke from this docs build): all 7 v1 endpoints reach their handlers; `evaluate` returns pathway 16 on a known fixture; the safety gate withholds on blurred / no-scale input; `report` can return `source: llm`.

## Local vs production

| | Local (`.env.local`) | Production Vercel |
|---|---|---|
| Gateway | Works (`check:gateway`, `smoke:live` 15/15) | Works, **free tier** |
| SAM 2 | If `REPLICATE_API_TOKEN` set | Token present |
| Supabase schema | Applied (`db:migrate`) | Applied, and functions reach it since 23 Sep 2026 |
| Audit | Real Postgres rows (smoke verified) | Real Postgres rows (stdout only before 23 Sep 2026) |

Free-tier gateway: Anthropic models and `gemini-2.5-pro` are restricted; `gemini-2.5-flash`, `gpt-5`, `gpt-5-mini` work. Preference lists in `_gateway.ts` put free-tier models at the tail — adding credits picks up Claude / Gemini Pro with **no code change**. For the pitch, credits are worth it: Flash is ~15 s, and GPT-5 ignores `temperature: 0`.

## If you are touching `api/`, read this first

Each of these has already caused a **real broken production deploy**. Guarded where possible; still easy to regress.

### 1. Vercel functions do not resolve tsconfig `paths`

Any `src/` module reachable from `api/` must use **relative** value imports (`../../../src/…`). An aliased `import { x } from '@/…'` typechecks, bundles under Metro, works in the app, and **throws at module load** in the deployed function (`report.ts` and `run.ts` returned 500 while siblings were fine).

`import type` is safe — TypeScript erases it before the bundler sees it.

Guard: `npm run test:imports`. Do not ignore a failure.

### 2. Nested `api/**/index.ts` is not routed to its directory path

`/api/v1/assessments` 404'd while every sibling resolved. The create route is therefore an explicit [`create.ts`](https://github.com/minesh16/woundcare-test/blob/main/api/v1/assessments/create.ts), not `index.ts`. Do not "clean that up".

### 3. `maxDuration` lives in `vercel.json`

For plain Vercel Node functions (this repo is not Next.js App Router), `export const config` in the handler is **ignored**. Timeouts are in the repo-root [`vercel.json`](https://github.com/minesh16/woundcare-test/blob/main/vercel.json) (`run.ts` is 300 s; VLM / report / segment 60 s). Two sources of truth is how one of them ends up silently unused.

### 4. The gate only runs if the file is called `middleware.ts`

Vercel detects `middleware.ts` or `middleware.js` at the repo root, and nothing else. Written as `middleware.mjs` it was never bundled — no error, no log, no warning. The first `/docs` deployment simply answered **200 to anyone** on every page.

This is the dangerous shape of failure: an auth gate that is missing fails *open*, and looks identical to a working one until you check without a cookie. After any change to the gate, verify from outside:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://mendwise.vercel.app/docs/
# expect: 302 https://mendwise.vercel.app/docs/gate/?next=%2Fdocs%2F
```

A `302` to the gate **without** `reason=unconfigured` means the middleware ran *and* found `DOCS_PASSPHRASE`.

## Env vars (names only)

Server-side, Production **and** Preview, never `EXPO_PUBLIC_` for secrets:

- `SUPABASE_URL` — present in prod. Check the **spelling** with `vercel env ls`, not just the presence: it sat there as `SUABASE_URL` for two days
- `SUPABASE_SERVICE_ROLE_KEY` — present in prod
- `REPLICATE_API_TOKEN`
- `AI_GATEWAY_API_KEY` and/or Vercel OIDC (`VERCEL_OIDC_TOKEN` was false on the snapshot; `AI_GATEWAY_API_KEY` was true)
- `DOCS_PASSPHRASE` — gates `/docs` only (HttpOnly cookie); set on Production and Preview. Missing → gate page with `reason=unconfigured`
- Optional: `MENDWISE_VLM_MODEL`, `MENDWISE_LLM_MODEL`, `SAM2_REPLICATE_VERSION`, `SAM2_POINTS_PER_SIDE`, `SAM2_MAX_MASKS`

Client (inlinable): `EXPO_PUBLIC_ASSESSMENT_V2`, `EXPO_PUBLIC_API_BASE`, `EXPO_PUBLIC_ANALYZE_URL`, `EXPO_PUBLIC_SEGMENT_URL`.

## Typecheck caveat

`npm run typecheck` is clean except a pre-existing, unrelated error in `src/components/app-tabs.web.tsx` (stale `/explore` route). Do not "fix" it as part of an unrelated change unless you mean to delete that dead web tab. Deployed request/response wrappers are covered by typecheck only — Node type-stripping cannot load `api/` without `.ts` extensions, so `smoke:live` exercises cores, not the HTTP handlers. Hit them once deployed.
