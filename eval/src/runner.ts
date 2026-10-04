/**
 * The runner (spec §13): sample → estimate → guard → run every item × arm
 * through the pipeline with a worker pool → persist incrementally → score.
 *
 *   npx tsx eval/cli.mts run --datasets=fuseg2021,azh-woundclass --sample=50 --label=smoke
 *   npx tsx eval/cli.mts estimate --datasets=… [run options]   (prints the cost table, no calls)
 *
 * Crash safety: every result is appended + fsync'd to results.jsonl before it
 * is counted, and upserted to `eval_results` in batches of 25 — a crash loses
 * at most the in-flight items. `--resume=<runId>` skips every finished key;
 * `--retry-failed` re-runs the failed ones.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fusegnetRequest, SAM3_FAL_MODEL_DEFAULT, sam3Request, shouldRunSecondOpinion } from '../../api/_segmentationParse';
import { CWCS_RULES_VERSION } from '../../src/decision/engine';
import { budgetDecision, estimateCost, formatEstimate, loadCosts, SpendTracker, type CallPlan, type Costs } from './costs';
import { POLICIES, type Policy } from './engineInputs';
import { assertDataLocation, concurrency as concurrencyOf, dataDir, outDir, REPO_ROOT } from './env';
import { loadItems } from './ingest';
import { listManifests, loadManifest, type Manifest } from './manifest';
import { armName, loadItemImage, runPipeline, SEG_ARMS, type Boundary, type SegArm } from './pipeline';
import {
  assertInstalled,
  cacheEnabled,
  counters,
  flushTotals,
  hasKey,
  indexedKey,
  itemContext,
  keyForRequest,
  onBilledCall,
  resetCounters,
  setCacheEnabled,
  setRateLimits,
} from './providerCache';
import { parsePerDataset, sampleItems } from './sample';
import type { EvalItem, ResultRow } from './schema';
import { EvalSink } from './sink';

export type RunConfig = {
  runId: string;
  label: string | null;
  datasets: string[];
  seg: SegArm;
  boundaries: Boundary[];
  policy: Policy;
  arms: string[];
  seed: number;
  sample: { total: number | null; perDataset: Record<string, number> | null; splits: string[] | null; allocation: Record<string, { available: number; chosen: number }> };
  items: string[];
  concurrency: number;
  falRpm: number;
  modalRpm: number;
  fusegnetTrigger: string;
  withVlm: boolean;
  withReport: boolean;
  withBaseline: boolean;
  repeat: number;
  cache: { enabled: boolean; epoch: string };
  budgetUsd: number;
  env: { segmentationProviders: string | null; tissueRelative: string | null; sam3Model: string; fusegnetModelLabel: string | null };
};

export type RunRecord = {
  id: string;
  label: string | null;
  status: 'running' | 'interrupted' | 'complete' | 'failed';
  gitSha: string | null;
  gitDirty: boolean | null;
  rulesVersion: string;
  modelVersions: Record<string, string | null>;
  config: RunConfig;
  counts: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const GIT_CANDIDATES = ['git', '/Library/Developer/CommandLineTools/usr/bin/git'];

/** HEAD sha and dirtiness. `git` first; the CLT binary when Xcode's shim is blocked by an unaccepted licence. */
export function gitInfo(): { sha: string | null; dirty: boolean | null } {
  for (const bin of GIT_CANDIDATES) {
    try {
      const sha = execFileSync(bin, ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const status = execFileSync(bin, ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return { sha, dirty: status.trim().length > 0 };
    } catch {
      /* try the next binary */
    }
  }
  try {
    const head = readFileSync(join(REPO_ROOT, '.git/HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? readFileSync(join(REPO_ROOT, '.git', ref), 'utf8').trim() : head;
    return { sha, dirty: null };
  } catch {
    return { sha: null, dirty: null };
  }
}

export function runDir(runId: string): string {
  return join(outDir(), runId);
}

export function newRunId(label: string | null, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `run-${stamp}${label ? `-${label.replace(/[^A-Za-z0-9_-]/g, '_')}` : ''}`;
}

export function loadRun(runId: string): RunRecord {
  const path = join(runDir(runId), 'run.json');
  if (!existsSync(path)) throw new Error(`No run ${runId} (${path} not found).`);
  return JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
}

function saveRun(run: RunRecord): void {
  mkdirSync(runDir(run.id), { recursive: true });
  writeFileSync(join(runDir(run.id), 'run.json'), JSON.stringify(run, null, 2));
}

export function readResults(runId: string): ResultRow[] {
  const path = join(runDir(runId), 'results.jsonl');
  if (!existsSync(path)) return [];
  const rows: ResultRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as ResultRow);
    } catch {
      /* a torn last line from a crash */
    }
  }
  return rows;
}

/** The latest row per (item, arm). */
export function latestResults(runId: string): Map<string, ResultRow> {
  const m = new Map<string, ResultRow>();
  for (const r of readResults(runId)) m.set(`${r.itemId}\u0000${r.arm}`, r);
  return m;
}

/** Append one result and fsync before it counts as done. */
function appendDurable(path: string, row: ResultRow): void {
  appendFileSync(path, `${JSON.stringify(row)}\n`);
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const p50 = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/** Per-arm, process-wide provider env (spec §11.2). One segmenter arm per process. */
export function applySegEnv(seg: SegArm, trigger: string): void {
  if (seg === 'chain') delete process.env.SEGMENTATION_PROVIDERS;
  if (seg === 'sam3') process.env.SEGMENTATION_PROVIDERS = 'sam3';
  if (seg === 'fusegnet') process.env.SEGMENTATION_PROVIDERS = 'fusegnet';
  if (seg === 'hsv') {
    delete process.env.SEGMENTATION_PROVIDERS;
    process.env.FAL_KEY = '';
    process.env.FUSEGNET_MODAL_URL = '';
  }
  process.env.FUSEGNET_TRIGGER = trigger;
}

/** A model arm whose provider is not configured would silently become an HSV run — refuse instead. */
export function segArmProblem(seg: SegArm): string | null {
  if ((seg === 'chain' || seg === 'sam3') && !process.env.FAL_KEY) return `--seg=${seg} needs FAL_KEY.`;
  if (seg === 'fusegnet' && !process.env.FUSEGNET_MODAL_URL) return '--seg=fusegnet needs FUSEGNET_MODAL_URL.';
  return null;
}

// ---------------------------------------------------------------------------
// Estimate (spec §13.6)
// ---------------------------------------------------------------------------

export function planCalls(
  items: EvalItem[],
  cfg: Pick<RunConfig, 'seg' | 'boundaries' | 'fusegnetTrigger' | 'withVlm' | 'withReport' | 'withBaseline' | 'repeat'>,
  opts: { cacheOn: boolean; cacheFor?: (item: EvalItem) => boolean } = { cacheOn: true },
): CallPlan {
  const plan: CallPlan = { sam3Calls: 0, sam3Hits: 0, fusegnetCalls: 0, fusegnetHits: 0, vlmCalls: 0, llmCalls: 0 };
  const auto = cfg.boundaries.includes('auto');
  const modalOn = Boolean(process.env.FUSEGNET_MODAL_URL);
  let chainSamMisses = 0;
  for (const item of items) {
    const cached = opts.cacheOn && (opts.cacheFor?.(item) ?? true);
    if (auto && (cfg.seg === 'chain' || cfg.seg === 'sam3' || cfg.seg === 'fusegnet')) {
      const img = loadItemImage(item);
      if (cfg.seg === 'chain' || cfg.seg === 'sam3') {
        const req = sam3Request(process.env, { imageDataUrl: img.dataUrl, prompts: null, imageBytes: img.bytes });
        if (req) {
          if (cached && hasKey(keyForRequest('fal', req))) plan.sam3Hits += 1;
          else {
            plan.sam3Calls += 1;
            if (cfg.seg === 'chain') chainSamMisses += 1;
          }
        }
        if (modalOn && shouldRunSecondOpinion(cfg.fusegnetTrigger, item.gt.bodyZone ?? null)) {
          const key = indexedKey(item.imageSha256, 'fusegnet_second', 'modal');
          if (cached && key && hasKey(key)) plan.fusegnetHits += 1;
          else plan.fusegnetCalls += 1;
        }
      }
      if (cfg.seg === 'fusegnet' && modalOn) {
        const req = fusegnetRequest(process.env, img.dataUrl, null);
        if (req && cached && hasKey(keyForRequest('modal', req))) plan.fusegnetHits += 1;
        else if (req) plan.fusegnetCalls += 1;
      }
    }
    if (cfg.withVlm) plan.vlmCalls += cfg.boundaries.length;
    if (cfg.withReport) plan.llmCalls += cfg.boundaries.length;
    if (cfg.withBaseline) plan.vlmCalls += 1;
  }
  if (cfg.withVlm && cfg.repeat > 0) plan.vlmCalls += Math.min(cfg.repeat, items.length);
  // Fallback allowance: 5% of chain items whose SAM 3 call is not cached (placeholder until measured).
  if (cfg.seg === 'chain' && modalOn) plan.fusegnetCalls += Math.ceil(0.05 * chainSamMisses);
  return plan;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type Args = Record<string, unknown> & { _: string[] };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

function buildConfig(args: Args): RunConfig {
  const label = str(args.label) ?? null;
  const datasetsArg = str(args.datasets);
  if (!datasetsArg) throw new Error('--datasets=<ids>|all is required');
  const datasets = datasetsArg === 'all' ? listManifests() : datasetsArg.split(',').map((s) => s.trim());
  const seg = (str(args.seg) ?? 'chain') as SegArm;
  if (!SEG_ARMS.includes(seg)) throw new Error(`--seg must be one of ${SEG_ARMS.join(', ')}`);
  const boundaryArg = str(args.boundary) ?? 'auto';
  const boundaries: Boundary[] = boundaryArg === 'both' ? ['auto', 'gt-mask'] : [boundaryArg as Boundary];
  if (!boundaries.every((b) => b === 'auto' || b === 'gt-mask')) throw new Error('--boundary must be auto, gt-mask or both');
  const withVlm = Boolean(args['with-vlm']);
  const policy = (withVlm ? 'image+vlm' : (str(args.policy) ?? 'image_only')) as Policy;
  if (!POLICIES.includes(policy)) throw new Error(`--policy must be one of ${POLICIES.join(', ')}`);
  if (policy === 'image+vlm' && !withVlm) throw new Error('--policy=image+vlm needs --with-vlm');
  if (num(args.repeat)) throw new Error('--repeat (VLM determinism, spec E4) is not built yet — see eval/NOTES.md.');
  if (args.perturb !== undefined) throw new Error('--perturb (robustness, spec E4) is not built yet — see eval/NOTES.md.');
  const trigger = str(args['fusegnet-trigger']) ?? process.env.FUSEGNET_TRIGGER ?? 'foot';
  const runId = newRunId(label);
  return {
    runId,
    label,
    datasets,
    seg,
    boundaries,
    policy,
    arms: boundaries.map((b) => armName(seg, b, policy)),
    seed: num(args.seed) ?? 42,
    sample: {
      total: num(args.sample) ?? null,
      perDataset: parsePerDataset(str(args['per-dataset'])) ?? null,
      splits: str(args.split)?.split(',') ?? null,
      allocation: {},
    },
    items: [],
    concurrency: concurrencyOf(str(args.concurrency)),
    falRpm: num(args['fal-rpm']) ?? 30,
    modalRpm: num(args['modal-rpm']) ?? 30,
    fusegnetTrigger: trigger,
    withVlm,
    withReport: Boolean(args['with-report']),
    withBaseline: Boolean(args['with-baseline']),
    repeat: num(args.repeat) ?? 0,
    cache: { enabled: args.cache !== false, epoch: str(args['cache-epoch']) ?? 'v1' },
    budgetUsd: 0,
    env: {
      segmentationProviders: null,
      tissueRelative: process.env.TISSUE_RELATIVE ?? null,
      sam3Model: process.env.SAM3_FAL_MODEL ?? SAM3_FAL_MODEL_DEFAULT,
      fusegnetModelLabel: process.env.FUSEGNET_MODEL_LABEL ?? null,
    },
  };
}

export type RunOutcome = { run: RunRecord; status: RunRecord['status']; done: number; skippedExisting: number };

export type RunDeps = {
  sink?: EvalSink;
  costs?: Costs;
  log?: (s: string) => void;
  /** Tests: stop after this many new results (simulates a crash/kill). */
  stopAfter?: number;
  /** Tests: skip the progress ticker. */
  quiet?: boolean;
};

export async function executeRun(cfgIn: RunConfig, deps: RunDeps & { resume?: RunRecord; retryFailed?: boolean; yes?: boolean; budgetFlag?: number | null; estimateOnly?: boolean }): Promise<RunOutcome | null> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const costs = deps.costs ?? loadCosts();
  const resume = deps.resume ?? null;
  const cfg: RunConfig = resume ? { ...resume.config } : { ...cfgIn };
  for (const p of [dataDir(), outDir()]) assertDataLocation(p);

  // --- Manifests and items
  const manifests: Record<string, Manifest> = {};
  for (const id of cfg.datasets) manifests[id] = loadManifest(id);
  const itemsByDataset: Record<string, EvalItem[]> = {};
  for (const id of cfg.datasets) {
    itemsByDataset[id] = loadItems(id);
    if (!itemsByDataset[id].length) log(`warning: no ingested items for ${id} — run \`ingest --dataset=${id}\` first.`);
  }
  let items: EvalItem[];
  if (resume) {
    const byId = new Map(Object.values(itemsByDataset).flat().map((i) => [i.id, i]));
    items = cfg.items.map((id) => byId.get(id)).filter((i): i is EvalItem => Boolean(i));
    if (items.length !== cfg.items.length) log(`warning: ${cfg.items.length - items.length} item(s) of the original run are no longer ingested.`);
  } else {
    const picked = sampleItems(itemsByDataset, manifests, {
      datasets: cfg.datasets,
      sample: cfg.sample.total ?? undefined,
      perDataset: cfg.sample.perDataset ?? undefined,
      splits: cfg.sample.splits ?? undefined,
      seed: cfg.seed,
      useDefaultTarget: cfg.sample.total === null && cfg.sample.perDataset === null && cfg.datasets.length > 1,
    });
    items = picked.items;
    cfg.items = items.map((i) => i.id);
    cfg.sample = { ...cfg.sample, allocation: picked.allocation };
  }
  if (!items.length) throw new Error('No items to run. Check --datasets / --split and that the datasets are ingested.');

  // --- Provider env (process-wide; one segmenter arm per run)
  applySegEnv(cfg.seg, cfg.fusegnetTrigger);
  cfg.env.segmentationProviders = process.env.SEGMENTATION_PROVIDERS ?? null;
  const problem = segArmProblem(cfg.seg);
  if (problem) throw new Error(problem);
  setCacheEnabled(cfg.cache.enabled);
  const cacheFor = (item: EvalItem) => manifests[item.datasetId]?.image_source === 'public_dataset';

  // --- Resume: what is already done
  const id = resume?.id ?? cfg.runId;
  cfg.runId = id;
  const dir = runDir(id);
  mkdirSync(join(dir, 'masks'), { recursive: true });
  const resultsPath = join(dir, 'results.jsonl');
  const sink = deps.sink ?? EvalSink.fromEnv();
  const existing = latestResults(id);
  if (resume && sink.enabled) {
    for (const r of (await sink.resultKeys(id)) ?? []) {
      const k = `${r.item_id}\u0000${r.arm}`;
      if (!existing.has(k)) existing.set(k, { runId: id, itemId: r.item_id, arm: r.arm, status: r.status as ResultRow['status'], prediction: null, at: '' });
    }
  }
  const finished = (k: string) => {
    const r = existing.get(k);
    if (!r) return false;
    return r.status === 'ok' || r.status === 'skipped' || (r.status === 'failed' && !deps.retryFailed);
  };
  const tasks: { item: EvalItem; boundary: Boundary }[] = [];
  let skippedExisting = 0;
  for (const item of items) {
    for (const boundary of cfg.boundaries) {
      if (finished(`${item.id}\u0000${armName(cfg.seg, boundary, cfg.policy)}`)) skippedExisting += 1;
      else tasks.push({ item, boundary });
    }
  }

  // --- Estimate and guards
  const plan = planCalls(
    tasks.filter((t, i, a) => a.findIndex((x) => x.item.id === t.item.id) === i).map((t) => t.item),
    { ...cfg, boundaries: [...new Set(tasks.map((t) => t.boundary))] },
    { cacheOn: cfg.cache.enabled, cacheFor },
  );
  const estimate = estimateCost(costs, plan);
  log(`run ${id}: ${items.length} item(s) × ${cfg.arms.length} arm(s) [${cfg.arms.join(', ')}]; ${tasks.length} to do${skippedExisting ? `, ${skippedExisting} already done` : ''}.`);
  log(`allocation: ${Object.entries(cfg.sample.allocation).map(([d, a]) => `${d} ${a.chosen}/${a.available}`).join(', ') || '(resumed)'}`);
  log(`cost estimate (${costs.currency}, rates from eval/costs.yaml — estimates only):\n${formatEstimate(estimate, costs.currency)}`);
  if (deps.estimateOnly) return null;
  if (estimate.refused) throw new Error(estimate.refused);
  const frontier = cfg.withVlm || cfg.withReport || cfg.withBaseline;
  if (frontier && !deps.yes) {
    throw new Error(`This run makes ~${plan.vlmCalls + plan.llmCalls} frontier (gateway) call(s). Re-run with --yes to allow them.`);
  }
  const decision = budgetDecision(costs, estimate.totalUsd, deps.budgetFlag ?? null);
  if (decision.message) log(decision.message);
  if (!decision.ok) throw new Error('Refusing to start: over budget.');
  cfg.budgetUsd = decision.budget;
  if (cfg.seg !== 'hsv') assertInstalled();

  // --- The run record
  const git = gitInfo();
  const run: RunRecord = resume
    ? { ...resume, status: 'running', config: cfg }
    : {
        id,
        label: cfg.label,
        status: 'running',
        gitSha: git.sha,
        gitDirty: git.dirty,
        rulesVersion: CWCS_RULES_VERSION,
        modelVersions: {
          segmentation: cfg.seg === 'hsv' ? 'hsv-threshold' : cfg.seg === 'fusegnet' ? (cfg.env.fusegnetModelLabel ?? 'fusegnet@modal') : cfg.env.sam3Model,
          second_opinion: cfg.seg === 'hsv' ? null : (cfg.env.fusegnetModelLabel ?? null),
          vlm: null,
          llm: null,
        },
        config: cfg,
        counts: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
  saveRun(run);
  await sink.upsertRun(run);

  // --- Rate limits, spend tracking, signals
  setRateLimits({ fal: cfg.falRpm, modal: cfg.modalRpm });
  const spend = new SpendTracker(costs, cfg.budgetUsd);
  resetCounters();
  let stopReason: string | null = null;
  onBilledCall((kind) => {
    if (kind === 'fal' || kind === 'modal') spend.record(kind);
    if (spend.exceeded && !stopReason) stopReason = `budget reached ($${spend.usd.toFixed(2)} > $${cfg.budgetUsd})`;
  });
  const onSignal = (sig: string) => () => {
    if (!stopReason) {
      stopReason = `received ${sig}`;
      log(`\n${sig}: finishing in-flight items, then marking the run interrupted…`);
    } else process.exit(130);
  };
  const sigint = onSignal('SIGINT');
  const sigterm = onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);

  // Gateway calls: at most 2 at a time (spec §13.2).
  let gwActive = 0;
  const gwQueue: (() => void)[] = [];
  const gateway = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (gwActive >= 2) await new Promise<void>((r) => gwQueue.push(r));
    gwActive += 1;
    try {
      return await fn();
    } finally {
      gwActive -= 1;
      gwQueue.shift()?.();
    }
  };

  // --- Workers
  const started = Date.now();
  let done = 0;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  const stageTimes: Record<string, number[]> = {};
  let buffer: ResultRow[] = [];
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    await sink.upsertResults(batch);
  };
  const progress = () => {
    const elapsed = (Date.now() - started) / 1000;
    const rate = done / Math.max(1, elapsed);
    const eta = rate > 0 ? (tasks.length - done) / rate : null;
    const p50s = Object.fromEntries(Object.entries(stageTimes).map(([k, v]) => [k, p50(v)]));
    const c = counters();
    const snapshot = { runId: id, done, total: tasks.length, ok, failed, skipped, ratePerMin: rate * 60, etaSec: eta, p50Ms: p50s, cache: c, spendUsd: spend.usd, at: new Date().toISOString() };
    writeFileSync(join(dir, 'progress.json'), JSON.stringify(snapshot, null, 2));
    return snapshot;
  };
  const ticker = deps.quiet
    ? null
    : setInterval(() => {
        const s = progress();
        const stages = ['segment', 'measure', 'evaluate'].map((k) => `${k} ${s.p50Ms[k] ?? '—'}ms`).join(' ');
        log(
          `[${id}] ${s.done}/${s.total} ok ${s.ok} failed ${s.failed} · ${s.ratePerMin.toFixed(1)}/min · ETA ${s.etaSec === null ? '—' : `${Math.round(s.etaSec / 60)}m`} · p50 ${stages} · fal ${s.cache.misses.fal} billed/${s.cache.hits.fal} cached · modal ${s.cache.misses.modal}/${s.cache.hits.modal} · $${s.spendUsd.toFixed(2)}`,
        );
      }, 5000);

  let next = 0;
  let newResults = 0;
  const worker = async () => {
    while (!stopReason) {
      const task = tasks[next];
      next += 1;
      if (!task) return;
      const arm = armName(cfg.seg, task.boundary, cfg.policy);
      let row: ResultRow;
      try {
        const out = await itemContext.run(
          { itemId: task.item.id, imageSha: task.item.imageSha256, cacheEnabled: cfg.cache.enabled && cacheFor(task.item) },
          () =>
            runPipeline(task.item, {
              runId: id,
              runDir: dir,
              seg: cfg.seg,
              boundary: task.boundary,
              policy: cfg.policy,
              withVlm: cfg.withVlm,
              withReport: cfg.withReport,
              withBaseline: cfg.withBaseline,
              gateway,
            }),
        );
        row = out.row;
      } catch (error) {
        row = { runId: id, itemId: task.item.id, arm, status: 'failed', prediction: null, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
      }
      appendDurable(resultsPath, row);
      done += 1;
      newResults += 1;
      if (row.status === 'ok') ok += 1;
      else if (row.status === 'failed') failed += 1;
      else skipped += 1;
      for (const [k, v] of Object.entries(row.timings ?? {})) (stageTimes[k] ??= []).push(v);
      buffer.push(row);
      if (buffer.length >= 25) await flush();
      if (deps.stopAfter !== undefined && newResults >= deps.stopAfter && !stopReason) stopReason = 'stopAfter (test)';
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, tasks.length || 1) }, worker));
  } finally {
    if (ticker) clearInterval(ticker);
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    onBilledCall(null);
  }
  await flush();
  const snap = progress();

  // --- Finish
  const all = [...latestResults(id).values()].filter((r) => cfg.items.includes(r.itemId));
  const c = counters();
  const fusegnetLatencies = all
    .map((r) => r.prediction?.segmentation.secondOpinion?.latencyMs)
    .filter((v): v is number => typeof v === 'number');
  const observedModels = {
    second_opinion: all.find((r) => r.prediction?.segmentation.attempts.some((a) => a.provider === 'fusegnet'))?.prediction?.segmentation.model ?? null,
    vlm: all.find((r) => r.prediction?.vlm?.model)?.prediction?.vlm?.model ?? null,
    llm: all.find((r) => r.prediction?.report?.model)?.prediction?.report?.model ?? null,
  };
  run.modelVersions = {
    ...run.modelVersions,
    vlm: observedModels.vlm ?? run.modelVersions.vlm ?? null,
    llm: observedModels.llm ?? run.modelVersions.llm ?? null,
  };
  const prior = (run.counts ?? {}) as { fal_calls?: number; modal_calls?: number; cache_hits?: { fal?: number; modal?: number }; est_usd?: { sam3?: number; fusegnet?: number } };
  const byProvider = spend.byProvider();
  run.counts = {
    items: cfg.items.length,
    results: all.length,
    ok: all.filter((r) => r.status === 'ok').length,
    failed: all.filter((r) => r.status === 'failed').length,
    skipped: all.filter((r) => r.status === 'skipped').length,
    fal_calls: (prior.fal_calls ?? 0) + c.misses.fal,
    modal_calls: (prior.modal_calls ?? 0) + c.misses.modal,
    cache_hits: { fal: (prior.cache_hits?.fal ?? 0) + c.hits.fal, modal: (prior.cache_hits?.modal ?? 0) + c.hits.modal },
    retries: c.retries,
    est_usd: { sam3: (prior.est_usd?.sam3 ?? 0) + byProvider.sam3, fusegnet: (prior.est_usd?.fusegnet ?? 0) + byProvider.fusegnet, gateway: 0 },
    fusegnet_latency_p50_ms: p50(fusegnetLatencies),
    elapsed_s: Math.round((Date.now() - started) / 1000),
    throughput_per_min: snap.ratePerMin,
  };
  const complete = all.length >= cfg.items.length * cfg.arms.length && !stopReason;
  run.status = complete ? 'complete' : 'interrupted';
  run.finishedAt = complete ? new Date().toISOString() : null;
  saveRun(run);
  await sink.upsertRun(run);
  if (cacheEnabled()) flushTotals();

  log(`run ${id}: ${run.status}${stopReason ? ` (${stopReason})` : ''} — ${done} new result(s), ${ok} ok, ${failed} failed, ${skipped} skipped. Billed calls: fal ${c.misses.fal}, modal ${c.misses.modal}; cache hits: fal ${c.hits.fal}, modal ${c.hits.modal}; est. $${spend.usd.toFixed(2)}.`);
  const p = p50(fusegnetLatencies);
  const est = costs.providers.fusegnet.est_seconds_per_call * 1000;
  if (p !== null && Math.abs(p - est) / est > 0.5) {
    log(`reminder: FUSegNet's measured p50 latency_ms is ${p} ms vs est_seconds_per_call ${est / 1000}s in eval/costs.yaml — update it (§13.6).`);
  }
  if (sink.failures) log(`note: ${sink.failures} database write(s) failed; results.jsonl is complete.`);
  return { run, status: run.status, done, skippedExisting };
}

