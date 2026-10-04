/**
 * Environment for the eval harness (spec §2.8–§2.10, §4).
 *
 *  - `.env.local` is read the same way `scripts/dev-server.mts` reads it: an
 *    explicitly set variable wins over the file, and an explicitly EMPTY one
 *    stays empty, so a degraded mode (the `hsv` arm) can be forced on purpose.
 *  - Data and outputs live outside the repo and outside OneDrive.
 *  - The harness refuses to run inside a deployment.
 *
 * Values are never printed. `describeEnv` reports names and presence only.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The repo root: eval/src/env.ts → ../.. */
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const EVAL_ROOT = resolve(REPO_ROOT, 'eval');

let loaded = false;

export function loadEnvLocal(path = join(REPO_ROOT, '.env.local')): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function dataDir(): string {
  return resolve(expandHome(process.env.EVAL_DATA_DIR || '~/MendWiseEval/data'));
}

export function outDir(): string {
  return resolve(expandHome(process.env.EVAL_OUT_DIR || '~/MendWiseEval/out'));
}

/** `EVAL_DATA_DIR/cache/<dataset>` — normalised images and masks for one dataset. */
export function datasetCacheDir(datasetId: string): string {
  return join(dataDir(), 'cache', datasetId);
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export class ProductionGuardError extends Error {}

/** Spec §2.9: never inside a deployment. */
export function productionGuard(env: NodeJS.ProcessEnv = process.env): void {
  if (env.VERCEL || env.NODE_ENV === 'production') {
    throw new ProductionGuardError(
      'The eval harness refuses to run with VERCEL set or NODE_ENV=production. It is an operator tool, not a deployed function.',
    );
  }
}

/**
 * Data must stay out of the repo and out of OneDrive (spec §2.8). A path under
 * either is refused rather than silently used.
 */
export function assertDataLocation(p: string): void {
  const abs = resolve(p);
  if (abs === REPO_ROOT || abs.startsWith(REPO_ROOT + '/')) {
    throw new Error(`Refusing to use ${abs}: eval data and outputs must live outside the repo.`);
  }
  if (/OneDrive|CloudStorage/i.test(abs)) {
    throw new Error(`Refusing to use ${abs}: eval data and outputs must not live in OneDrive.`);
  }
}

export function concurrency(flag?: string | number): number {
  const n = Number(flag ?? process.env.EVAL_CONCURRENCY ?? 4);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

/** Names and presence of the variables the harness reads — never values. */
export function describeEnv(): Record<string, boolean> {
  const names = [
    'FAL_KEY',
    'FUSEGNET_MODAL_URL',
    'FUSEGNET_AUTH_TOKEN',
    'SEGMENTATION_PROVIDERS',
    'FUSEGNET_TRIGGER',
    'AI_GATEWAY_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'EVAL_DATA_DIR',
    'EVAL_OUT_DIR',
  ];
  return Object.fromEntries(names.map((n) => [n, Boolean(process.env[n])]));
}
