# MendWise — Evaluation & Validation Harness: Cursor Build Spec

**Version:** 1.1 (4 Oct 2026; adds the provider response cache §13.7 and the pre-filled costs.yaml + budget guard §13.6) · **Repo:** `/Users/minesh/Agents/woundcare-test` (GitHub `minesh16/woundcare-test`), written against HEAD `8d1dbfd`.
**Audience:** Cursor (Composer/agent). Read this spec in full before starting a phase. Then read `docs/HANDOFF.md` and `.cursor/rules/mendwise.mdc` for the app's invariants.
**Status:** spec only. No harness code exists yet.

---

## 0. How to use this spec in Cursor

Build in phases **E0 → E4** (§22). Each phase has a copy-paste prompt and acceptance checks. Finish one phase, and confirm its checks pass, before starting the next.

At the end of **every** phase, run these three checks:

```bash
git status --porcelain | grep -v '^??'
```
This must print **nothing**: no existing file may be modified. Only new, untracked files are allowed.

```bash
npm test
```
This must pass unchanged. It includes `test:rules`, 125/125 as of 4 Oct.

```bash
npx tsx eval/test/run.mts
```
This is the harness's own test suite, and it must pass.

---

## 1. Context and goal

MendWise's pipeline runs segmentation (SAM 3 on fal.ai → FUSegNet on Modal → HSV fallback), then coin measurement, HSI tissue %, the periwound band, the optional caged VLM, and finally the deterministic CWCS/Mölnlycke engine. Today the only accuracy evidence is the unit tests and `scripts/bench-segment.mts`, which runs one folder over HTTP and reports IoU and latency. The pitch (13 Oct 2026) and the scorecard ("technical feasibility", "responsible AI") need **measured performance at scale**. The team also needs a repeatable way to tell whether each code change made things better or worse.

**Build a backend harness that does four things:**
1. **Studies** each dataset's format (public now, team-uploaded later) and maps it onto **one canonical ground-truth schema**.
2. Runs **≥1,000 images fully automatically** through the current MendWise pipeline, in-process, with **no clinician steps**.
3. Logs every prediction to **new Supabase `eval_*` tables** and a local JSONL mirror.
4. Scores predictions against ground truth and emits **structured findings** (JSON + Markdown + CSV). The findings carry 95% confidence intervals, are stratified by dataset, wound type and skin tone, and can be diffed between runs.

Human (clinician) testing happens **separately**, on a different dataset. It is out of scope here.

---

## 2. Non-negotiables

1. **Zero touch on the app.**
   - Modify **no existing file**. That covers everything under `api/`, `src/`, `scripts/`, `supabase/migrations/0001–0003`, plus `package.json`, `package-lock.json`, `.gitignore`, `vercel.json`, `tsconfig.json`, `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/mendwise.mdc`.
   - Create **new files only**:
     - `eval/**`;
     - `supabase/migrations/0004_eval_harness.sql`;
     - `.cursor/rules/eval-dataset-onboarding.mdc`;
     - `docs/MendWise_Eval_Harness_Build_Spec.md` (this file).
   - If something seems to need an app change, **stop and write it up in `eval/NOTES.md`** for the team. Don't make the change.
2. **Import, don't modify.** Call the app's existing exported functions as they are (§11). Don't copy-paste engine or CV logic. The only thing re-implemented is the small engine-input mapping, and the parity check guards it (§12).
3. **No new npm scripts and no new dependencies in the root `package.json`.** Run everything with `npx tsx eval/cli.mts …`. If the harness needs a library the repo lacks, give `eval/` **its own `package.json`** and install there with `cd eval && npm i <pkg>`. A YAML parser and an XLSX reader are the likely candidates (`yaml`, `xlsx`). Commit `eval/package.json` and `eval/package-lock.json`, and ignore `eval/node_modules` with a new `eval/.gitignore`. That file is new, so it doesn't break rule 1.
4. **Never write to existing tables.** That means `assessments`, `assessment_images`, `wound_timeline`, `rules_version`, `audit_log`, `api_keys`, `approvals`, `api_rate_limits`, `idempotency_records`, `api_calls` and `segmentation_corrections`.
   - **Never call** `runAssessment`, `saveAssessment`, `writeAudit`, `appendTimeline`, `logSegmentation`, `createApproval`, `writeCorrection`, or any HTTP endpoint.
   - The one exception is `parity`, which calls `runAssessment` in a child process with the database env removed (§12).
5. **No clinician steps.** No approvals and no review. The model's draft boundary is used exactly as returned (the `auto` arm).
6. **No frontier (VLM/LLM) calls by default.** `--with-vlm`, `--with-report` and `--with-baseline` are opt-in. Before any frontier run, print the estimated call count and require `--yes`. **Paid segmentation calls are budget-guarded too:** every run prints a cost estimate first, and refuses to start above `costs.yaml` `budget.hard_stop_usd` unless `--budget` is passed (§13.6).
7. **Public, directly downloadable datasets only.** If getting a dataset needs a form, an application, a signed agreement, an approval email or a login gate, it is out (§23).
8. **Data stays out of the repo and out of OneDrive.**
   - Images and masks live in `EVAL_DATA_DIR` (default `~/MendWiseEval/data`).
   - Outputs live in `EVAL_OUT_DIR` (default `~/MendWiseEval/out`).
   - Commit manifests only, never images.
9. **Production guard.** `eval/cli.mts` exits with an error if `process.env.VERCEL` is set or `NODE_ENV === 'production'`.
10. **Secrets.** Read keys from the repo's existing `.env.local` (gitignored), the same way `scripts/dev-server.mts` does, and never print them. Before any commit, run the commit-hygiene check: no `.env*` file other than `.env.example` may be staged.

---

## 3. Directory layout (all new)

```
eval/
  README.md                       quick start: onboard → ingest → run → read findings
  NOTES.md                        anything that would need an app change (for the team)
  package.json / package-lock.json / .gitignore   (only if extra deps are needed; ignore node_modules)
  thresholds.yaml                 acceptance gates (§14.10)
  costs.yaml                      provider cost rates, pre-filled 4 Oct 2026; re-check before big runs (§13.6)
  datasets/
    fuseg2021/dataset.yaml
    azh-woundclass/dataset.yaml
    medetec/dataset.yaml
    dfutissue/dataset.yaml
    woundcarevqa/dataset.yaml     (only if directly downloadable)
    synthetic-negatives/dataset.yaml
    <id>/adapter.ts               optional escape hatch (§8.7)
  fixtures/                       tiny synthetic datasets generated by eval/test/makeFixtures.mts
  src/
    env.ts          load .env.local, resolve EVAL_DATA_DIR/EVAL_OUT_DIR, the production guard
    schema.ts       Zod schemas: GroundTruth, Prediction, EvalItem, ResultRow, Findings (§5)
    vocab.ts        canonical enums + mapping helpers (§5.3)
    io.ts           decode/encode JPEG/PNG, sha256, dHash, mask helpers (§9.3)
    manifest.ts     dataset.yaml loader + Zod validation (§6)
    profile.ts      dataset format profiler (§7)
    adapters/
      index.ts      registry: name → Adapter
      folderMasks.ts  classFolders.ts  tabular.ts  coco.ts  labelme.ts  custom.ts
    ingest.ts       manifest → canonical items (§9)
    sample.ts       seeded stratified sampler (§10)
    pipeline.ts     the automatic pipeline (§11)
    engineInputs.ts the engine-input mapping (§11.3)
    parity.ts       drift check vs runAssessment (§12)
    runner.ts       worker pool, resume, cost estimate + budget guard, progress (§13)
    providerCache.ts  HTTP-level cache of fal.ai / Modal responses, harness process only (§13.7)
    score/
      segmentation.ts measurement.ts tissue.ts engine.ts vlm.ts ops.ts fairness.ts
      stats.ts       bootstrap, Wilson, McNemar, κ, Bland–Altman, calibration bins (§15)
      index.ts       scoreRun(runId) → metric rows + findings (§14)
    report.ts       findings.json / findings.md / items.csv / confusion CSVs (§16)
    compare.ts      run-vs-run diff (§17)
    sink.ts         Supabase eval_* writer + JSONL mirror (§18)
  test/
    run.mts         harness test runner
    makeFixtures.mts
    *.test.mts
  cli.mts           entry point (§19)
supabase/migrations/0004_eval_harness.sql   (§18)
.cursor/rules/eval-dataset-onboarding.mdc   (§20)
```

Import style: run under `tsx`, which resolves extensionless relative imports and the `@/` tsconfig path. That matches how `scripts/dev-server.mts` and `scripts/test-segment-chain.mts` already import `api/` modules.

---

## 4. Environment

The harness reads the existing `.env.local`, using the same loader pattern as `scripts/dev-server.mts`: an explicitly set environment variable wins over the file.

| Var | Used for | Required |
|---|---|---|
| `FAL_KEY` | SAM 3 (existing) | for `sam3`/`chain` arms |
| `FUSEGNET_MODAL_URL`, `FUSEGNET_AUTH_TOKEN` (or the names the app uses) | FUSegNet (existing) | for `fusegnet`/`chain` arms |
| `SEGMENTATION_PROVIDERS` | provider order; **the harness sets it per run** (§11.2) | no |
| `FUSEGNET_TRIGGER` | second-opinion trigger; the harness sets it per run from config | no |
| `AI_GATEWAY_API_KEY` / OIDC | only with `--with-vlm/report/baseline` | opt-in |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `sink.ts` (eval_* tables only) | no; without them the harness writes JSONL only and warns |
| `EVAL_DATA_DIR` | dataset root (default `~/MendWiseEval/data`) | no |
| `EVAL_OUT_DIR` | outputs (default `~/MendWiseEval/out`) | no |
| `EVAL_CONCURRENCY` | worker count (default 4) | no |

