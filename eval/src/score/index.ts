/**
 * scoreRun(runId) → per-item metrics + aggregate rows + gate statuses (spec §14).
 *
 *   npx tsx eval/cli.mts score --run=<runId>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { EVAL_ROOT, outDir } from '../env';
import { loadItems, type Coverage } from '../ingest';
import { loadManifest, type Manifest } from '../manifest';
import { appIoU, centreMask, loadGtMask, loadItemImage, skinToneProxy } from '../pipeline';
import { readMaskPng, toGrid } from '../io';
import { latestResults, loadRun, runDir, type RunRecord } from '../runner';
import type { EvalItem, MetricRow } from '../schema';
import { EvalSink } from '../sink';
import { scopesFor, single, type ScoreContext, type ScoredItem } from './common';
import { engineItemMetrics, scoreEngine } from './engine';
import { scoreFairness, ITA_NOTE } from './fairness';
import { maskMetrics } from './masks';
import { measItemMetrics, scoreMeasurement } from './measurement';
import { scoreOps } from './ops';
import { scoreSegmentation, segItemMetrics } from './segmentation';
import { scoreTissue, tissueItemMetrics } from './tissue';
import { scoreVlm, vlmItemMetrics } from './vlm';

export type GateStatus = 'PASS' | 'FAIL' | 'INSUFFICIENT_N' | 'NOT_RUN';
export type Gate = { metric: string; scope?: string; op: '>=' | '<=' | '==' | '>' | '<'; value: number; min_n: number };
export type GateResult = { id: string; arm: string; status: GateStatus; value: number | null; ci: [number | null, number | null]; n: number; target: string };

export type ScoreResult = {
  run: RunRecord;
  items: ScoredItem[];
  metrics: MetricRow[];
  gates: GateResult[];
  fairness: Record<string, { maxGap: Record<string, number | null>; suppressed: Record<string, string[]> }>;
  iouCrossCheck: { item: string; harness: number; app: number | null } | null;
  coverage: Record<string, Coverage | null>;
  manifests: Record<string, Manifest>;
};

export function loadGates(path = join(EVAL_ROOT, 'thresholds.yaml')): Record<string, Gate> {
  return (parseYaml(readFileSync(path, 'utf8')) as { gates: Record<string, Gate> }).gates;
}

export function evaluateGates(gates: Record<string, Gate>, metrics: MetricRow[], arms: string[]): GateResult[] {
  const out: GateResult[] = [];
  for (const arm of arms) {
    for (const [id, g] of Object.entries(gates)) {
      const [area, ...rest] = g.metric.split('.');
      const metric = rest.join('.');
      const scope = g.scope ?? 'overall';
      const row = metrics.find((m) => m.arm === arm && m.area === area && m.metric === metric && m.scope === scope);
      const target = `${g.op} ${g.value} (n ≥ ${g.min_n})`;
      if (!row || row.value === null) {
        out.push({ id, arm, status: 'NOT_RUN', value: null, ci: [null, null], n: row?.n ?? 0, target });
        continue;
      }
      if (row.n < g.min_n) {
        out.push({ id, arm, status: 'INSUFFICIENT_N', value: row.value, ci: [row.ciLow, row.ciHigh], n: row.n, target });
        continue;
      }
      const v = row.value;
      const pass = g.op === '>=' ? v >= g.value : g.op === '<=' ? v <= g.value : g.op === '>' ? v > g.value : g.op === '<' ? v < g.value : v === g.value;
      out.push({ id, arm, status: pass ? 'PASS' : 'FAIL', value: v, ci: [row.ciLow, row.ciHigh], n: row.n, target });
    }
  }
  return out;
}

function readCoverage(datasetId: string): Coverage | null {
  const p = join(outDir(), 'ingest', datasetId, 'coverage.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Coverage) : null;
}

export async function scoreRun(runId: string, opts: { sink?: EvalSink | null; bootstrapResamples?: number; persist?: boolean } = {}): Promise<ScoreResult> {
  const run = loadRun(runId);
  const cfg = run.config;
  const manifests: Record<string, Manifest> = {};
  for (const d of cfg.datasets) manifests[d] = loadManifest(d);
  const itemById = new Map<string, EvalItem>();
  for (const d of cfg.datasets) for (const it of loadItems(d)) itemById.set(it.id, it);
  const wanted = new Set(cfg.items);
  const rows = [...latestResults(runId).values()].filter((r) => wanted.has(r.itemId));
  const ctx: ScoreContext = { runId, manifests, bootstrapResamples: opts.bootstrapResamples ?? 2000 };

  // --- Per-item metrics
  const scored: ScoredItem[] = [];
  let iouCrossCheck: ScoreResult['iouCrossCheck'] = null;
  for (const row of rows) {
    const item = itemById.get(row.itemId);
    if (!item) continue;
    const [, boundary, policy] = row.arm.split('|');
    const pred = row.prediction;
    // Runs made before the pipeline's centre-region fallback have no skin-tone proxy for mask-less items.
    if (pred && !pred.skinToneProxy && !item.gt.skinTone && row.status === 'ok') {
      try {
        pred.skinToneProxy = skinToneProxy(loadItemImage(item), centreMask(item.width, item.height));
      } catch {
        /* leave it unknown */
      }
    }
    const inDist = Boolean(manifests[item.datasetId]?.known_training_use.includes('fusegnet') && pred?.segmentation.source === 'fusegnet');
    const s: ScoredItem = {
      row,
      item,
      pred,
      arm: row.arm,
      boundary: boundary === 'gt-mask' ? 'gt-mask' : 'auto',
      policy,
      inDist,
      scopes: scopesFor(item, pred, inDist),
      m: {},
    };
    if (pred && row.status === 'ok') {
      const gt = item.gt.woundMaskPath ? loadGtMask(item) : null;
      const pm = pred.maskPath && existsSync(pred.maskPath) ? toGrid(readMaskPng(pred.maskPath), item.width, item.height) : null;
      segItemMetrics(s, gt, pm);
      // §14.2 cross-check: once per run, the harness IoU must equal the app's compareMasks IoU.
      if (!iouCrossCheck && gt && pm) {
        iouCrossCheck = { item: item.id, harness: maskMetrics(pm, gt, item.width, item.height).iou, app: appIoU(pm, gt, item.width, item.height) };
      }
      measItemMetrics(s);
      tissueItemMetrics(s);
      engineItemMetrics(s);
      vlmItemMetrics(s);
    }
    row.itemMetrics = Object.fromEntries(Object.entries(s.m).filter(([, v]) => v !== undefined));
    scored.push(s);
  }
  if (iouCrossCheck && iouCrossCheck.app !== null && Math.abs(iouCrossCheck.harness - iouCrossCheck.app) > 1e-9) {
    throw new Error(`IoU cross-check failed on ${iouCrossCheck.item}: harness ${iouCrossCheck.harness} ≠ compareMasks ${iouCrossCheck.app}`);
  }

  // --- Aggregates per arm
  const metrics: MetricRow[] = [];
  const fairness: ScoreResult['fairness'] = {};
  for (const arm of cfg.arms) {
    const items = scored.filter((s) => s.arm === arm);
    const ok = items.filter((s) => s.row.status === 'ok');
    metrics.push(single(ctx, arm, 'coverage', 'items_run', items.length, items.length));
    for (const st of ['ok', 'failed', 'skipped'] as const) metrics.push(single(ctx, arm, 'coverage', `items_${st}`, items.filter((s) => s.row.status === st).length, items.length));
    metrics.push(...scoreSegmentation(ctx, arm, ok));
    metrics.push(...scoreMeasurement(ctx, arm, ok));
    metrics.push(...scoreTissue(ctx, arm, ok));
    metrics.push(...scoreEngine(ctx, arm, ok));
    metrics.push(...scoreVlm(ctx, arm, ok));
    metrics.push(...scoreOps(ctx, arm, items, run.counts));
    const f = scoreFairness(ctx, arm, ok);
    metrics.push(...f.rows);
    fairness[arm] = { maxGap: f.maxGap, suppressed: f.suppressed };
    if (iouCrossCheck && iouCrossCheck.app !== null) metrics.push(single(ctx, arm, 'seg', 'iou_crosscheck_abs_diff', Math.abs(iouCrossCheck.harness - iouCrossCheck.app), 1));
  }
  const coverage: Record<string, Coverage | null> = {};
  for (const d of cfg.datasets) {
    const c = readCoverage(d);
    coverage[d] = c;
    if (!c) continue;
    for (const arm of cfg.arms) {
      for (const [field, v] of Object.entries(c.fieldCoverage)) metrics.push(single(ctx, arm, 'coverage', `label_coverage.${field}`, v, c.ok, { scope: `dataset=${d}` }));
      metrics.push(single(ctx, arm, 'coverage', 'ingest_failed', c.failures.length, c.items, { scope: `dataset=${d}` }));
      metrics.push(single(ctx, arm, 'coverage', 'unmapped_values', c.unmappedTotal, c.items, { scope: `dataset=${d}` }));
      const dupes = c.duplicates.withinExact + c.duplicates.withinNear + c.duplicates.crossExact + c.duplicates.crossNear;
      metrics.push(single(ctx, arm, 'coverage', 'duplicates_removed', dupes, c.items, { scope: `dataset=${d}` }));
    }
  }

  const gates = evaluateGates(loadGates(), metrics, cfg.arms);

  if (opts.persist !== false) {
    const dir = runDir(runId);
    writeFileSync(
      join(dir, 'item_metrics.jsonl'),
      scored.map((s) => JSON.stringify({ item: s.item.id, arm: s.arm, status: s.row.status, inDist: s.inDist, scopes: s.scopes, m: s.row.itemMetrics })).join('\n') + '\n',
    );
    const sink = opts.sink === undefined ? EvalSink.fromEnv() : opts.sink;
    if (sink?.enabled) {
      await sink.upsertResults(scored.map((s) => s.row));
      await sink.upsertMetrics(metrics);
    }
  }
  return { run, items: scored, metrics, gates, fairness, iouCrossCheck, coverage, manifests };
}

export { ITA_NOTE };

export async function scoreCommand(args: Record<string, unknown>): Promise<number> {
  const runId = typeof args.run === 'string' ? args.run : null;
  if (!runId) {
    console.error('usage: npx tsx eval/cli.mts score --run=<runId>');
    return 2;
  }
  const result = await scoreRun(runId);
  const { writeReport } = await import('../report');
  const paths = writeReport(runId, result);
  console.log(`scored ${result.items.length} result(s) → ${result.metrics.length} metric rows; gates: ${result.gates.map((g) => `${g.id}=${g.status}`).join(', ')}`);
  console.log(`findings → ${paths.md}`);
  return 0;
}
