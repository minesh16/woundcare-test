-- MendWise — V2 assessment schema.
--
-- Design notes that matter more than the columns:
--
--  * De-identified by construction. There is no name, date of birth or record
--    number column anywhere in this schema, and none should be added. `wound_id`
--    groups one wound across visits; it is client-generated and does not
--    reference a person.
--
--  * `audit_log` is append-only by grant (see the policies at the bottom). The
--    trail of "these inputs, under this rules version, produced this pathway"
--    is only worth something if it cannot be quietly rewritten afterwards.
--
--  * Everything is written by the service role from the Vercel functions.
--    There is no anon write path, and RLS denies by default, so a leaked
--    publishable key grants nothing.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- assessments
-- ---------------------------------------------------------------------------
create table if not exists public.assessments (
  id              text primary key,
  wound_id        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  status          text not null default 'in_progress',
  cwcs_pathway_id smallint,
  tissue_type     text,
  exudate_level   text,
  infection       text,
  confidence      text,
  rules_version   text,
  -- Full AssessmentState. Kept as jsonb so a pipeline change doesn't need a
  -- migration; the columns above are the denormalised bits we query on.
  state           jsonb not null,
  constraint assessments_status_check check (status in ('in_progress', 'complete', 'incomplete')),
  constraint assessments_pathway_range check (cwcs_pathway_id is null or (cwcs_pathway_id between 1 and 26))
);

create index if not exists assessments_wound_id_idx on public.assessments (wound_id, created_at desc);

-- ---------------------------------------------------------------------------
-- assessment_images — metadata only; bytes live in Storage
-- ---------------------------------------------------------------------------
create table if not exists public.assessment_images (
  id             uuid primary key default gen_random_uuid(),
  assessment_id  text not null references public.assessments (id) on delete cascade,
  created_at     timestamptz not null default now(),
  source         text not null,
  storage_path   text not null,
  mask_path      text,
  px_per_cm      double precision,
  quality        jsonb,
  constraint assessment_images_source_check check (source in ('camera', 'upload'))
);

create index if not exists assessment_images_assessment_idx on public.assessment_images (assessment_id);

-- ---------------------------------------------------------------------------
-- wound_timeline — one row per visit, for area-reduction tracking
-- ---------------------------------------------------------------------------
create table if not exists public.wound_timeline (
  id              uuid primary key default gen_random_uuid(),
  wound_id        text not null,
  assessment_id   text not null references public.assessments (id) on delete cascade,
  recorded_at     timestamptz not null default now(),
  area_cm2        double precision,
  tissue_pct      jsonb,
  cwcs_pathway_id smallint
);

create index if not exists wound_timeline_wound_idx on public.wound_timeline (wound_id, recorded_at);

-- ---------------------------------------------------------------------------
-- rules_version — which engine version was live, and when
-- ---------------------------------------------------------------------------
create table if not exists public.rules_version (
  version     text primary key,
  deployed_at timestamptz not null default now(),
  notes       text
);

-- ---------------------------------------------------------------------------
-- audit_log — the regulatory asset. Append-only.
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id               uuid primary key default gen_random_uuid(),
  assessment_id    text not null,
  at               timestamptz not null default now(),
  inputs_hash      text not null,
  axes             jsonb not null,
  cwcs_pathway_id  smallint,
  pathway_withheld boolean not null default false,
  gate_codes       text[] not null default '{}',
  referral_codes   text[] not null default '{}',
  confidence       text,
  rules_version    text not null,
  models           jsonb,
  steps            jsonb
);

create index if not exists audit_log_assessment_idx on public.audit_log (assessment_id, at desc);
create index if not exists audit_log_rules_version_idx on public.audit_log (rules_version);

-- ---------------------------------------------------------------------------
-- RLS — deny by default; the service role bypasses RLS entirely.
-- No policies are created for anon/authenticated, so neither can read or write.
-- ---------------------------------------------------------------------------
alter table public.assessments       enable row level security;
alter table public.assessment_images enable row level security;
alter table public.wound_timeline    enable row level security;
alter table public.rules_version     enable row level security;
alter table public.audit_log         enable row level security;

-- Belt and braces on the audit trail: even a future policy that grants writes
-- cannot grant an UPDATE or DELETE that was never granted at the table level.
revoke update, delete on public.audit_log from anon, authenticated;

-- TRUNCATE is the one privilege row-level security does NOT mediate: an RLS
-- policy cannot stop it, so leaving Supabase's default grant in place would let
-- the `anon` role empty a table outright — which would quietly undo the
-- append-only property the audit trail depends on. Revoke it everywhere.
revoke truncate on
  public.assessments,
  public.assessment_images,
  public.wound_timeline,
  public.rules_version,
  public.audit_log
from anon, authenticated;

-- TRIGGER lets a role attach arbitrary functions to a table; nothing in this
-- app needs it from a client role.
revoke trigger on
  public.assessments,
  public.assessment_images,
  public.wound_timeline,
  public.rules_version,
  public.audit_log
from anon, authenticated;