export async function runCommand(args: Args, opts: { estimateOnly?: boolean } = {}): Promise<number> {
  const resumeId = str(args.resume);
  const resume = resumeId ? loadRun(resumeId) : undefined;
  const cfg = resume ? resume.config : buildConfig(args);
  const outcome = await executeRun(cfg, {
    resume,
    retryFailed: Boolean(args['retry-failed']),
    yes: Boolean(args.yes),
    budgetFlag: num(args.budget) ?? null,
    estimateOnly: opts.estimateOnly,
  });
  if (!outcome) return 0;
  if (outcome.status === 'complete' && args.score !== false) {
    const { scoreRun } = await import('./score/index');
    const { writeReport } = await import('./report');
    const scored = await scoreRun(outcome.run.id);
    const paths = writeReport(outcome.run.id, scored);
    console.log(`findings → ${paths.md}`);
  }
  return outcome.status === 'complete' ? 0 : 3;
}

export function statusCommand(args: Args): number {
  const runId = str(args.run);
  if (runId) {
    const run = loadRun(runId);
    const progressPath = join(runDir(runId), 'progress.json');
    console.log(JSON.stringify({ id: run.id, status: run.status, counts: run.counts, progress: existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, 'utf8')) : null }, null, 2));
    return 0;
  }
  if (!existsSync(outDir())) return 0;
  const runs = readdirSync(outDir())
    .filter((d) => d.startsWith('run-') && existsSync(join(outDir(), d, 'run.json')))
    .sort();
  for (const d of runs) {
    const r = loadRun(d);
    const c = (r.counts ?? {}) as { ok?: number; failed?: number; items?: number };
    console.log(`${r.id.padEnd(40)} ${r.status.padEnd(12)} ${r.config.arms.join(',').padEnd(32)} items ${c.items ?? r.config.items.length} ok ${c.ok ?? '—'} failed ${c.failed ?? '—'}`);
  }
  return 0;
}
