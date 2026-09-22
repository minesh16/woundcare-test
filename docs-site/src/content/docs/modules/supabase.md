---
title: Supabase
description: Schema, RLS, append-only audit log, and what is actually applied where.
---

Path: [`supabase/`](https://github.com/minesh16/woundcare-test/tree/main/supabase)

Local schema **has been applied** (`npm run db:migrate`) and round-tripped by `smoke:live`. Production Vercel is **not** pointed at it — see [Production status](/docs/operations/status/).

<!-- docs-hook:auto:start:files -->
| File | Role |
|---|---|
| `README.md` | Env vars, no `EXPO_PUBLIC_` prefix, degrade-safe posture |
| `migrations/0001_assessments.sql` | Five tables, RLS deny-by-default, revoke UPDATE/DELETE/TRUNCATE/TRIGGER |
<!-- docs-hook:auto:end:files -->

## Tables

| Table | Purpose |
|---|---|
| `assessments` | One row per assessment; `state` jsonb + denormalised axes / pathway / confidence / `rules_version` |
| `assessment_images` | Metadata only (bytes in Storage); `camera` \| `upload` |
| `wound_timeline` | One row per visit per `wound_id` — **table exists; UI does not** |
| `rules_version` | Which engine version was live when |
| `audit_log` | Per evaluate: input hash, axes, `pathway_withheld`, `gate_codes`, `referral_codes`, `models`, `steps` |

No name, DOB, or MRN column exists. Do not add one. `wound_id` is a client-generated grouping key, not a person id.

## Grants that matter

RLS enabled, **no policies** for `anon` / `authenticated` — a leaked publishable key grants nothing. Service role (used only from Vercel functions) bypasses RLS.

`TRUNCATE` is **not** mediated by RLS. Supabase grants it to `anon` by default; the migration revokes `TRUNCATE` (and `TRIGGER`) on all five tables, and `UPDATE`/`DELETE` on `audit_log`. Until that revoke, the "append-only audit log" claim was false.

Writes: [`api/v1/assessments/_store.ts`](https://github.com/minesh16/woundcare-test/blob/main/api/v1/assessments/_store.ts). `writeAudit` falling back to stdout means "it didn't throw" is not proof of a Postgres write — `smoke:live` checks the row is actually there.
