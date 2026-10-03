-- MendWise — module API (segmentation build spec §6A) + FUSegNet second opinion (§6.4).
--
-- Every table here is server-only: RLS on, no policies for anon/authenticated,
-- so only the service role (the Vercel functions) can read or write. No images
-- are stored anywhere in this migration — approvals bind to SHA-256 hashes.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- api_keys — per-organisation keys, stored HASHED, scoped per module.
-- The plaintext key is shown once, by scripts/create-api-key.mts, and never stored.
-- ---------------------------------------------------------------------------
create table if not exists public.api_keys (
  id                 uuid primary key default gen_random_uuid(),
  org_id             text not null,
  name               text not null,
  -- First 16 characters of the key (e.g. "mw_sandbox_ab12c"), for lookup and display.
  key_prefix         text not null unique,
  key_hash           text not null,
  -- Module scopes: segment, approve, measure, tissue, vlm, evaluate, report, run,
  -- baseline, analyze — or '*' for all.
  scopes             text[] not null default '{}',
  environment        text not null check (environment in ('sandbox', 'production')),
  rate_limit_per_min integer not null default 60 check (rate_limit_per_min > 0),
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);

-- ---------------------------------------------------------------------------
-- approvals — the clinician sign-off every image module requires (§6A.1).
-- Bound to the image and the final mask by hash, so an integrator cannot
-- approve one boundary and measure another.
-- ---------------------------------------------------------------------------
create table if not exists public.approvals (
  id              uuid primary key default gen_random_uuid(),
  key_id          text not null,
  org_id          text not null,
  assessment_id   text not null,
  image_sha256    text not null,
  mask_sha256     text not null,
  approval        text not null check (approval in ('approved', 'adjusted', 'drawn')),
  -- The caller's own clinician identifier. Opaque to us until clinician
  -- accounts exist (docs/SECURITY_AUDIT.md MW-01, P1).
  clinician_id    text,
  provider        text,
  model           text,
  correction_id   uuid,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '24 hours')
);
create index if not exists approvals_assessment_idx on public.approvals (assessment_id);

-- ---------------------------------------------------------------------------
-- Rate limiting — a fixed one-minute window per bucket, incremented atomically.
-- ---------------------------------------------------------------------------
create table if not exists public.api_rate_limits (
  bucket        text primary key,
  window_start  timestamptz not null,
  hits          integer not null
);

create or replace function public.api_rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, remaining integer, reset_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into public.api_rate_limits as r (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket) do update
    set hits = case when r.window_start = v_window then r.hits + 1 else 1 end,
        window_start = v_window
  returning r.hits into v_hits;

  return query select
    v_hits <= p_limit,
    greatest(p_limit - v_hits, 0),
    greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - now())))::integer);
end;
$$;
revoke all on function public.api_rate_limit_hit(text, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- idempotency_records — a retried POST with the same Idempotency-Key gets the
-- original response, not a second side effect.
-- ---------------------------------------------------------------------------
create table if not exists public.idempotency_records (
  key_id        text not null,
  idem_key      text not null,
  endpoint      text not null,
  request_hash  text not null,
  status        integer not null,
  response      jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (key_id, idem_key, endpoint)
);

-- ---------------------------------------------------------------------------
-- api_calls — the module API's audit log (§6A.2): input hashes, versions,
-- outcome, approval ids. No images, no masks, no free text from a model.
-- ---------------------------------------------------------------------------
create table if not exists public.api_calls (
  id              uuid primary key default gen_random_uuid(),
  request_id      text not null,
  at              timestamptz not null default now(),
  key_id          text,
  org_id          text,
  environment     text,
  endpoint        text not null,
  status          integer not null,
  latency_ms      integer not null,
  input_sha256    text,
  image_sha256    text,
  approval_id     text,
  api_version     text not null,
  engine_version  text not null,
  model_versions  jsonb,
  degraded        boolean not null default false,
  outcome         jsonb
);
create index if not exists api_calls_at_idx on public.api_calls (at desc);
create index if not exists api_calls_key_idx on public.api_calls (key_id, at desc);

-- ---------------------------------------------------------------------------
-- segmentation_corrections — second-opinion fields (§6.4) and the approval.
-- ---------------------------------------------------------------------------
alter table public.segmentation_corrections add column if not exists approval_id text;
alter table public.segmentation_corrections add column if not exists clinician_id text;
alter table public.segmentation_corrections add column if not exists second_opinion_status text;
alter table public.segmentation_corrections add column if not exists agreement_iou real;
alter table public.segmentation_corrections add column if not exists fusegnet_regions jsonb;
alter table public.segmentation_corrections add column if not exists fusegnet_mean_prob real;
alter table public.segmentation_corrections add column if not exists fusegnet_latency_ms integer;

-- ---------------------------------------------------------------------------
-- RLS: deny by default for every new table; the service role bypasses it.
-- ---------------------------------------------------------------------------
alter table public.api_keys            enable row level security;
alter table public.approvals           enable row level security;
alter table public.api_rate_limits     enable row level security;
alter table public.idempotency_records enable row level security;
alter table public.api_calls           enable row level security;

revoke all on
  public.api_keys,
  public.approvals,
  public.api_rate_limits,
  public.idempotency_records,
  public.api_calls
from anon, authenticated;