Check the actual FUSegNet env names in `api/_fusegnet.ts` (`isFusegnetConfigured` reads `FUSEGNET_MODAL_URL`). Use whatever the app reads, and don't rename anything.

---

## 5. Canonical schema (`eval/src/schema.ts`, `eval/src/vocab.ts`)

Every dataset maps **into** `GroundTruth`. Every pipeline run maps **into** `Prediction`. The two share field names and enums, so the scorers never need dataset-specific code.

### 5.1 Enums (`vocab.ts`)

```ts
export const WOUND_TYPES = ['diabetic_foot','venous','arterial','pressure','surgical','traumatic','burn','other'] as const;
export const TISSUE_CLASSES = ['granulation','slough','necrotic','epithelial','other'] as const;     // % classes
export const DOMINANT_TISSUE = ['necrotic','slough','granulating','epithelialising'] as const;      // = ClinicianTissueChoice
export const EXUDATE = ['low','moderate','high'] as const;                                          // engine ExudateLevel
export const YES_NO = ['yes','no'] as const;
export const SKIN_TONE_SCALE = ['monk','fitzpatrick','ita_proxy'] as const;
export const PROVENANCE = ['expert','crowd','derived','synthetic'] as const;
```

Tissue-class synonyms the label maps will need:
- fibrin / yellow → `slough`
- eschar / black → `necrotic`
- callus / hyperkeratosis / bone / tendon → `other`

Keep the raw value in `rawLabels`. Never drop it.

### 5.2 GroundTruth / Prediction

```ts
const pct = z.number().min(0).max(100);
const tissuePct = z.object({ granulation: pct, slough: pct, necrotic: pct, epithelial: pct, other: pct });

export const GroundTruth = z.object({
  woundPresent: z.boolean().optional(),
  woundType: z.enum(WOUND_TYPES).optional(),
  pressureStage: z.enum(['1','2','3','4','unstageable','dti']).optional(),
  bodyZone: z.string().optional(),            // an id from src/constants/bodyZones.ts, e.g. foot_left
  woundMaskPath: z.string().optional(),       // relative to EVAL_DATA_DIR/cache/<dataset>/ (binary PNG, image frame)
  tissueMaskPaths: z.record(z.enum(TISSUE_CLASSES), z.string()).optional(),
  tissuePct: tissuePct.optional(),            // derived from tissue masks if not given
  tissueClassesLabelled: z.array(z.enum(TISSUE_CLASSES)).optional(), // which classes the dataset can label (DFUTissue has no epithelial)
  dominantTissue: z.enum(DOMINANT_TISSUE).optional(),
  exudate: z.enum(EXUDATE).optional(),
  infection: z.enum(YES_NO).optional(),
  ischaemia: z.enum(YES_NO).optional(),
  markerPresent: z.boolean().optional(),
  lengthCm: z.number().positive().optional(),
  widthCm: z.number().positive().optional(),
  areaCm2: z.number().positive().optional(),
  expectedPathwayId: z.number().int().min(1).max(26).optional(),
  expectedReferralCodes: z.array(z.string()).optional(),
  skinTone: z.object({ scale: z.enum(SKIN_TONE_SCALE), value: z.number() }).optional(),
  provenance: z.record(z.string(), z.enum(PROVENANCE)).optional(),   // per field
  rawLabels: z.record(z.string(), z.unknown()).default({}),
});

export const Prediction = z.object({
  woundPresent: z.boolean(),                  // false when no plausible mask
  maskPath: z.string().nullable(),            // EVAL_OUT_DIR/<run>/masks/<item>__<arm>.png
  segmentation: z.object({
    source: z.enum(['sam3','fusegnet','hsv']).nullable(),
    model: z.string().nullable(), score: z.number().nullable(),
    confidence: z.enum(['high','medium','low']), plausibility: z.string(),
    multipleRegions: z.boolean().nullable(), candidates: z.number(), latencyMs: z.number(),
    attempts: z.array(z.object({ provider: z.string(), status: z.string(), ms: z.number(), reason: z.string().optional() })),
    secondOpinion: z.object({ status: z.string(), agreementIoU: z.number().nullable() }).nullable(),
    areaPx: z.number().nullable(), frame: z.object({ width: z.number(), height: z.number() }),
  }),
  measurement: z.object({
    markerFound: z.boolean(), pxPerCm: z.number().nullable(), coinSupport: z.number().nullable(),
    areaCm2: z.number().nullable(), lengthCm: z.number().nullable(), widthCm: z.number().nullable(),
    perimeterCm: z.number().nullable(), whiteBalanced: z.boolean(), classifier: z.enum(['absolute','relative']).nullable(),
  }).nullable(),
  tissuePct: tissuePct.nullable(),
  tissuePctRelative: tissuePct.nullable(),     // measurement.comparison.relative
  tissueSentinel: z.boolean(),                // true if the 20/20/20/20/20 "nothing considered" fallback appeared (§24)
  periwound: z.object({ rednessPct: z.number(), maceration: z.boolean() }).nullable(),
  dominantTissue: z.enum(DOMINANT_TISSUE).nullable(),   // from engine axes.tissue (necrotic_ischaemic → necrotic)
  exudate: z.enum(EXUDATE).nullable(),        // engine axes.exudate
  infection: z.enum(YES_NO).nullable(),       // engine axes.infection
  engine: z.object({
    status: z.enum(['complete','incomplete']), pathwayWithheld: z.boolean(), gateCodes: z.array(z.string()),
    cwcsPathwayId: z.number().nullable(), confidence: z.enum(['high','medium','low']),
    referrals: z.array(z.object({ urgency: z.string(), code: z.string() })), incompleteReasons: z.array(z.string()),
    rulesVersion: z.string(),
  }),
  vlm: z.object({ source: z.string(), model: z.string().nullable(), features: z.unknown().nullable(), latencyMs: z.number() }).nullable(),
  report: z.object({ source: z.string(), cageViolation: z.boolean(), model: z.string().nullable() }).nullable(),
  baseline: z.object({ text: z.string().nullable(), model: z.string().nullable() }).nullable(),
  skinToneProxy: z.object({ itaDeg: z.number(), band: z.string() }).nullable(),   // §14.8
  timings: z.record(z.string(), z.number()),  // ms per stage
  errors: z.array(z.object({ stage: z.string(), message: z.string() })),
});
```

### 5.3 Mapping helpers

`mapLabel(field, raw, labelMap)` returns `{ value } | { unmapped: raw }`. It is case-insensitive and trims whitespace. Unmapped values are **counted and reported**, never coerced.

`dominantFromPct(pct)` must use **the engine's own precedence**, so ground truth and prediction agree on definitions. Import `reconcileTissue` and `TISSUE_PRESENCE_THRESHOLD` from `src/decision/engine.ts` and call them. Don't re-implement them. Map `necrotic_ischaemic` to `necrotic`.

---

## 6. Dataset manifest (`eval/datasets/<id>/dataset.yaml`)

Validate the manifest with Zod in `manifest.ts`. Here is a complete example:

```yaml
id: fuseg2021
name: Foot Ulcer Segmentation Challenge 2021
version: "2021"
source_url: https://github.com/uwm-bigdata/wound-segmentation   # verify exact repo/path during onboarding
access: direct_download            # only value allowed (§2.7)
licence: "<paste the licence text or 'none stated' + URL checked, date>"
image_source: public_dataset
known_training_use: [fusegnet]     # FUSegNet trained on AZH/FUSeg → in-distribution (§14.9)
root: fuseg2021                    # under EVAL_DATA_DIR
adapter: folderMasks
splits:                            # optional; folder → split name
  train: train
  validation: validation
  test: test
options:
  images: "{split}/images"
  masks:  "{split}/labels"         # same filename stem as the image
  mask_threshold: 127
  # test-split labels may be withheld → items without a mask still ingest (no woundMaskPath)
defaults:                          # applied to every item unless the adapter sets the field
  bodyZone: foot_left
  woundPresent: true
  woundType: diabetic_foot
  provenance: { woundMaskPath: expert, woundType: derived }
labelMap: {}
strata: [split]                    # extra fields to stratify on
sample_weight: 1.0
```

Fields:

| Key | Meaning |
|---|---|
| `adapter` | one of `folderMasks`, `classFolders`, `tabular`, `coco`, `labelme`, `custom` |
| `options` | adapter-specific (§8) |
| `defaults` | GroundTruth fields applied to every item |
| `labelMap` | `{ <canonicalField>: { <raw value>: <canonical value> } }` |
| `fieldMap` | (tabular/json) `{ <canonicalField>: <column or JSON path> }` |
| `tissueMaskMap` | `{ <pixel value or RGB hex>: <TISSUE_CLASS> }` for palette tissue masks |
| `tissueClassesLabelled` | which tissue classes the dataset can label at all |
| `known_training_use` | models known to have been trained on this data |
| `externalProcessingConsent` | required `true` for any non-public dataset. fal.ai, Modal and the AI Gateway process data outside Australia. |
| `exclude` | glob list of files to skip |

---

## 7. Profiler (`eval/src/profile.ts`)

Command: `npx tsx eval/cli.mts profile --dir=<abs path> --id=<dataset-id>`.

It writes `EVAL_OUT_DIR/profiles/<id>/profile.json` and `eval/datasets/<id>/dataset.draft.yaml`. It never overwrites an existing `dataset.yaml`.

