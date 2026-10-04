# Eval harness — notes for the team

Things found while building and running the harness that would need an **app change** or a **team decision**. The harness itself changes nothing in the app (spec §2.1). Each item says what was seen, where, and what is suggested. Run ids cite `~/MendWiseEval/out/<runId>/`.

## App findings

### 1. The coin detector finds a "coin" in about 30% of coin-free photos (safety-relevant)
- **Seen:** smoke run `run-20261004-2025-smoke`: 15 of 50 public photos (FUSeg, AZH) reported a scale, though no image contains an Australian 20c coin. Inspected two: a round wall fixture behind a foot (`fuseg2021:train/images/0016`, 9.8 px/cm, rim support 0.74) and a fold of fabric beside a gloved hand (`azh-woundclass:original images/S/94`, support 0.90). Both pass `COIN_MIN_EDGE_SUPPORT = 0.6` in `api/_coin.ts`.
- **Why it matters:** a false scale clears the engine's `no_scale` safety gate and produces confident-looking cm² areas. In the app a clinician sees the circled "coin" on the result screen and can reject it ("That is not the coin"), so the human check exists. The automatic path, and anyone who doesn't look, gets a wrong scale.
- **Measured at scale:** FUSeg, AZH, DFUTissue and synthetic-negatives now carry `markerPresent: false` (provenance `derived`), so every run reports `meas.coin_false_detection_rate`. See the full run's findings.
- **Suggest:** stricter acceptance in `chooseCoin`: a colour/uniformity test inside the disc, a size prior relative to the wound, or a higher support threshold calibrated on these negatives.

### 2. `/run` re-measures tissue without white balance, and its periwound band does not exclude the coin
- `/measure` calls `analyzeTissue({ measure: true })`: coin, white-patch gains, tissue % on the corrected colours, and a 4 cm band that excludes the coin. `runAssessment` then calls `analyzeTissue` again **without** `measure`, passing only the coin's px/cm. So the engine's tissue % is **not** white-balanced, and its periwound band **includes** the coin.
- The harness mirrors this exactly (that is what `parity` guards); when no coin and no white patch are found, the two calls are identical and the second is skipped.
- **Suggest:** pass the measure step's corrected tissue/periwound into `/run`, or have `/run` call measure mode. Today the review screen can show WB-corrected percentages that the decision did not use.

### 3. The app's server image steps are JPEG-only
`normaliseImage` decodes with `jpeg-js` when downscaling, and `analyzeTissue` / `hsvMaskFromImage` always do. A PNG over 1024 px would throw. The app's client always uploads JPEG, so this is latent, not live. The harness orients (EXIF) and re-encodes non-JPEG inputs as JPEG q95 before `normaliseImage`, giving the same kind of input the app receives.

### 4. Calibration items for the eval set (from HANDOFF "Findings to act on")
The SAM 3 score bands (0.80 / 0.50), the second-opinion agreement rule, and the coin threshold are all reported as **advisory** output in `findings.md` (§3 calibration rows). The app is not changed.

## Decisions taken in the harness (deviations from the spec text)

- **Two tissue calls per item** (see app finding 2). The spec's §11.1 step 4 describes one; mirroring the app's two is what makes parity pass when a coin is present.
- **Base engine inputs** use the client's own `toEngineInputs(defaultSession())` + `measuredView`, not a re-implementation. Only the controller's three step-4 overrides are copied (`eval/src/engineInputs.ts`).
- **`eval_items` upserts on `id`**, not `(dataset_id, image_sha256)`. Exact within-dataset duplicates are not written at all, so the unique constraint still holds; upserting on `id` keeps re-ingest idempotent when a file's bytes change.
- **"No app writes" test** spies at the network layer (every Supabase REST path) rather than on `from()`. It's stricter: it would also catch a write from any client the app creates.
- **Synthetic datasets skip near-duplicate (dHash) matching.** Smooth procedural skin collides with low-texture real patches at Hamming ≤ 4 (all 50 negatives were wrongly marked duplicates of AZH `ROI/N`). Exact sha256 matching still applies.
- **`secondOpinion` in the prediction** carries FUSegNet's own `latencyMs`, `multipleRegions` and an unavailability `reason`, beyond the spec's two fields.
- **AZH**: the repo ships `dataset/original images.zip` (538 photos: D 154, P 100, S 128, V 156) and `ROI.zip` (738 crops incl. 100 BG + 100 N), **not** `data/Dataset.rar` with 730 images as §23 says. Ingested: the 538 full photos + the 200 BG/N patches as real non-wound negatives. ROI wound crops are excluded (near-duplicates of the photos, and not an input the app sees). `D` → `bodyZone: foot_left` is an assumption; it drives FUSegNet's foot trigger.
- **DFUTissue** wound bed = granulation ∪ fibrin. Callus (periwound hyperkeratosis) is kept as an `other` tissue mask but excluded from the wound mask and the tissue %.
- **Medetec** category → woundType is approximate (`provenance: derived`); see its manifest. Fetched by `eval/datasets/medetec/fetch.mts`. The host answers HTTP 465 to a long descriptive User-Agent, so the fetcher uses the short, honest `MendWise-eval/1.0`. robots.txt (served brotli-encoded) allows all.
- **Gates whose metric the run can't produce** report `NOT_RUN`, and those with n < `min_n` report `INSUFFICIENT_N`, as specified. Urgent-referral sensitivity is NOT_RUN on public data: no public dataset here carries referral codes, and none of the urgent Mölnlycke triggers (probe-to-bone, ABPI, spreading erythema) can be derived from its labels.

