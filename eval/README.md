# MendWise evaluation harness

Runs public wound datasets through the **current** MendWise pipeline (segmentation → coin / size → tissue % → engine), automatically and in-process, and scores the predictions against ground truth with 95% CIs. Spec: [`docs/MendWise_Eval_Harness_Build_Spec.md`](../docs/MendWise_Eval_Harness_Build_Spec.md). Things that would need an app change are in [`NOTES.md`](NOTES.md).

It imports the app's own functions and never modifies them. It writes only to the `eval_*` tables (migration `0004`) and to local files outside the repo. It never calls an HTTP endpoint, never writes to an app table, and never makes a frontier (VLM/LLM) call unless you pass `--with-vlm/--with-report/--with-baseline --yes`.

## Setup

```bash
cd eval && npm install && cd ..        # the harness's own deps (yaml); the app's package.json is untouched
npm run db:migrate                     # applies 0004_eval_harness.sql (idempotent); optional — without it, JSONL only
```

Keys come from the repo's `.env.local` (`FAL_KEY`, `FUSEGNET_MODAL_URL`/`FUSEGNET_AUTH_TOKEN`, `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`). Data and outputs live **outside the repo and outside OneDrive**:

| var | default | what |
|---|---|---|
| `EVAL_DATA_DIR` | `~/MendWiseEval/data` | downloaded datasets + `cache/<dataset>/` (normalised images, GT masks) |
| `EVAL_OUT_DIR` | `~/MendWiseEval/out` | items, runs, findings, provider response cache |
| `EVAL_CONCURRENCY` | 4 | workers |

## Quick start: onboard → ingest → run → read findings

```bash
# 1. Onboard (follow .cursor/rules/eval-dataset-onboarding.mdc): download into $EVAL_DATA_DIR/<id>, then
npx tsx eval/cli.mts profile --dir=$HOME/MendWiseEval/data/<id> --id=<id>   # → profile.json + dataset.draft.yaml
#    …write eval/datasets/<id>/dataset.yaml from the draft…
npx tsx eval/cli.mts ingest --dataset=<id> --dry-run                        # fix until 0 unmapped values
npx tsx eval/cli.mts ingest --dataset=<id>

# 2. Check the harness still matches the app's orchestrator (free, offline)
npx tsx eval/cli.mts parity

# 3. Estimate, then run
npx tsx eval/cli.mts estimate --datasets=fuseg2021,azh-woundclass --sample=50
npx tsx eval/cli.mts run      --datasets=fuseg2021,azh-woundclass --sample=50 --label=smoke

# 4. Read  ~/MendWiseEval/out/<runId>/findings.md   (also findings.json, items.csv, metrics.csv, confusion/)
```

Long runs headless: `nohup npx tsx eval/cli.mts run --datasets=all --sample=1100 --label=full1 > ~/MendWiseEval/out/full1.log 2>&1 &`. Ctrl-C (SIGINT/SIGTERM) finishes the in-flight items and marks the run `interrupted`; continue with `--resume=<runId>` (`--retry-failed` re-runs failures).

## Commands

```
profile  --dir=<abs> --id=<dataset>
ingest   --dataset=<id>|all [--dry-run]
parity
run      --datasets=<ids>|all [--sample=N] [--per-dataset=a:400,b:400] [--split=…] [--seed=42]
         [--seg=chain|sam3|fusegnet|hsv] [--boundary=auto|gt-mask|both] [--policy=image_only|label-axes]
         [--with-vlm] [--with-report] [--with-baseline] [--repeat=50] [--yes]
         [--fusegnet-trigger=foot|all] [--concurrency=4] [--fal-rpm=30] [--modal-rpm=30]
         [--label=<name>] [--resume=<runId>] [--retry-failed] [--no-score]
         [--budget=<usd>] [--no-cache] [--cache-epoch=v1]
estimate --datasets=… [run options]          # the cost table only, no calls
score    --run=<runId>
report   --run=<runId> [--baseline=<runId>]
compare  --base=<runId> --head=<runId>       # exits 2 if a gate that passed in base fails in head
status   [--run=<runId>]
cache    stats | clear [--host=fal.run|modal] [--before=<date>]
negatives [--count=50]                       # (re)generate the synthetic-negatives images
```

**One segmenter arm per run** (`SEGMENTATION_PROVIDERS` is process-wide). To compare segmenters, run each arm separately and `compare` them; the provider cache means the second arm re-uses every SAM 3 answer the first one paid for.

## Cost

Every run prints an estimate first (rates in [`costs.yaml`](costs.yaml), checked 4 Oct 2026) and refuses to start above `budget.hard_stop_usd` ($40) unless `--budget=<usd>` covers it; it also stops cleanly mid-run if actual spend passes the budget. Rough figures: 50-image smoke ≈ $0.30; 1,000 images on `chain` ≈ $5.30; a second arm on the same images ≈ $0 for SAM 3. Re-runs of a cached sample are free. `--no-cache` forces real calls (test–retest determinism).

## Datasets onboarded

| id | items | what it measures | in-distribution for FUSegNet |
|---|---|---|---|
| `fuseg2021` | 1,210 (1,010 with masks) | segmentation | yes |
| `azh-woundclass` | 538 photos + 200 non-wound patches | wound type, negatives | yes |
| `dfutissue` | 110 | tissue composition (granulation / fibrin / callus) | yes |
| `medetec` | see manifest | wound type across many categories | no |
| `synthetic-negatives` | 50 | negatives false-positive rate | no |

Excluded: WoundcareVQA (registration form), DFUC 2020–2022 (signed licence) — see `NOTES.md`.

## Tests

```bash
npx tsx eval/test/run.mts          # offline: no network, no Supabase; fixtures are generated procedurally
```

## Layout

`src/` — `env` (guards), `schema`/`vocab` (canonical GT + prediction), `io`, `manifest`, `profile`, `adapters/`, `ingest`, `sample`, `pipeline` + `engineInputs` (the only re-implemented logic, guarded by `parity`), `runner`, `providerCache`, `costs`, `score/`, `report`, `compare`, `sink` (eval_* only). `datasets/<id>/dataset.yaml` — one manifest per dataset. `test/` — the suite and its fixture generator.