The profile records:

1. **Tree:** a depth-limited directory tree (≤4 levels, ≤20 entries per directory), file counts per directory, and an extension histogram.
2. **Images:** count; width/height min/median/max (read the header only, as `imageSize()` in `api/_segmentationParse.ts` does); format; and whether any files have EXIF orientation set.
3. **Pairing:** for each directory pair (A, B) where B's names look like masks (`mask|label|gt|seg|annotation` in the path), the fraction of A's stems matched in B. This also handles suffixes like `_mask` and `_gt`.
4. **Masks:** on a sample of up to 50 masks, the unique pixel values or colours. If there are ≤3 values it is binary; if there are more, list the palette with each value's pixel share. A palette suggests tissue classes.
5. **Tables:** for every CSV, TSV or XLSX file: the headers, row count, and per column the cardinality plus up to 15 most frequent values. Also flag which column looks like a join key, i.e. the one whose values match image stems.
6. **JSON:** detect the flavour:
   - **COCO:** has `images`, `annotations` and `categories`.
   - **LabelMe:** has `shapes` and `imagePath`.
   - **VQA/metadata:** an array of objects with image references and attribute keys. Report each key, its value cardinality and the top values.
7. **Class folders:** if image directories have sibling names that look like classes (e.g. `Venous/`, `Diabetic/`), list them with their counts.
8. **Duplicates:** count exact duplicates by sha256, and near-duplicates by dHash (Hamming distance ≤ 4).
9. **Suggested adapter:** the profiler's best guess, its confidence, and a filled-in **draft manifest**.

The profiler is deterministic and makes no network calls. Cursor's onboarding rule (§20) does the reasoning on top of its output.

---

## 8. Adapters (`eval/src/adapters/*`)

```ts
export interface Adapter {
  name: string;
  /** Yield raw items: an image path plus whatever labels the format carries. */
  enumerate(manifest: Manifest, root: string): AsyncIterable<RawItem>;
}
export type RawItem = {
  key: string;                    // stable within the dataset (relative image path, no extension)
  imagePath: string;              // absolute
  split?: string;
  maskPath?: string;              // binary wound mask
  tissueMaskPath?: string;        // palette tissue mask
  polygons?: { label: string; points: [number, number][] }[];  // image pixel coords
  labels: Record<string, unknown>; // raw fields (folder name, CSV row, JSON attrs)
};
```

`ingest.ts` turns a `RawItem` into a `GroundTruth` using the manifest's `defaults`, `fieldMap`, `labelMap` and `tissueMaskMap`.

1. **`folderMasks`** — `options.images` and `options.masks`, which may contain the `{split}` placeholder. Matches files by stem and accepts mask suffixes such as `_mask` and `_gt`. Optionally reads `options.tissue_masks`.
2. **`classFolders`** — the label comes from the parent folder name, with `options.label_field` defaulting to `woundType`. Map folder names to canonical values with `labelMap.woundType`.
3. **`tabular`** — `options.table` is CSV, TSV, XLSX or JSONL; `options.key_column` names the key column. `options.image_pattern` gives the image path for a key, e.g. `"images/{key}.jpg"`. Map columns to canonical fields with `fieldMap`. Each row can carry several images (`options.image_columns`).
4. **`coco`** — polygons or RLE are rasterised into the wound mask. Categories map to `woundPresent`/tissue classes via `labelMap.category`. To rasterise a polygon, call the app's `rasterisePolygon` from `api/_maskGeometry.ts` with fractional points.
5. **`labelme`** — reads one JSON file per image; its `shapes` become polygons and are rasterised the same way as in `coco`.
6. **`custom`** — dynamically imports `eval/datasets/<id>/adapter.ts`, which must export an `Adapter`.
7. **Escape-hatch rule:** use `custom` only when YAML can't express the format. Keep custom adapters under 150 lines and include a top-of-file comment explaining why.

---

## 9. Ingest (`eval/src/ingest.ts`)

Command: `npx tsx eval/cli.mts ingest --dataset=<id> [--dry-run]`.