## Phase status

- **E0–E3: built and run** (see the run ids in the summary of the full run in this file's last section).
- **E4, partly:** `--with-vlm`, `--with-report` and `--with-baseline` are wired through the app's own `extractVlmFeatures` / `composeReport` / `callGateway` (with the baseline prompt read verbatim from `api/v1/assessments/baseline.ts`). They're guarded (estimate first, `--yes` required, null gateway rates refuse) and scored (schema-violation rate, infection-sign sensitivity/specificity, uncertainty, report cage violations, baseline dressing-mention rate). Not built: `--repeat` (determinism re-runs), `--perturb` (robustness) and the static `report.html`. Both flags refuse with a clear message rather than being ignored. No frontier run has been made.

## Excluded datasets (§2.7: direct download only)

- **WoundcareVQA (MEDIQA-WV 2025)**: data is released to registered participants via the task's registration form (https://sites.google.com/view/mediqa-2025/mediqa-wv, checked 2026-10-04). Excluded: not directly downloadable. Consequence: no public exudate or infection labels, so decision metrics (axis accuracy, pathway match) run only on fixtures until team data exists.
- **DFUC 2020/2021/2022**: signed licence agreement. Excluded by the spec.
- **Medetec foot-ulcer segmentation subset** (`uwm-bigdata/wound-segmentation/data/Medetec_foot_ulcer_224`, 160 images with masks): directly downloadable, but these are 224-px crops (with `_1/_2/_3` augmentations) that don't align with the Medetec originals. Not ingested; a candidate small extra segmentation set if wanted.

## Team actions

- **`eval/costs.yaml`**: FUSegNet's measured p50 `latency_ms` is ~1.2 s against the 5 s placeholder `est_seconds_per_call` (runner reminder, §13.6). Left as committed so estimates stay conservative; update it if you want tighter numbers. Gateway rates are still `null`, so fill them before any `--with-vlm/--with-report/--with-baseline` run.
- **`eval/thresholds.yaml`**: gates are the spec's starting points and still need team agreement (§26).
- **Environment:** `git` on this Mac is the Xcode shim and refuses to run until `sudo xcodebuild -license` is accepted. The runner falls back to `/Library/Developer/CommandLineTools/usr/bin/git` for `git_sha` / `git_dirty`.
- **XLSX tables** are not supported (no dependency added); export to CSV.
- The spec says it was written against HEAD `8d1dbfd`, which is not in this repo's history; it was built against `277c955`. `test:rules` is 125/125 (AGENTS.md still says 66).

## Runs made while building (4 Oct 2026)

All under `~/MendWiseEval/out/`. Cost is from `costs.yaml` rates: an estimate, not an invoice.

| run | what | result | est. cost |
|---|---|---|---|
| `run-20261004-2019-hsv-try` | 30 FUSeg validation images, `hsv` arm | first end-to-end check; HSV Dice 0.03 (it outlines skin) | $0 |
| `run-20261004-2025-smoke` | 50 items, `chain`, killed with SIGINT at 25 then `--resume`d | resume skipped the 25 done keys | $0.31 |
| `run-20261004-2028-smoke-sam3` | same 50, `sam3` | **0 billed fal calls** (50 cache hits) | $0 |
| `run-20261004-2052-full1` | 1,160 items × `auto` + `gt-mask`, `chain` | 2,320 results, 0 failed | $5.86 |
| `run-20261004-2130-full1-sam3` | same 1,160, `sam3` | 1,105 of 1,160 SAM 3 answers from cache | $0.30 |
| `compare/compare-run-20261004-2052-full1-vs-run-20261004-2130-full1-sam3` | chain vs SAM 3 alone | no gate regressions | — |

Headline numbers from `full1` (`chain|auto|image_only`; quote only with the run id and the contamination note):

- **Segmentation, generalisation scope** (`in_distribution=false`, SAM 3 zero-shot on FUSeg + DFUTissue): Dice **0.749 [0.718, 0.775]**, n = 388 → gate `dice_auto_generalisation` **FAIL** (target ≥ 0.80). FUSeg 0.767, DFUTissue 0.598. **Read this as conditional:** the scope drops the 48 items where FUSegNet drew the boundary, and FUSegNet only draws when SAM 3 declined, so the hardest images are selectively removed. The fair end-to-end figure with no FUSegNet involvement is the `sam3` run on all 436 GT images: **0.679 [0.649, 0.708]**. Median Dice is 0.87 and 59% of outlines reach IoU ≥ 0.7: most drafts are good and a minority fail badly. Suggest the team decides whether the gate should be scored on the conditional or the end-to-end scope; the scope definition follows §14.9 literally.
- **Negatives false-positive rate**: **31% [24%, 39%]**, n = 154 → gate **FAIL** (≤ 10%). By the provider that drew the mask: FUSegNet 28/28 negatives got a plausible mask (it has no abstain), HSV 15%, SAM 3 2 of 2 it answered. Real AZH non-wound patches 46%; synthetic negatives 0% (SAM 3 declines them and FUSegNet/HSV masks are implausible, so synthetic skin is an easy negative).
- **Chain vs SAM 3 alone** (paired, n = 436 GT masks): the FUSegNet fallback **raises Dice by 0.048 [0.032, 0.064]** but **raises negatives FP from 17% to 31%** (McNemar p < 0.0001). That is the evidence for the HANDOFF's "which provider leads" question: the fallback rescues hard wounds and also outlines non-wounds.
- **Coin false detection** on coin-free photos: **23% [20%, 26%]**, n = 960 (FUSeg 35%, AZH 17%, DFUTissue 15%). See app finding 1.
- **Tissue** (DFUTissue, labelled classes, renormalised): MAE **20.8 pp [17.3, 24.2]** on the model boundary vs **17.2 pp [14.3, 20.2]** on the GT boundary, so segmentation contributes ~3.5 pp. The periwound-relative classifier is worse (25.6 / 23.9 pp): advisory evidence to keep `TISSUE_RELATIVE` off. Dominant-tissue accuracy 66% [56%, 74%], κ 0.28, which is **no better than always answering "slough"** (70 of 104 GT items are slough-dominant, so that guess scores 67%). The confusions run both ways (21 slough → granulating, 13 granulating → slough).
- **Confidence calibration**: mean IoU high 0.81 (n = 41), medium 0.60 (n = 94), low 0.63 (n = 301). Medium and low do not separate. Most boundaries read "low" because of FUSegNet's `multiple_regions` (HANDOFF finding). Advisory SAM 3 threshold for IoU ≥ 0.7: 0.79. Second-opinion agreement IoU vs true IoU: Spearman 0.30, AUROC 0.61 for IoU < 0.5. Weak.
- **Engine** under `image_only`: completion 0% (correct: no exudate/infection), `no_scale` gate on 76% (the other 24% is mostly the coin false detection above).
- **Fairness (ITA° proxy)**: no Dice gap whose CI excludes 0 (largest 0.08 [−0.03, 0.20]). The negatives-FP gap across bands (0.60) is **confounded by dataset mix** (AZH patches vs synthetic skin fall in different bands) and is not a skin-tone finding.

Estimator calibration from `full1`: SAM 3 declined or failed on ~17% of wound images, so FUSegNet fallbacks ran well above the 5% placeholder allowance (833 Modal calls vs 654 estimated). Dollar impact is small at Modal rates; raise the allowance to ~15% in `runner.ts planCalls` if you want tighter estimates.
