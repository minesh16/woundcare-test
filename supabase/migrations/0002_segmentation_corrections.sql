-- MendWise — segmentation correction log (segmentation build spec §4.1).
--
-- One row per approved boundary: how far the clinician moved the model's draft.
-- This is the "clinicians corrected X%" metric and the future fine-tuning
-- DATASET. Retraining on it later is a regulated change under TGA change
-- control, so it is described as a dataset, never as "self-learning".
--
-- De-identified by construction: an assessment id, a date (not a timestamp), the
-- body zone, and numbers. Mask images are stored ONLY when the image is not a
-- patient image (public dataset or synthetic) — enforced in code
-- (`mayStoreMasks` in api/v1/assessments/correction.ts) and again here by a
-- check constraint, so a future code path cannot quietly start storing them.
--
-- Idempotent: safe to re-run.

create table if not exists public.segmentation_corrections (
  id               uuid primary key default gen_random_uuid(),
  assessment_id    text not null,
  created_on       date not null default current_date,
  model            text,
  confidence       text check (confidence in ('high', 'medium', 'low')),
  score            real,
  approval         text not null check (approval in ('approved', 'adjusted', 'drawn')),
  iou              real check (iou is null or (iou >= 0 and iou <= 1)),
  ai_area_px       integer,
  final_area_px    integer,
  area_delta_pct   real,
  boundary_changed boolean,
  n_edits          integer not null default 0,
  n_taps           integer not null default 0,
  box_used         boolean not null default false,
  ms_to_approve    integer,
  wound_location   text,
  monk_tone        smallint check (monk_tone is null or monk_tone between 1 and 10),
  image_source     text not null check (image_source in ('public_dataset', 'synthetic', 'consented_demo')),
  -- Tissue confirmation (§4.3), filled in when the clinician confirms on the result screen.
  tissue_auto      text,
  tissue_final     text,
  tissue_override  boolean,
  -- Only for non-patient images; see the constraint below.
  ai_mask_png      text,
  final_mask_png   text,
  constraint segmentation_corrections_no_patient_masks check (
    image_source in ('public_dataset', 'synthetic')
    or (ai_mask_png is null and final_mask_png is null)
  )
);

create index if not exists segmentation_corrections_created_idx
  on public.segmentation_corrections (created_on desc);
create index if not exists segmentation_corrections_assessment_idx
  on public.segmentation_corrections (assessment_id);

-- ---------------------------------------------------------------------------
-- RLS: insert-only for anon; nobody but the service role reads rows.
-- The app writes through the server (service role bypasses RLS); the policy
-- exists so a future direct client write path cannot read anything back.
-- ---------------------------------------------------------------------------
alter table public.segmentation_corrections enable row level security;

drop policy if exists segmentation_corrections_anon_insert on public.segmentation_corrections;
create policy segmentation_corrections_anon_insert
  on public.segmentation_corrections
  for insert to anon
  with check (true);

revoke select, update, delete, truncate, trigger on public.segmentation_corrections from anon, authenticated;
grant insert on public.segmentation_corrections to anon;

-- ---------------------------------------------------------------------------
-- Reads: aggregates only, through a security-definer function (the WardCast
-- dashboard pattern). No row, mask or assessment id ever leaves through it.
-- ---------------------------------------------------------------------------
create or replace function public.segmentation_correction_stats()
returns table (
  n_approvals          bigint,
  n_unchanged          bigint,
  n_changed            bigint,
  pct_changed          numeric,
  mean_iou             numeric,
  median_area_delta_pct numeric,
  n_tissue_confirmed   bigint,
  n_tissue_overridden  bigint,
  median_ms_to_approve numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*),
    count(*) filter (where boundary_changed is false),
    count(*) filter (where boundary_changed is true),
    round(100.0 * count(*) filter (where boundary_changed is true) / nullif(count(*), 0), 1),
    round(avg(iou)::numeric, 3),
    round((percentile_cont(0.5) within group (order by area_delta_pct))::numeric, 1),
    count(*) filter (where tissue_final is not null),
    count(*) filter (where tissue_override is true),
    round((percentile_cont(0.5) within group (order by ms_to_approve))::numeric, 0)
  from public.segmentation_corrections;
$$;

revoke all on function public.segmentation_correction_stats() from public;
grant execute on function public.segmentation_correction_stats() to anon, authenticated;
