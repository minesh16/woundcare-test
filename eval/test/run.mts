/**
 * The harness's own test suite (spec §21). Offline: no network, no Supabase.
 *
 *   npx tsx eval/test/run.mts [filter]
 *
 * Every *.test.mts here exports `default (t: T) => Promise<void>`. The runner
 * points EVAL_DATA_DIR / EVAL_OUT_DIR / EVAL_DATASETS_DIR at a temp directory,
 * blanks every provider credential, and replaces `fetch` with one that throws —
 * so a test that reaches the network fails rather than costs money.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'mendwise-eval-test-'));
process.env.EVAL_DATA_DIR = join(tmp, 'data');
process.env.EVAL_OUT_DIR = join(tmp, 'out');
process.env.EVAL_DATASETS_DIR = join(tmp, 'datasets');
for (const k of ['FAL_KEY', 'FUSEGNET_MODAL_URL', 'FUSEGNET_AUTH_TOKEN', 'MODAL_KEY', 'MODAL_SECRET', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  process.env[k] = '';
}
delete process.env.VERCEL;
delete process.env.SEGMENTATION_PROVIDERS;
delete process.env.TISSUE_RELATIVE;
process.env.NODE_ENV = 'test';

export const offlineFetch = (async (input: unknown) => {
  throw new Error(`network disabled in tests: ${String(input instanceof Request ? input.url : input)}`);
}) as typeof fetch;
globalThis.fetch = offlineFetch;

export type T = {
  tmp: string;
  ok(cond: unknown, name: string, detail?: unknown): void;
  eq(actual: unknown, expected: unknown, name: string): void;
  near(actual: number | null | undefined, expected: number, tol: number, name: string): void;
  throws(fn: () => unknown, name: string, match?: RegExp): Promise<void>;
  load<M>(path: string): Promise<M>;
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

const t: T = {
  tmp,
  ok(cond, name, detail) {
    if (cond) passed += 1;
    else {
      failed += 1;
      failures.push(name);
      console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
    }
  },
  eq(actual, expected, name) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    t.ok(a === e, name, { actual, expected });
  },
  near(actual, expected, tol, name) {
    t.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tol, name, { actual, expected, tol });
  },
  async throws(fn, name, match) {
    try {
      await fn();
      t.ok(false, name, 'did not throw');
    } catch (error) {
      t.ok(!match || match.test(error instanceof Error ? error.message : String(error)), name, error instanceof Error ? error.message : error);
    }
  },
  async load<M>(path: string): Promise<M> {
    const mod = (await import(path)) as Record<string, unknown>;
    const named = Object.keys(mod).filter((k) => k !== 'default');
    return (named.length === 0 && mod.default && typeof mod.default === 'object' ? mod.default : mod) as M;
  },
};

const filter = process.argv[2];
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mts') && (!filter || f.includes(filter)))
  .sort();

try {
  for (const f of files) {
    const before = { passed, failed };
    const started = Date.now();
    const mod = (await import(join(here, f))) as { default: (t: T) => Promise<void> };
    try {
      await mod.default(t);
    } catch (error) {
      failed += 1;
      failures.push(`${f}: threw`);
      console.error(`  ERROR in ${f}:`, error instanceof Error ? error.stack : error);
    }
    globalThis.fetch = offlineFetch;
    console.log(`${failed > before.failed ? '✗' : '✓'} ${f.padEnd(28)} ${passed - before.passed} passed, ${failed - before.failed} failed (${Date.now() - started} ms)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed) {
  console.log(`Failures:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('All eval harness checks passed.');
