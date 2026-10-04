/**
 * The harness's ONLY database writer (spec §18): Supabase `eval_*` tables plus
 * a local JSONL mirror.
 *
 * Its own client, deliberately — it does not import `api/_supabase.ts` or the
 * app's `_store.ts`. That makes it structurally obvious that the harness writes
 * nothing but `eval_*`, and the allow-list below enforces it at runtime: any
 * other table name throws before a request is built.
 *
 * Without SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY the sink is JSONL-only and
 * says so once. A failed write degrades the same way: the JSONL mirror is the
 * record of truth for a run, and the database is a convenience copy of it.
 */
import { createClient } from '@supabase/supabase-js';

import type { EvalItem, MetricRow, ResultRow } from './schema';

export const EVAL_TABLES = ['eval_datasets', 'eval_items', 'eval_runs', 'eval_results', 'eval_metrics'] as const;
export type EvalTable = (typeof EVAL_TABLES)[number];

/** The slice of a Supabase client the sink uses — small enough to mock. */
export type SinkClient = {
  from(table: string): {
    upsert(rows: unknown, opts?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
    select(columns?: string): {
      eq(column: string, value: unknown): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> & {
        eq(column: string, value: unknown): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
    update(values: unknown): { eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }> };
  };
};

export class TableNotAllowedError extends Error {}

export function assertEvalTable(table: string): asserts table is EvalTable {
  if (!table.startsWith('eval_') || !(EVAL_TABLES as readonly string[]).includes(table)) {
    throw new TableNotAllowedError(`The eval sink refuses to touch "${table}": only eval_* tables may be written.`);
  }
}

/** JSON-safe: NaN / ±Infinity → null, so a metric never poisons a row. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v))) as T;
}

export class EvalSink {
  readonly client: SinkClient | null;
  private warned = new Set<string>();
  /** Writes that failed (the JSONL mirror still has them). */
  failures = 0;

  constructor(client: SinkClient | null) {
    this.client = client;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): EvalSink {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('eval sink: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — writing the JSONL mirror only.');
      return new EvalSink(null);
    }
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    return new EvalSink(client as unknown as SinkClient);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  private table(name: string) {
    assertEvalTable(name);
    if (!this.client) return null;
    return this.client.from(name);
  }

  private warn(table: string, message: string): void {
    this.failures += 1;
    if (this.warned.has(table)) return;
    this.warned.add(table);
    console.warn(`eval sink: write to ${table} failed (${message}) — continuing with the JSONL mirror (a missing table means migration 0004 is not applied; re-running the score command re-syncs results).`);
  }

  async upsert(table: EvalTable, rows: Record<string, unknown>[], onConflict: string, batchSize = 25): Promise<boolean> {
    const t = this.table(table);
    if (!t || rows.length === 0) return false;
    let ok = true;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = jsonSafe(rows.slice(i, i + batchSize));
      let failure: string | null = null;
      // One retry after a short pause: a transient network error should not cost a batch.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const { error } = await t.upsert(batch, { onConflict });
          failure = error ? error.message : null;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        if (!failure) break;
        if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
      }
      if (failure) {
        ok = false;
        this.warn(table, failure);
      }
    }
    return ok;
  }

  async selectWhere(table: EvalTable, columns: string, column: string, value: unknown): Promise<unknown[] | null> {
    const t = this.table(table);
    if (!t) return null;
    try {
      const { data, error } = await t.select(columns).eq(column, value);
      if (error) {
        this.warn(table, error.message);
        return null;
      }
      return data ?? [];
    } catch (error) {
      this.warn(table, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  // --- typed writers ---------------------------------------------------------

  upsertDataset(row: {
    id: string;
    name: string;
    version?: string | null;
    sourceUrl?: string | null;
    licence?: string | null;
    imageSource: string;
    knownTrainingUse: string[];
    manifest: unknown;
    profile?: unknown;
  }) {
    return this.upsert(
      'eval_datasets',
      [
        {
          id: row.id,
          name: row.name,
          version: row.version ?? null,
          source_url: row.sourceUrl ?? null,
          licence: row.licence ?? null,
          image_source: row.imageSource,
          known_training_use: row.knownTrainingUse,
          manifest: row.manifest,
          profile: row.profile ?? null,
          updated_at: new Date().toISOString(),
        },
      ],
      'id',
    );
  }

  upsertItems(items: EvalItem[], relRoot = '') {
    return this.upsert(
      'eval_items',
      items.map((it) => itemRow(it, relRoot)),
      'id',
      200,
    );
  }

  upsertRun(run: {
    id: string;
    label: string | null;
    status: 'running' | 'interrupted' | 'complete' | 'failed';
    gitSha: string | null;
    gitDirty: boolean | null;
    rulesVersion: string;
    modelVersions: unknown;
    config: unknown;
    counts?: unknown;
    startedAt: string;
    finishedAt?: string | null;
  }) {
    return this.upsert(
      'eval_runs',
      [
        {
          id: run.id,
          label: run.label,
          status: run.status,
          git_sha: run.gitSha,
          git_dirty: run.gitDirty,
          rules_version: run.rulesVersion,
          model_versions: run.modelVersions,
          config: run.config,
          counts: run.counts ?? null,
          started_at: run.startedAt,
          finished_at: run.finishedAt ?? null,
        },
      ],
      'id',
    );
  }

  upsertResults(rows: ResultRow[]) {
    return this.upsert(
      'eval_results',
      rows.map((r) => ({
        run_id: r.runId,
        item_id: r.itemId,
        arm: r.arm,
        status: r.status,
        prediction: r.prediction,
        item_metrics: r.itemMetrics ?? null,
        timings: r.timings ?? null,
        error: r.error ?? null,
      })),
      'run_id,item_id,arm',
    );
  }

  upsertMetrics(rows: MetricRow[]) {
    return this.upsert(
      'eval_metrics',
      rows.map((m) => ({
        run_id: m.runId,
        arm: m.arm,
        area: m.area,
        metric: m.metric,
        scope: m.scope,
        value: m.value,
        ci_low: m.ciLow,
        ci_high: m.ciHigh,
        n: m.n,
        na_rate: m.naRate,
        in_distribution: m.inDistribution,
      })),
      'run_id,arm,area,metric,scope',
      200,
    );
  }

  async resultKeys(runId: string): Promise<{ item_id: string; arm: string; status: string }[] | null> {
    return (await this.selectWhere('eval_results', 'item_id,arm,status', 'run_id', runId)) as
      | { item_id: string; arm: string; status: string }[]
      | null;
  }
}

export function itemRow(it: EvalItem, relRoot = ''): Record<string, unknown> {
  const gt = it.gt;
  return {
    id: it.id,
    dataset_id: it.datasetId,
    split: it.split,
    image_sha256: it.imageSha256,
    dhash: it.dhash,
    rel_path: relRoot ? `${relRoot}/${it.relPath}` : it.relPath,
    width: it.width,
    height: it.height,
    gt,
    has_mask: Boolean(gt.woundMaskPath),
    has_tissue: Boolean(gt.tissuePct || gt.tissueMaskPaths),
    has_type: Boolean(gt.woundType),
    has_exudate: Boolean(gt.exudate),
    has_infection: Boolean(gt.infection),
    has_scale: Boolean(gt.markerPresent !== undefined || gt.areaCm2 || gt.lengthCm),
    strata: it.strata,
    duplicate_of: it.duplicateOf,
  };
}