For each raw item, ingest does the following:
1. **Read the image.** Apply the EXIF orientation, compute `image_sha256` over the original bytes (use `imageSha256` from `api/_image.ts` so the hash matches the app's) and compute the dHash.
2. **Normalise ground-truth masks to the analysis frame.** Run the image through `normaliseImage(base64)` from `api/_image.ts`, which caps the longer edge at 1,024 and returns `{ width, height, base64 }`. Resample each GT mask to exactly that `width × height` with nearest neighbour (`resampleMask` in `api/_maskIO.ts`, after `loadMaskPixels`, which accepts a PNG data URI). Save the result to `EVAL_DATA_DIR/cache/<dataset>/masks/<key>.png`. **Every mask comparison happens on this grid.**
3. **Derive tissue percentages from tissue masks.** Count pixels per class *inside the wound*: the union of the tissue classes, or the wound mask if one exists. Only classes listed in `tissueClassesLabelled` are scored (§14.5).
4. **Build the `GroundTruth`** from defaults, mapped fields and `rawLabels`.
5. **Write the item.** It goes to `eval_items` (upserted on `dataset_id + image_sha256`) and to `EVAL_OUT_DIR/items/<dataset>.jsonl`.
6. **Report coverage.** Write a coverage report (`EVAL_OUT_DIR/ingest/<dataset>/coverage.json` and `.md`):
   - item count and failures with reasons;
   - per-field coverage %;
   - **unmapped raw values per field, with counts**;
   - duplicates within the dataset and across datasets, matched on sha256 and dHash.

`--dry-run` writes the coverage report only. **Acceptance for a dataset:** zero unmapped values, or each remaining one listed under `labelMap._ignore` with a reason.

**Cross-dataset duplicates.** AZH, FUSeg and DFUTissue all come from the same clinic, so near-duplicates across datasets are likely. Keep the first occurrence in this order: `fuseg2021 → dfutissue → azh-woundclass → medetec → woundcarevqa`. Record the others in `eval_items.duplicate_of`; the sampler skips them.

---

## 10. Sampling (`eval/src/sample.ts`)

`run --datasets=a,b,c --sample=N --seed=42 [--per-dataset=a:400,b:400] [--split=validation,test]`

- **Stratify** within each dataset by `woundType`, plus any `strata` fields from the manifest.
- **Allocate** by `--per-dataset` if given. Otherwise allocate proportionally to `sample_weight × available`, with a floor of `min(30, available)` per dataset.
- **Deterministic:** the same seed and item set always produce the same list. Store the list in `eval_runs.config.items`, so a run can be reproduced exactly.
- **Default target:** `fuseg2021:400, azh-woundclass:400, medetec:200, dfutissue:110, woundcarevqa:150, synthetic-negatives:50`. That is about 1,310 items, or fewer once inaccessible sets are dropped.

---

## 11. The automatic pipeline (`eval/src/pipeline.ts`)

It mirrors what the app does across `/segment` → `/measure` → `/run`, minus the clinician gate and the persistence. It calls only existing exports.

### 11.1 Stages

```ts
import { normaliseImage } from '../../api/_image';
import { runSegmentation } from '../../api/_segmentation';
import { loadMaskPixels, resampleMask, toPngDataUri } from '../../api/_maskIO';
import { compareMasks } from '../../api/_maskGeometry';
import { maskPlausibility } from '../../api/_segmentationParse';
import { analyzeTissue } from '../../api/v1/assessments/tissue';
import { evaluate, CWCS_RULES_VERSION } from '../../src/decision/engine';
// opt-in only:
import { cropsFromMask } from '../../api/_crops';
import { extractVlmFeatures } from '../../api/v1/assessments/vlm-features';
import { composeReport } from '../../api/v1/assessments/report';
import { callGateway } from '../../api/v1/assessments/_gateway';
import { violatesCage } from '../../src/decision/reportCage';
```

For each item × arm, the pipeline runs these steps. Time each one into `timings` and catch errors into `errors[]`. **A failed stage must not crash the item.**

1. **Normalise.** `img = normaliseImage(originalBase64)`. All later steps use `img.base64`, so every grid lines up.
2. **Segment** (`auto` arm). Call `runSegmentation({ image: img, prompts: null, bodyZone: gt.bodyZone ?? manifest.defaults.bodyZone ?? null })`. This is the same call `/segment` makes with no taps or box. Record the whole outcome in `prediction.segmentation`. If `outcome.mask` is null, set `woundPresent = false` and skip to step 5 with an empty tissue result.
   - **Caching:** fal and Modal calls go through the provider response cache (§13.7). `runSegmentation` itself always runs. Only its network calls are replayed, so the app's selection, plausibility and chain logic run fresh on every item, and a SAM 3 result is paid for once per image no matter how many arms use it.
   - **`gt-mask` arm:** skip `runSegmentation` and use the cached GT wound mask, as a PNG data URI on the `img` grid. `prediction.segmentation.source` is set to `null`, with `model = 'ground_truth'`.
3. **Plausibility.** Call `maskPlausibility(areaPx, totalPx)` and record the verdict. It does **not** gate the pipeline. The app shows implausible masks to the clinician, and here the result is simply scored.
4. **Measure + tissue.** Call `analyzeTissue({ base64: img.base64, mask: maskDataUri, maskProvider: source === 'sam3' || source === 'fusegnet' ? source : null, measure: true, includeCoinReference: true })`. From the result:
   - `tissue` → `tissuePct`, mapping `necrotic` to `necrotic`;
   - `measurement.comparison.relative` → `tissuePctRelative`;
   - `measurement.scale`, `geometry` and `whiteBalance` → `prediction.measurement`;
   - `periwound` → `periwound`.

   Set `tissueSentinel = true` if all five tissue values equal 20.
5. **VLM** (only with `--with-vlm`). Load the mask with `loadMaskPixels(maskDataUri)`, build crops with `cropsFromMask(img.base64, maskPixels)`, then call `extractVlmFeatures({ base64: img.base64, woundCrop, periwoundCrop, tissueSummary })`. That is the same sequence as `_controller.ts` step 3.
6. **Engine inputs.** Build them with `buildEngineInputs(...)` (§11.3) according to the input policy (§11.4).
7. **Decide.** `result = evaluate(inputs)`. Map `result.axes` to the prediction's `dominantTissue`, `exudate` and `infection`, mapping `necrotic_ischaemic` to `necrotic` and `granulating`/`epithelialising` as they are. Copy the engine fields across.
8. **Report** (only with `--with-report`). Call `composeReport({ result, areaCm2, bodyZoneLabel, tissuePct })` and record `source` and `model`. Set `cageViolation = Boolean(violatesCage(report.clinicianReport, result) ?? violatesCage(report.patientSummary, result))`. The signature in `src/decision/reportCage.ts` is `violatesCage(text, result): string | null`, returning the violation reason or null. Store that reason too.
9. **Baseline** (only with `--with-baseline`). Call `callGateway('vlm', …)` with the **exact** prompt from `api/v1/assessments/baseline.ts` ("Assess this wound and recommend a dressing."). Store the text verbatim in `eval_results.prediction.baseline` only. The baseline text is never scored automatically for correctness: it is free text. See §14.7.
10. **Write the predicted mask** as a PNG to `EVAL_OUT_DIR/<run>/masks/<itemId>__<arm>.png`. Public datasets only (§2).

### 11.2 Provider order per run

`runSegmentation` reads `process.env.SEGMENTATION_PROVIDERS` each time it is called, through `providerOrder()` in `api/_segmentation.ts`. The arms set it like this:
- `chain` leaves it unset, so the app's default order applies (`sam3,fusegnet`).
- `sam3` sets `SEGMENTATION_PROVIDERS=sam3`.
- `fusegnet` sets `SEGMENTATION_PROVIDERS=fusegnet`.
- `hsv` **can't** be selected through `SEGMENTATION_PROVIDERS`. `parseProviderOrder` in `api/_segmentationParse.ts` treats an empty or all-unknown value as the default order. Instead, set `process.env.FAL_KEY = ''` and `process.env.FUSEGNET_MODAL_URL = ''` before the first call. `isSam3Configured()` and `isFusegnetConfigured()` read the env on every call, so both providers are recorded as `skipped (not configured)` and the chain uses its HSV fallback. This matches how `scripts/dev-server.mts` lets an explicitly empty var force a degraded mode. It also costs nothing.

Because the variable is process-wide, **one run uses one segmenter arm**. To compare segmenters, launch separate runs and diff them with `compare`. Do **not** interleave arms inside one process.

Set `FUSEGNET_TRIGGER` from the run config. The default is the app's (`foot`); pass `--fusegnet-trigger=all` to get a second opinion on every image.

### 11.3 Engine-input mapping (`eval/src/engineInputs.ts`)

This is the only re-implemented logic. It copies two existing sources:

- **The overrides `_controller.ts` applies** (`runAssessment` step 4):
  - `tissue`: `{ necrosis: t.necrotic, slough: t.slough, granulation: t.granulation, epithelial: t.epithelial, other: t.other }`;
  - `vlm`: the features, or undefined;
  - `periwound`: `{ rednessPct, maceration }`, or undefined.
- **The base inputs the app sends**, which the client builds through `measuredView` in `src/assessment/measured.ts` and `rules.ts`:
  - `markerFound = scale !== null`;
  - `cvConfidence = maskAreaPx <= 500 ? 'low' : (scale && whiteBalance.applied ? 'high' : 'medium')`;
  - `periwound` only when a scale exists;
  - `manualSizeProvided = false`.

  Prefer to call `measuredView({ measurement: … } as ScanSession)` directly and read `.confidence` and `.markerFound` from it. Fall back to re-implementing only if the session typing makes that impractical, and in that case add a test that compares the two.

### 11.4 Input policies

| Policy | exudate / infection / perfusion | Use |
|---|---|---|
| `image_only` (default) | not provided | scores segmentation, measurement, tissue and the engine's **gate behaviour**. Expect `incomplete` on nearly every item; that is correct behaviour, not a failure. |
| `image+vlm` (`--with-vlm`) | from the VLM only, via the engine's own reconciliation | the fully automatic decision; pathway and referral metrics are meaningful |
| `label-axes` (diagnostic) | from `GroundTruth.exudate`, `.infection`, `.ischaemia → perfusion` where present | tissue → pathway behaviour with no frontier spend; items with no labelled axes are skipped for decision metrics |

Record the policy in the run config and in every `eval_results.arm` string, e.g. `chain|auto|image_only`.

---

## 12. Parity check (`eval/src/parity.ts`)

Command: `npx tsx eval/cli.mts parity`.

This check guards against the harness drifting from the app's real orchestrator without touching the app. It runs in **two stages**.

**Stage A: the child process.**
1. Spawn a child process: `npx tsx eval/src/parity.child.mts`.
2. Give it an environment with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and every `AI_GATEWAY_*` / `VERCEL_OIDC_TOKEN` variable **removed**. Also blank `FAL_KEY` and `FUSEGNET_MODAL_URL`, the HSV-only setup from §11.2, so parity costs nothing and is deterministic.
3. For about 5 fixture images:
   - build a mask with the harness pipeline;
   - construct an in-memory `ApprovalRecord`, with `id: 'parity-…'`, `keyId: 'eval-parity'`, `approval: 'drawn'` and the other fields filled in;
   - call `runAssessment({ state, base64, engineInputs, mask, approval }, () => {})`.
4. With no database configured, the app's `_store.ts` returns early and `writeAudit` logs to stdout (verified in `api/v1/assessments/_store.ts`), so nothing is persisted. With no gateway, the VLM degrades to `unavailable` and the report falls back to its template.
5. The child process prints `state.result` and `state.engineInputs` as JSON.

**Stage B: the parent process.**
1. Run `pipeline.ts` on the same image with the same mask, using `image_only` plus the same base inputs.
2. Assert deep equality on `result.status`, `axes`, `cwcsPathwayId`, `referrals[].code`, `gateCodes` and `confidence`, and on the engine-input `tissue` and `periwound`.
3. On a mismatch, print a diff and exit with code 1.

**Safety assertion.** Before spawning the child, verify that `SUPABASE_URL` is absent from its environment. Abort if it is present.

**When parity fails,** treat it as a signal that the app's orchestration changed. Update `engineInputs.ts`, never the app.

---

## 13. Runner (`eval/src/runner.ts`)

Command: `npx tsx eval/cli.mts run [options]` (§19). It works through these steps:

1. **Create the run.** Write an `eval_runs` row with:
   - `id = run-<yyyymmdd-hhmm>-<label>`;
   - `git_sha` from `git rev-parse HEAD`, and `git_dirty` from `git status --porcelain`;
   - `rules_version = CWCS_RULES_VERSION`;
   - `model_versions`, from the app's env and default labels (SAM 3 model, FUSegNet label, VLM/LLM model ids when used);
   - the config: arms, policy, seed, sample spec, item list and concurrency.
2. **Worker pool.** Concurrency comes from `EVAL_CONCURRENCY` or `--concurrency`, default 4.
   - **Per-provider token buckets:** `--fal-rpm` defaults to 30 and `--modal-rpm` to 30. Gateway calls are limited to 2 at a time.
   - **Retries:** transient errors are retried with exponential backoff and jitter, up to 3 attempts.
   - **Recording:** a failed item is recorded with `status: 'failed'` and an `error`. Don't abort the run.
3. **Resume.** On start, load the existing `(run_id, item_id, arm)` keys from the JSONL mirror and Supabase. Skip any key whose status is `ok`. `--resume=<runId>` continues an earlier run; `--retry-failed` re-runs its failed items.
4. **Persist incrementally.** Write each result to `EVAL_OUT_DIR/<run>/results.jsonl` with an append and fsync, and upsert it to `eval_results` in batches of 25. **A crash loses at most the in-flight items.**
5. **Progress.** Print a single status line every 5 s showing done/total, ok/failed, rate, ETA and the p50 latency for each stage. Write the same data to `EVAL_OUT_DIR/<run>/progress.json`.
6. **Cost.** See §13.6 for the rates, the estimator and the budget guard. The short version:
   - Print the estimate before the run starts.
   - Refuse to start above the budget unless `--budget` is passed.
   - Require `--yes` for any frontier flag.
   - Track actual billed calls (cache misses) against cache hits, and record both in `eval_runs.counts`.
7. **Headless use:**

   ```bash
   nohup npx tsx eval/cli.mts run --datasets=all --sample=1100 --label=full1 > ~/MendWiseEval/out/full1.log 2>&1 &
   ```

   `tmux` works too. On SIGINT/SIGTERM, flush the buffers, mark the run `interrupted`, and exit cleanly.
8. **Finish.** When all items are done, call `score` and then `report` automatically. Skip that with `--no-score`.

**Expected scale.** At concurrency 4 with a few seconds per SAM 3 call, 1,000 items take somewhere between tens of minutes and about an hour. Re-running a sample that's already cached makes no paid calls (§13.7).

### 13.6 Cost: rates, estimator and budget guard

**`eval/costs.yaml`** is committed **pre-filled** with these rates, checked 4 Oct 2026. Re-check them before a big run, because providers change prices.

```yaml
# MendWise eval harness — provider cost rates. Last checked: 2026-10-04.
# Estimates only. The provider dashboards are the source of truth for billing.
currency: USD

providers:
  sam3:                              # fal.ai, fal-ai/sam-3/image (api/_sam3.ts)
    billing: per_request
    usd_per_request: 0.005
    source: https://fal.ai/models/fal-ai/sam-3/image
    checked: 2026-10-04

  fusegnet:                          # Modal, CPU container (~/Agents/fusegnet-modal/fusegnet_app.py: cpu=4.0, memory=8192)
    billing: per_second
    cpu_cores: 4
    memory_gib: 8
    usd_per_core_second: 0.0000131
    usd_per_gib_second: 0.00000222
    # derived container rate: 4 × 0.0000131 + 8 × 0.00000222 = 0.00007016 USD/s ≈ 0.25 USD/h
    est_seconds_per_call: 5          # PLACEHOLDER: replace with the measured p50 of FUSegNet `latency_ms` after the smoke run
    cold_start_seconds: 13           # measured on /health (docs/HANDOFF.md: 12.5–13.4 s cold)
    scaledown_window_seconds: 300    # container stays warm 5 min after the last request
    region_multiplier: 1.0           # set to 1.5–1.75 if the Modal app is ever pinned to a region
    source: https://modal.com/pricing
    checked: 2026-10-04
    note: The Modal Starter plan's monthly credit may cover this entirely. Check the Modal dashboard.

  gateway:                           # Vercel AI Gateway, only with --with-vlm / --with-report / --with-baseline
    billing: per_call_estimate
    usd_per_vlm_call: null           # fill before the first frontier run (free-tier models may cost $0)
    usd_per_llm_call: null

budget:
  warn_usd: 10                       # print a warning above this
  hard_stop_usd: 40                  # refuse to start (and stop mid-run) above this unless --budget=<usd>
```

**Estimator** (`runner.ts`, printed before the first item):
- **`sam3_calls`** = the items in arms `chain` or `sam3` whose SAM 3 request is **not already in the cache**. The cache is checked by building each request key up front (§13.7).
- **`fusegnet_calls`** = the sum of:
  - second opinions: items whose `bodyZone` matches `FUSEGNET_TRIGGER`, or every item if the trigger is `all`;
  - standalone calls in the `fusegnet` arm;
  - an allowance for fallbacks: 5% of the chain items, a placeholder until the smoke run measures the real SAM 3 failure rate;
  
  minus cache hits.
- **SAM 3 cost** = `sam3_calls × usd_per_request`.
- **Modal cost** = `rate × region_multiplier × (fusegnet_calls × est_seconds_per_call + bursts × (cold_start_seconds + scaledown_window_seconds))`.
  - `rate` = `cpu_cores × usd_per_core_second + memory_gib × usd_per_gib_second`.
  - `bursts` = 1 per run, plus 1 for each gap longer than the scaledown window. Estimate this as 1.
- **Gateway cost** = calls × the per-call rate, and **only** when a frontier flag is set. If the rate is `null`, refuse with "fill costs.yaml first".
- **Output:** print a table of calls, cache hits and USD for each provider, and the total.
- **Budget:** warn above `warn_usd`. Above `hard_stop_usd`, exit unless `--budget=<usd>` is passed. During the run, track the actual spend from real (missed) calls, and if it passes the budget, stop cleanly with status `interrupted`, so it can be resumed.
- **After the run:** write the actual calls, hits and estimated USD per provider to `eval_runs.counts`, and add a cost line to `findings.md`. If FUSegNet's measured p50 `latency_ms` differs from `est_seconds_per_call` by more than 50%, print a reminder to update `costs.yaml`.

**Expected cost at these rates.** These are the reference numbers to sanity-check the estimator against:

| Run | SAM 3 | FUSegNet (Modal) | Total |
|---|---|---|---|
| 50-image smoke run | $0.25 | ~$0.02 | **~$0.30** |
| 1,000 images, `chain`, default trigger (second opinion on ~500 foot images) | $5.00 | ~$0.15–0.30 | **~$5.30** |
| 1,000 images, `chain`, `--fusegnet-trigger=all` | $5.00 | ~$0.25–0.60 | **~$5.60** |
| Then a `sam3` arm on the same images | **$0** (cache hits) | — | **$0** |
| Then a `fusegnet` arm on the same images | — | ~$0.25–0.60 | **~$0.25–0.60** |
| Any `hsv` run, or any re-run of a cached sample | $0 | $0 | **$0** |

So a full comparison of chain, SAM 3 alone and FUSegNet alone on 1,000 images is **about $6**. Budget about $25 to cover smoke runs, debugging and a second full run after an app change that alters the requests.

### 13.7 Provider response cache (`eval/src/providerCache.ts`)

**Why at the HTTP level.** Caching the whole segmentation outcome would have two problems:
- the result of a `chain` run could not be reused by a `sam3` run;
- changes to the app's own selection logic would be hidden behind stale results.

Instead, the harness caches the **raw provider responses**. It does this by wrapping `globalThis.fetch` **inside the harness process only**. Both providers call the global `fetch` (`api/_sam3.ts`, `api/_fusegnet.ts`) with deterministic JSON bodies built by `sam3Request` / `fusegnetRequest` in `api/_segmentationParse.ts`, so the app needs no changes.

**What it intercepts:**
- `POST` to `https://fal.run/*` (SAM 3).
- `POST` to the origin of `FUSEGNET_MODAL_URL` (FUSegNet).
- `GET` to `*.fal.media`, which is only used if `SAM3_SYNC_MODE=false`. In that mode SAM 3 returns mask URLs rather than inline data URIs, and they have to be cached too, because the URLs can expire.

Everything else, including the gateway, Supabase and any other host, passes straight through untouched.

**The cache key:**
- `sha256(method + '\n' + url + '\n' + body + '\n' + epoch)`.
  - **Never include request headers.** That is where `Authorization: Key …` and `Bearer …` live, and secrets must not affect keys or reach disk.
  - `epoch` = `--cache-epoch`, default `v1`, plus `FUSEGNET_MODEL_LABEL` for Modal requests. Bump the epoch when the FUSegNet deployment or weights change, because its URL and request body stay the same across redeploys.
- **What falls out of this:**
  - The SAM 3 request for an image is byte-identical in `chain` and `sam3` runs: same normalised image, prompt `"wound"`, no points or box. So the second arm is a cache hit. **This is the fix that saves the second $5.**
  - FUSegNet's second-opinion request carries SAM 3's box, while a standalone call carries none. They are different requests and are correctly cached separately.
  - The fal model id is part of the URL, so a model change misses the cache automatically.

**Storage:**
- Location: `EVAL_OUT_DIR/cache/http/<key[0:2]>/<key>.json`.
- Contents: `{ host, path, status, contentType, body, storedAt, epoch }`. The body is the response text, base64 for binary responses.
- **Cache only 2xx responses.** Timeouts, 4xx and 5xx responses are never cached, so failed items retry on the next run.
- Write the file atomically (temp file, then rename), so concurrent workers can't corrupt an entry.
- On a hit, return `new Response(body, { status, headers: { 'content-type': contentType } })`. The app's parsers see exactly what they saw live.

**Safety and correctness:**
- Install the wrapper in `cli.mts` **before** any `api/` module is imported. Assert that it is installed before the first segmentation call.
- If `SAM3_SYNC_MODE === 'false'`, warn that mask URLs will be fetched and cached as well.
- Only public-dataset images (§23) go through the cache. Its bodies contain image-derived masks and stay outside the repo and OneDrive. If a dataset's `image_source` is not `public_dataset`, disable the cache for that dataset.
- `--no-cache` bypasses it entirely. Use it for E4 test–retest determinism, which needs real repeat calls.
- **Counters:** count hits and misses per host and feed them into the cost tracking (§13.6) and `eval_runs.counts`.
- **CLI:** `npx tsx eval/cli.mts cache stats` reports entries, size and hits per host; `cache clear [--host=fal.run|modal] [--before=<date>]` clears entries.

---

## 14. Metrics (`eval/src/score/*`)

Each scorer produces **per-item metrics**, stored in `eval_results.item_metrics`, and **aggregates**, stored in `eval_metrics`.

Every aggregate is computed for these scopes:
- `overall`;
- `dataset=<id>`;
- `woundType=<t>`;
- `skinTone=<band>`;
- `segSource=<sam3|fusegnet|hsv>`;
- `confidence=<h|m|l>`.

Each aggregate row carries `value`, `ci_low`, `ci_high`, `n` and `na_rate`.

Notation: P is the predicted mask and G the ground-truth mask, both on the analysis grid. TP, FP and FN are pixel counts.

### 14.1 Coverage
These come from ingest and run status:
- items ingested and failed;
- items run, ok and failed per stage;
- label coverage per field;
- unmapped labels;
- duplicates removed.

### 14.2 Segmentation (items with G; `auto` arm)

| Metric | Definition |
|---|---|
| Dice | 2TP / (2TP+FP+FN); both masks empty → 1 |
| IoU | TP / (TP+FP+FN). **Cross-check:** for one item per run, assert that it matches `compareMasks(P, G, w, h).iou` from `api/_maskGeometry.ts`. |
| Precision / Recall | TP/(TP+FP), TP/(TP+FN) |
| HD95 | 95th-percentile symmetric Hausdorff distance between boundary pixels, in px and as % of the image diagonal |
| Boundary F1 | F1 of boundary pixels matched within a tolerance of 2 px |
| Area error % | (areaP − areaG)/areaG × 100; report the median of the absolute value plus the signed bias |
| Fallback rate | share of items where `source = 'hsv'` |
| No-mask rate | share of items where `source = null` |
| Implausible rate | share of items where `maskPlausibility ≠ 'plausible'` |
| Multi-region rate | share of items where `multipleRegions = true` |
| Prompt-conflict rate | share of items where `promptConflict = true`. Should be 0, since the harness sends no taps. |
| **Calibration** | (a) mean IoU for each `confidence` band; (b) IoU in deciles of `score`; (c) the thresholds `t` on `score` that maximise the share of items with IoU ≥ 0.7 that land above `t`. This informs the app's placeholder 0.80/0.50 thresholds as **advisory output only**. Never change the app. |
| Second-opinion value | where `secondOpinion.status = 'ok'`: Pearson and Spearman correlation between `agreementIoU` and true IoU; the AUROC of `agreementIoU` for predicting IoU < 0.5 |
| Negatives FP rate | on items with `woundPresent = false`: the share where a plausible mask was returned. Report per provider, because FUSegNet has no abstain. |

### 14.3 Measurement
Computed only on items whose GT has `markerPresent` or a cm measurement. **Public datasets mostly lack these, so expect N/A** until team data with a coin is added.
- **Coin sensitivity:** the share of items with `markerPresent = true` where `markerFound` is true.
- **Coin false-detection rate:** the share of items with `markerPresent = false` where `markerFound` is true.
- **Errors:** relative errors for `areaCm2`, `lengthCm` and `widthCm`, reported as median absolute % and signed bias.
- **Agreement:** Bland–Altman bias and 95% limits of agreement for area.
- **Rates:** white-balance applied rate, overall, and the share of items with no scale.

### 14.4 Tissue composition (items with `tissuePct` in GT)
- **Per-class MAE** in percentage points, for **labelled classes only**. If `tissueClassesLabelled` lacks `epithelial`, for example, skip that class. To make the comparison like-for-like, renormalise both prediction and GT over the labelled classes plus `other` before scoring.
- Score both the `absolute` classifier (`tissuePct`) and the `relative` one (`tissuePctRelative`), so the team can decide on the app's `TISSUE_RELATIVE` flag. Report the result as an advisory.
- **Sentinel rate:** the share of items where `tissueSentinel` is true.
- **Split by arm:** report everything separately for the `auto` and `gt-mask` arms. The difference between them is the error that segmentation contributes.

### 14.5 Dominant tissue (items with `dominantTissue` in GT, or derived from GT `tissuePct`)
- Accuracy, macro-F1 and Cohen's κ against the engine's tissue axis, `prediction.dominantTissue`. Where the engine leaves the axis null (withheld), count the item as **abstained**: report the abstention rate separately and score accuracy over the items that weren't withheld. Report both numbers.
- A 4×4 confusion matrix plus an `abstain` column, written to `confusion/dominant_tissue.csv`.

### 14.6 Engine and decision
**Every policy** reports:
- the completion rate;
- the withheld rate (`pathwayWithheld`);
- the distribution of `gateCodes`;
- the top `incompleteReasons` by frequency.

**The `image+vlm` and `label-axes` policies** also report the following:

| Metric | Definition |
|---|---|
| Axis accuracy | exudate and infection vs GT, over the items labelled for that axis |
| Pathway exact match | where `expectedPathwayId` exists, or where GT supplies tissue, exudate and infection, which yields the expected pathway via `lookupPathway` from the engine |
| **Urgent-referral sensitivity** | of the items whose GT implies an urgent referral, the share where the prediction raised a referral with `urgency: 'urgent'`. The GT trigger comes from `expectedReferralCodes`, or is derived by running `molnlyckeFlags` on GT-derivable inputs: GT infection with spreading signs, GT ischaemia, and so on. This is the **headline safety metric**. |
| Over-referral rate | predicted urgent referral when GT implies none |
| **Unsafe-confident rate** | `status = complete` AND `confidence = 'high'` AND the pathway is not the GT pathway, over the items with a GT pathway |
| Engine replay consistency | `evaluate` called on **GT axes alone** (tissue override from GT dominant tissue, plus GT exudate and infection) must reproduce `lookupPathway` for 100% of items. Anything less means a bug in the harness or a table-transcription problem. Report it, and file it in `NOTES.md`. |

### 14.7 VLM, report and baseline (opt-in)
- **Infection signs:** for each sign in `infectionSigns`, sensitivity and specificity against GT infection. Count `uncertain` as its own outcome, not as absent.
- **Exudate:** the agreement of `visualExudate`, mapped to low/moderate/high, with GT exudate.
- **Uncertainty:** the share of `uncertain` answers per field.
- **Schema violations:** must be 0. Any VLM response that fails `vlmFeaturesSchema` from `src/decision/vlm.schema.ts` counts as a violation.
- **Determinism:** with `--repeat=50`, re-run the VLM on 50 random items and report field-level agreement.
- **Report:** the `cageViolation` rate.
- **Baseline:** store the text only. Report how often it names a specific dressing or product, using a simple keyword list in `eval/src/score/vlm.ts`, as the comparison with MendWise's grounded output. **Never send it to an LLM judge.**

### 14.8 Fairness
- **Skin tone:** use `GroundTruth.skinTone` where it exists. Otherwise compute an **ITA° proxy** from the periwound band: the median L\* and b\* of pixels in a ring dilated 2–6% of the image diagonal outside the mask, using `rgbToLab` from `src/cv/tissueClassifier.ts`. The formula is `ITA = atan((L*−50)/b*) × 180/π`.
- **Bands:** very light >55, light 41–55, intermediate 28–41, tan 10–28, brown −30–10, dark <−30.
- **Labelling:** always mark these values `ita_proxy`, with the note *"image-derived proxy, not a clinical skin-tone measure; affected by lighting"*.
- **What to report:** every headline metric (Dice, tissue MAE, dominant-tissue accuracy, coin sensitivity, urgent-referral sensitivity) for each band, plus the **largest gap between bands**, with CIs. Suppress any band with n < 10 and flag it.

### 14.9 Contamination
For any dataset whose `known_training_use` includes `fusegnet`, every metric for items where `segmentation.source = 'fusegnet'` is tagged `in_distribution: true`. That covers runs with `--seg=fusegnet`, and chain runs where FUSegNet answered. Findings show those metrics separately and never fold them into a generalisation figure. SAM 3 is zero-shot and is not flagged.

### 14.10 Ops and gates
**Ops metrics:**
- p50/p90/p99 latency for each stage (segment, measure, vlm, evaluate, report);
- error rate and degraded rate per stage;
- throughput in items per minute;
- calls versus cache hits per provider;
- estimated cost.

**Gates (`eval/thresholds.yaml`).** These are team-agreed starting points:

```yaml
gates:
  urgent_referral_sensitivity: { metric: engine.urgent_referral_sensitivity, op: ">=", value: 0.95, min_n: 20 }
  unsafe_confident_rate:       { metric: engine.unsafe_confident_rate,       op: "<=", value: 0.02, min_n: 50 }
  dice_auto_generalisation:    { metric: seg.dice.mean, scope: "in_distribution=false", op: ">=", value: 0.80, min_n: 100 }
  coin_sensitivity:            { metric: meas.coin_sensitivity,              op: ">=", value: 0.90, min_n: 20 }
  area_error_median:           { metric: meas.area_abs_pct_err.median,       op: "<=", value: 15, min_n: 20 }
  vlm_schema_violations:       { metric: vlm.schema_violation_rate,          op: "==", value: 0, min_n: 1 }
  negatives_fp_rate:           { metric: seg.negatives_fp_rate,              op: "<=", value: 0.10, min_n: 30 }
```

Each gate evaluates to `PASS`, `FAIL`, `INSUFFICIENT_N` (n is below `min_n`) or `NOT_RUN` (the policy doesn't produce that metric).

---

## 15. Statistics (`eval/src/score/stats.ts`)

- **Proportions:** use the **Wilson** 95% interval.
- **Means, medians and other continuous metrics:** use a **percentile bootstrap** with 2,000 resamples over items, seeded so results are reproducible.
- **Paired accuracy comparison (in `compare`):** use the **McNemar** exact test.
- **Paired continuous comparison:** use a **paired bootstrap** of the difference, reporting the 95% CI and the share of resamples above 0.
- **Agreement:** Cohen's κ (unweighted), and Bland–Altman bias with limits at bias ± 1.96 SD.
- **Calibration:** decile bins and a monotonicity check.
- **Testing:** every function gets a unit test against values worked out by hand (§21).

---

## 16. Findings (`eval/src/report.ts`)

All output goes to `EVAL_OUT_DIR/<runId>/`.

**`findings.json`**, where `schema: "mendwise-eval-findings/1"`:
```json
{
  "schema": "mendwise-eval-findings/1",
  "run": { "id": "run-20261008-1530-smoke", "label": "smoke", "git_sha": "…", "git_dirty": false,
           "rules_version": "cwcs-2024.1+recon.1", "model_versions": { "segmentation": "fal-ai/sam-3/image", "second_opinion": "fusegnet-effb7-pscse", "vlm": null, "llm": null },
           "arms": ["chain|auto|image_only"], "policy": "image_only", "seed": 42, "started": "…", "finished": "…",
           "counts": { "items": 50, "ok": 49, "failed": 1, "fal_calls": 50, "modal_calls": 12, "cache_hits": { "fal": 0, "modal": 0 }, "est_usd": { "sam3": 0.25, "fusegnet": 0.02, "gateway": 0 } } },
  "datasets": [ { "id": "fuseg2021", "n": 30, "licence": "…", "in_distribution_for": ["fusegnet"], "coverage": { "woundMaskPath": 1.0 } } ],
  "gates": [ { "id": "dice_auto_generalisation", "status": "PASS", "value": 0.83, "ci": [0.80, 0.86], "n": 120 } ],
  "metrics": [ { "area": "seg", "metric": "dice.mean", "scope": "dataset=fuseg2021", "arm": "chain|auto|image_only",
                 "value": 0.81, "ci_low": 0.77, "ci_high": 0.85, "n": 30, "na_rate": 0.0, "in_distribution": false } ],
  "failures": { "seg": [ { "item": "fuseg2021:validation/0123", "dice": 0.05, "source": "hsv", "reason": "sam3 failed: timeout" } ] },
  "fairness": { "scale": "ita_proxy", "note": "image-derived proxy …", "max_gap": { "seg.dice.mean": 0.07 } },
  "notes": [ "Pathway metrics not available under image_only (engine correctly withholds without exudate/infection).",
             "FUSegNet metrics on fuseg2021/azh are in-distribution." ],
  "baseline_comparison": null
}
```

**`findings.md`** is filled from a template. It contains no LLM-written text. Its sections are:
1. Run summary
2. Gates table
3. Segmentation, overall and per dataset, with the contamination note
4. Tissue
5. Engine behaviour
6. Fairness
7. Ops and cost
8. Top failures, with item ids and mask paths
9. Limitations: N/A areas, proxy skin tone, public-data caveats, no clinician in the loop

**Other files:**
- `items.csv`: one row per item × arm, with the key per-item metrics and prediction fields flattened.
- `confusion/*.csv`: dominant tissue, wound type (when the type is predicted; it is not today, so the file is omitted), and exudate/infection where scored.
- `metrics.csv`: the `eval_metrics` rows in long format.

---

## 17. Compare (`eval/src/compare.ts`)

Command: `npx tsx eval/cli.mts compare --base=<runId> --head=<runId>`.

- Pair the two runs on `item_id`, and on `arm` where it matches.
- For each headline metric, report the delta, a paired CI and a p-value: McNemar for accuracies, paired bootstrap for Dice and MAE.
- List the items that **flipped**: a pathway that changed, Dice that moved by more than 0.2, a referral gained or lost.
- Write `compare-<base>-vs-<head>.md` and `.json` to `EVAL_OUT_DIR/compare/`.
- Exit with code 2 if any gate that passed in `base` fails in `head`. That makes the command usable as a regression check later.

---

## 18. Storage: `supabase/migrations/0004_eval_harness.sql` (new file)

This migration is idempotent, uses the same style as 0001–0003, creates new tables only, and turns RLS on with no policies, so only the service role can access them. It touches no existing table, function or grant. Apply it with the existing `npm run db:migrate`; the script loops over every migration, and each one is idempotent.

```sql
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
```

`sink.ts` creates its own Supabase client from `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` with `@supabase/supabase-js`. That package is already a root dependency, so importing it is fine. **Don't import `api/_supabase.ts`.** Keeping a separate client makes it structurally clear that the harness writes only `eval_*`. Give the sink an allow-list check: throw if the target table doesn't start with `eval_`.

---

## 19. CLI reference (`eval/cli.mts`)

```
npx tsx eval/cli.mts profile  --dir=<abs> --id=<dataset>
npx tsx eval/cli.mts ingest   --dataset=<id>|all [--dry-run]
npx tsx eval/cli.mts parity
npx tsx eval/cli.mts run      --datasets=<ids>|all [--sample=N] [--per-dataset=a:400,b:400] [--split=…] [--seed=42]
                              [--seg=chain|sam3|fusegnet|hsv] [--boundary=auto|gt-mask|both] [--policy=image_only|label-axes]
                              [--with-vlm] [--with-report] [--with-baseline] [--repeat=50] [--yes]
                              [--fusegnet-trigger=foot|all] [--concurrency=4] [--fal-rpm=30] [--modal-rpm=30]
                              [--label=<name>] [--resume=<runId>] [--retry-failed] [--no-score]
                              [--budget=<usd>] [--no-cache] [--cache-epoch=v1]
npx tsx eval/cli.mts score    --run=<runId>
npx tsx eval/cli.mts report   --run=<runId> [--baseline=<runId>]
npx tsx eval/cli.mts compare  --base=<runId> --head=<runId>
npx tsx eval/cli.mts status   [--run=<runId>]
npx tsx eval/cli.mts cache    stats | clear [--host=fal.run|modal] [--before=<date>]
npx tsx eval/cli.mts estimate --datasets=… [run options]      # prints the §13.6 cost table, makes no calls
```

`--with-vlm` implies `--policy=image+vlm`.

---

## 20. Cursor rule: `.cursor/rules/eval-dataset-onboarding.mdc` (new file, content below)

```markdown
---
description: How to onboard a new wound dataset into the MendWise eval harness
globs: eval/datasets/**
alwaysApply: false
---

# Onboarding a dataset into eval/

Spec: docs/MendWise_Eval_Harness_Build_Spec.md (§6–§9, §23). Never modify app code (api/, src/, scripts/).

1. **Access check first.** The dataset must download directly — no form, application, signed
   agreement, approval email or login gate. If not, STOP, add it to eval/NOTES.md as "excluded:
   not directly downloadable", and do nothing else.
2. Record `source_url`, the licence text (or "none stated" + the URL you checked + date) in the manifest.
3. Download into $EVAL_DATA_DIR/<id>/ (never into the repo or OneDrive).
4. `npx tsx eval/cli.mts profile --dir=$EVAL_DATA_DIR/<id> --id=<id>`; read profile.json, the
   draft manifest, 5–10 sample files, and the dataset's README/paper.
5. Write eval/datasets/<id>/dataset.yaml: adapter, options, defaults, fieldMap, labelMap,
   tissueMaskMap, tissueClassesLabelled, known_training_use, image_source: public_dataset.
   Map onto the canonical enums in eval/src/vocab.ts; keep raw values in rawLabels.
6. Only if YAML cannot express the format, write eval/datasets/<id>/adapter.ts (≤150 lines, comment why).
7. `npx tsx eval/cli.mts ingest --dataset=<id> --dry-run` → fix until coverage shows zero unmapped
   values (or each is in labelMap._ignore with a reason).
8. `npx tsx eval/cli.mts ingest --dataset=<id>`; commit the manifest (and adapter) only — never data.
9. If the dataset was used to train any model in the pipeline, list it in known_training_use.
```

---

## 21. Tests (`eval/test/run.mts`)

These are offline: no network, no Supabase. `eval/test/makeFixtures.mts` generates the synthetic data, such as a skin-coloured background with a red/yellow/black ellipse "wound", a grey 20c-sized coin, and the matching masks. It produces:
- a `folderMasks` fixture;
- a `classFolders` fixture;
- a `tabular` fixture (CSV);
- a `coco` fixture;
- a `labelme` fixture;
- a tissue-palette fixture;
- negatives.

The suite must cover:
1. **Stats:** Dice/IoU/precision/recall/HD95/boundary-F1 on hand-made 10×10 masks; Wilson; bootstrap reproducibility under a fixed seed; McNemar; κ; Bland–Altman.
2. **IoU parity:** the harness IoU equals `compareMasks(...).iou` from `api/_maskGeometry.ts`.
3. **Adapters:** each adapter on its fixture produces the expected `GroundTruth`. Unmapped labels are reported, not coerced.
4. **Ingest:** masks are resampled onto the `normaliseImage` grid; dedupe by sha256 and dHash works.
5. **Sampler:** deterministic for a given seed; respects per-dataset quotas.
6. **Pipeline:** on a fixture with `--seg=hsv`, all stages run with the network disabled.
7. **Engine replay consistency:** 100% on the fixtures.
8. **Resume:** after an interrupted run, a resume skips the completed keys.
9. **Guards:** the production guard trips with `VERCEL=1`. With a mocked client, the sink refuses any table not prefixed `eval_`.
10. **No app writes:** spy on `@supabase/supabase-js` `from()` during a pipeline run; only `eval_*` tables may appear.
11. **Provider cache** (a mocked fetch that counts calls, standing in for fal and Modal):
    - two arms on the same image (`chain`, then `sam3`) make **one** SAM 3 call;
    - a FUSegNet request with a box and one without get different keys;
    - `Authorization` never appears in a stored file or a key;
    - non-2xx responses and timeouts are not cached;
    - `--no-cache` bypasses the cache;
    - a cache hit returns a `Response` the app's parser accepts unchanged.
12. **Cost estimator and budget:**
    - the §13.6 reference table reproduces from the pre-filled `costs.yaml`: 1,000 chain items with ~500 foot items ≈ $5.30;
    - an estimate above `hard_stop_usd` refuses to start without `--budget`;
    - when actual spend passes the budget mid-run, the run stops cleanly as `interrupted`.

---

## 22. Build phases (prompts for Cursor)

### E0: foundations (target Mon 6 Oct)

> **Prompt:** "Read docs/MendWise_Eval_Harness_Build_Spec.md §1–§5, §11–§12, §18–§19 and §21. Build E0: eval/src/env.ts (with the production guard), schema.ts, vocab.ts, io.ts, the sink.ts with the eval_-only allow-list, supabase/migrations/0004_eval_harness.sql, pipeline.ts, engineInputs.ts and parity.ts (+ parity.child.mts), a cli.mts skeleton with `parity`, makeFixtures.mts, and the tests for stats (partial), guards, IoU parity and the pipeline on the hsv fixture. Do not modify any existing file."

**Acceptance:**
- `npx tsx eval/cli.mts parity` exits 0.
- `npx tsx eval/test/run.mts` is green.
- `npm run db:migrate` applies 0004 cleanly, and running it again is a no-op.
- `git status --porcelain | grep -v '^??'` is empty, and `npm test` is unchanged.

### E1: onboarding and ingest (target Tue 7 Oct)

> **Prompt:** "Build §6–§9 and §20: manifest.ts, profile.ts, the five built-in adapters plus custom.ts, ingest.ts, and the onboarding rule. Then follow the onboarding rule for fuseg2021 and azh-woundclass (§23). Add the adapter tests."

**Acceptance:**
- Both datasets are profiled and ingested.
- Their coverage reports show zero unmapped values.
- Licence and source are recorded.
- `eval_items` has the rows.
- No existing file is modified.

### E2: run, score, report (target Wed 8 Oct, the numbers for the pitch)

> **Prompt:** "Build §10, §13–§16: sample.ts, runner.ts (resume, token buckets, progress), providerCache.ts (§13.7), the cost estimator + budget guard reading eval/costs.yaml (§13.6, commit costs.yaml exactly as given), the `estimate` and `cache` commands, all scorers, stats.ts, report.ts. Run `npx tsx eval/cli.mts estimate --datasets=fuseg2021,azh-woundclass --sample=50`, then `run … --label=smoke`, then a kill-and-resume test, then re-run the same sample with `--seg=sam3` and confirm it makes zero fal calls."

**Acceptance:**
- `findings.json`, `findings.md`, `items.csv` and `metrics.csv` are produced.
- The resume skips the completed items.
- `eval_results` and `eval_metrics` are populated.
- **Row counts in `assessments`, `audit_log`, `segmentation_corrections` and `api_calls` are identical before and after the run.** Record the counts in the PR description.

### E3: scale (target Sat 11 Oct)

> **Prompt:** "Onboard medetec, dfutissue, woundcarevqa (only if directly downloadable; otherwise log exclusion in NOTES.md) and synthetic-negatives (generate 50 non-wound skin images procedurally — no external data). Build compare.ts. Run the full sample (≥1,000 items) headless with --seg=chain, then a second run with --seg=sam3, and compare them."

**Acceptance:**
- The full run completes.
- Findings carry CIs and gate statuses.
- The compare report is generated.
- The contamination notes appear.

### E4: opt-in frontier, determinism, robustness (after the pitch)

Scope:
- the `--with-vlm`, `--with-report` and `--with-baseline` paths, plus `--repeat`;
- robustness perturbations under `--perturb=blur,dark,jpeg,rotate,scale`, which writes perturbed copies to the cache and scores the consistency of each against its unperturbed source;
- an optional static `report.html`, offline, with no CDN.

**Acceptance:**
- Frontier calls never happen without `--yes`.
- The cost estimate is printed first.
- The VLM schema-violation rate is reported.

---

## 23. Datasets: direct download only

**Before onboarding, verify every row.** If access needs anything beyond a plain download, drop the dataset and record the exclusion in `eval/NOTES.md`.

| id | Dataset | Labels → canonical fields | Size (approx.) | Notes |
|---|---|---|---|---|
| `fuseg2021` | Foot Ulcer Segmentation Challenge 2021 (UWM BigData Lab / AZH Wound Center), GitHub | binary wound masks → `woundMaskPath`; type defaults to `diabetic_foot`; `bodyZone: foot_left` | ~1,200 images (train/val/test; test labels may be withheld) | `known_training_use: [fusegnet]` |
| `azh-woundclass` | AZH wound classification dataset (UWM BigData Lab), GitHub `uwm-bigdata/wound_classification` (`data/Dataset.rar`) | class folders → `woundType` (venous, diabetic → `diabetic_foot`, pressure, surgical); background/normal classes, if present → `woundPresent: false` | 730 images | Licence not stated in the repo: record "none stated". Same clinic as FUSeg (dedupe). `known_training_use: [fusegnet]` (AZH data); confirm during onboarding. |
| `medetec` | Medetec wound database | category folders/pages → `woundType` (map their categories; unmapped → `other` only via an explicit `labelMap` entry) | a few hundred | Check the site's terms and confirm the download needs no request. |
| `dfutissue` | DFUTissue (UWM, 2024): DFU tissue segmentation | palette tissue masks → `tissueMaskPaths` (fibrin → slough, granulation, callus → other); `tissueClassesLabelled: [granulation, slough, other]` | 110 labelled (+600 unlabelled; ingest the labelled only) | Confirm the GitHub/direct download. No epithelial or necrotic class. |
| `woundcarevqa` | WoundcareVQA (MEDIQA-WV 2025) | metadata → `woundType` (traumatic, surgical, pressure, …), `tissue_color` → `dominantTissue` (via labelMap, e.g. "red moist" → granulating, "necrotic black" → necrotic), `drainage_amount` → `exudate`, `infection_status` → `infection`, `anatomic_locations` → `bodyZone` (where it maps) | ~500 cases (train/val carry the metadata) | **Include only if directly downloadable.** Shared-task data may require registration, in which case exclude it. It is the only public source here for exudate and infection labels. |
| `synthetic-negatives` | procedurally generated non-wound skin images | `woundPresent: false` | 50 | Generated by the harness; `provenance: synthetic` |

**Excluded on purpose:** DFUC 2020/2021/2022, which need a signed licence agreement, and any other dataset that requires a request.

**What the public data can and cannot show.** This list has strong coverage of segmentation (FUSeg), wound type (AZH, Medetec) and tissue (DFUTissue). It is thin on exudate and infection, and that thinness disappears entirely without WoundcareVQA. It has almost no coin or ruler measurements. Findings must say so (§16, Limitations). Measurement and infection evidence will come mainly from the team's own data.

---

## 24. Known pitfalls

- **FUSegNet has no abstain.** It returned a mask at `mean_prob` 0.95 on an image with no wound. The negatives FP rate (§14.2) exists to quantify this. Never read its score as evidence that a wound is present.
- **Contamination.** FUSegNet was trained on AZH/FUSeg data (§14.9). Never quote FUSegNet's Dice on those datasets as generalisation.
- **The tissue sentinel.** When no pixel is considered, `breakdownFromBuffer` in `src/cv/tissueClassifier.ts` returns 20/20/20/20/20. Flag it with `tissueSentinel` and report the rate. Never score it as a real measurement.
- **Grids.** Every comparison happens on the `normaliseImage` grid (≤1,024 px on the long edge). FUSegNet internally runs at 512, and the app resamples its output, so compare the app's output, not FUSegNet's raw output.
- **EXIF orientation.** Apply it before hashing the normalised image and before resampling masks, otherwise masks end up rotated relative to their images.
- **Palette masks.** A JPEG-compressed mask has stray values. Snap each pixel to the nearest palette entry and report the snapping rate.
- **`image_only` ⇒ incomplete.** Without exudate and infection, the engine **correctly** withholds the pathway. Don't report this as failure. Report it as gate behaviour, and point to `image+vlm` / `label-axes` for decision metrics.
- **Process-wide env.** `SEGMENTATION_PROVIDERS` and `FUSEGNET_TRIGGER` are read from `process.env`, so use one segmenter arm per run (§11.2).
- **Node type-stripping.** `npm run test:*` uses `node --experimental-strip-types`, which can't import the `api/` modules (they use extensionless relative imports). That is why the harness runs under `tsx`, and why it doesn't hook into `npm test`.
- **Rate limits.** fal and Modal limits are external. Start with concurrency 4 and the token buckets, and raise them only after a clean smoke run.
- **Cost.** SAM 3 ($0.005 per request) and FUSegNet (Modal CPU time) are paid even though they aren't frontier models. The provider response cache (§13.7) means you pay once per unique request: once per image and model for SAM 3, across every arm. Keep the cache's `epoch` honest: bump it after a FUSegNet redeploy, or the harness will replay the old model's masks.

---

## 25. Labelling template for the team's own datasets (for later)

Use a CSV with one row per image, onboarded with `adapter: tabular`. Columns:

`image_file, wound_type, body_zone, dominant_tissue, granulation_pct, slough_pct, necrotic_pct, epithelial_pct, exudate (low|moderate|high), infection (yes|no), ischaemia (yes|no), marker_present (yes|no), length_cm, width_cm, area_cm2, monk_tone (1–10), expected_pathway_id, expected_referral_codes, labeller_role, notes`

Optional masks go in `masks/<image stem>.png` (binary, white = wound).

**Photo protocol:**
- A 20c coin in the plane of the wound and not touching it.
- A white reference patch, if available.
- Even, diffuse lighting.
- The camera perpendicular to the wound, at 20–40 cm.
- No identifying features in frame.

Patient images also need `image_source: consented_demo` and `externalProcessingConsent: true`, plus ethics and consent covering processing by fal.ai, Modal and the gateway outside Australia.

---

## 26. Open items (team, not code)

- Agree the gates in `eval/thresholds.yaml` (§14.10).
- `eval/costs.yaml` is pre-filled (§13.6). Re-check the rates before a big run. After the smoke run, replace FUSegNet's placeholder `est_seconds_per_call` with the measured p50, and fill in the gateway rates before any frontier run.
- Any number quoted in the pitch must cite the **run id** and carry the contamination note.
- The separate human-tested dataset can later be onboarded through the same manifest path, so it is scored by the same metrics.
