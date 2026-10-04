-- MendWise — evaluation harness (docs/MendWise_Eval_Harness_Build_Spec.md §18).
-- New tables only; nothing here references or alters the app's tables.
-- No images are stored: items point at files under the operator's EVAL_DATA_DIR.

create table if not exists public.eval_datasets (
  id                 text primary key,
  name               text not null,
  version            text,
  source_url         text,
  licence            text,
  image_source       text not null default 'public_dataset',
  known_training_use text[] not null default '{}',
  manifest           jsonb not null,
  profile            jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.eval_items (
  id             text primary key,                 -- '<dataset>:<key>'
  dataset_id     text not null references public.eval_datasets (id) on delete cascade,
  split          text,
  image_sha256   text not null,
  dhash          text,
  rel_path       text not null,                    -- relative to EVAL_DATA_DIR
  width          integer,
  height         integer,
  gt             jsonb not null,
  has_mask       boolean not null default false,
  has_tissue     boolean not null default false,
  has_type       boolean not null default false,
  has_exudate    boolean not null default false,
  has_infection  boolean not null default false,
  has_scale      boolean not null default false,
  strata         jsonb not null default '{}',
  duplicate_of   text,
  created_at     timestamptz not null default now(),
  unique (dataset_id, image_sha256)
);
create index if not exists eval_items_dataset_idx on public.eval_items (dataset_id);

create table if not exists public.eval_runs (
  id             text primary key,
  label          text,
  status         text not null default 'running' check (status in ('running','interrupted','complete','failed')),
  git_sha        text,
  git_dirty      boolean,
  rules_version  text not null,
  model_versions jsonb,
  config         jsonb not null,
  counts         jsonb,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create table if not exists public.eval_results (
  run_id        text not null references public.eval_runs (id) on delete cascade,
  item_id       text not null references public.eval_items (id) on delete cascade,
  arm           text not null,                     -- '<seg>|<boundary>|<policy>'
  status        text not null check (status in ('ok','failed','skipped')),
  prediction    jsonb,
  item_metrics  jsonb,
  timings       jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  primary key (run_id, item_id, arm)
);

create table if not exists public.eval_metrics (
  run_id          text not null references public.eval_runs (id) on delete cascade,
  arm             text not null,
  area            text not null,                   -- seg | meas | tissue | engine | vlm | ops | fairness | coverage
  metric          text not null,
  scope           text not null,                   -- 'overall' | 'dataset=…' | …
  value           double precision,
  ci_low          double precision,
  ci_high         double precision,
  n               integer,
  na_rate         double precision,
  in_distribution boolean not null default false,
  primary key (run_id, arm, area, metric, scope)
);

alter table public.eval_datasets enable row level security;
alter table public.eval_items    enable row level security;
alter table public.eval_runs     enable row level security;
alter table public.eval_results  enable row level security;
alter table public.eval_metrics  enable row level security;

revoke all on public.eval_datasets, public.eval_items, public.eval_runs, public.eval_results, public.eval_metrics
  from anon, authenticated;
