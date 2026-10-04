/**
 * Provider response cache (spec §13.7) — `globalThis.fetch`, wrapped inside the
 * harness process only. The app is untouched: both providers call the global
 * `fetch` with deterministic JSON bodies (`sam3Request` / `fusegnetRequest`).
 *
 * Caching RAW PROVIDER RESPONSES rather than whole segmentation outcomes means
 *  - a SAM 3 answer is paid for once per image, whichever arm asked for it;
 *  - the app's selection, plausibility and chain logic still run on every item,
 *    so a change to them is never hidden behind a stale result.
 *
 * Intercepted: POST https://fal.run/* (SAM 3), POST to FUSEGNET_MODAL_URL's
 * origin (FUSegNet), GET *.fal.media (mask URLs, only with SAM3_SYNC_MODE=false).
 * Everything else — the gateway, Supabase, any other host — passes straight
 * through.
 *
 * Key = sha256(method \n url \n body \n epoch). Headers are NEVER part of the key
 * or the stored entry: that is where `Authorization: Key …` / `Bearer …` live.
 * Only 2xx responses are stored; timeouts and errors always go to the network
 * on the next run.
 *
 * The same wrapper does the per-provider rate limiting and transient-error
 * retries (spec §13.2), so cache hits cost neither tokens nor time.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { outDir } from './env';

export type ProviderKind = 'fal' | 'modal' | 'fal_media';
export const PROVIDER_KINDS: ProviderKind[] = ['fal', 'modal', 'fal_media'];

export type CacheEntry = {
  host: string;
  kind: ProviderKind;
  path: string;
  status: number;
  contentType: string;
  body: string;
  binary: boolean;
  storedAt: string;
  epoch: string;
};

type Counts = Record<ProviderKind, number>;
const zero = (): Counts => ({ fal: 0, modal: 0, fal_media: 0 });

/** Per-item context, so the wrapper can attribute calls and honour per-dataset cache policy. */
export type ItemContext = { itemId: string; imageSha: string; cacheEnabled: boolean };
export const itemContext = new AsyncLocalStorage<ItemContext>();

type State = {
  installed: boolean;
  enabled: boolean;
  epoch: string;
  realFetch: typeof fetch;
  hits: Counts;
  misses: Counts;
  retries: Counts;
  errors: Counts;
  minIntervalMs: Partial<Record<ProviderKind, number>>;
  nextSlot: Counts;
  onBilledCall: ((kind: ProviderKind) => void) | null;
  dirOverride: string | null;
};

const state: State = {
  installed: false,
  enabled: true,
  epoch: 'v1',
  realFetch: globalThis.fetch,
  hits: zero(),
  misses: zero(),
  retries: zero(),
  errors: zero(),
  minIntervalMs: {},
  nextSlot: zero(),
  onBilledCall: null,
  dirOverride: null,
};

export function cacheDir(): string {
  return state.dirOverride ?? join(outDir(), 'cache', 'http');
}

function modalOrigin(): string | null {
  const raw = process.env.FUSEGNET_MODAL_URL;
  if (!raw) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

/** Which provider a request belongs to, or null to pass it through. */
export function classify(url: string, method: string): ProviderKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (method === 'POST' && parsed.protocol === 'https:' && parsed.hostname === 'fal.run') return 'fal';
  const modal = modalOrigin();
  if (method === 'POST' && modal && parsed.origin === modal) return 'modal';
  if (method === 'GET' && parsed.protocol === 'https:' && (parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media'))) return 'fal_media';
  return null;
}

/** The epoch a key is built with: `--cache-epoch`, plus FUSEGNET_MODEL_LABEL for Modal. */
export function epochFor(kind: ProviderKind): string {
  return kind === 'modal' ? `${state.epoch}|${process.env.FUSEGNET_MODEL_LABEL ?? ''}` : state.epoch;
}

export function cacheKey(method: string, url: string, body: string, epoch: string): string {
  return createHash('sha256').update(`${method}\n${url}\n${body}\n${epoch}`).digest('hex');
}

export function keyForRequest(kind: ProviderKind, req: { method: string; url: string; body: string }): string {
  return cacheKey(req.method.toUpperCase(), req.url, req.body, epochFor(kind));
}

function entryPath(key: string): string {
  return join(cacheDir(), key.slice(0, 2), `${key}.json`);
}

export function hasKey(key: string): boolean {
  return existsSync(entryPath(key));
}

function readEntry(key: string): CacheEntry | null {
  try {
    return JSON.parse(readFileSync(entryPath(key), 'utf8')) as CacheEntry;
  } catch {
    return null;
  }
}

/** Atomic write (temp file + rename), so concurrent workers can't corrupt an entry. */
function writeEntry(key: string, entry: CacheEntry): void {
  const path = entryPath(key);
  mkdirSync(join(cacheDir(), key.slice(0, 2)), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, path);
}

function toResponse(entry: CacheEntry): Response {
  const body = entry.binary ? Buffer.from(entry.body, 'base64') : entry.body;
  return new Response(body, { status: entry.status, headers: { 'content-type': entry.contentType } });
}

/** Which keys a given image used, by role — lets the estimator see second-opinion hits. */
function recordIndex(ctx: ItemContext | undefined, kind: ProviderKind, body: string, key: string): void {
  if (!ctx?.imageSha || kind === 'fal_media') return;
  let role: string = kind === 'fal' ? 'sam3' : 'fusegnet_standalone';
  if (kind === 'modal') {
    try {
      if (Array.isArray((JSON.parse(body) as { box?: unknown }).box)) role = 'fusegnet_second';
    } catch {
      /* not JSON: leave the role */
    }
  }
  const dir = join(cacheDir(), 'index');
  const path = join(dir, `${ctx.imageSha}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    const current = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
    const field = `${role}@${epochFor(kind)}`;
    if (current[field] === key) return;
    current[field] = key;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(current));
    renameSync(tmp, path);
  } catch {
    /* the index is an estimator aid only */
  }
}

/** The key an image's FUSegNet second opinion used last time, if recorded. */
export function indexedKey(imageSha: string, role: 'sam3' | 'fusegnet_second' | 'fusegnet_standalone', kind: ProviderKind): string | null {
  try {
    const current = JSON.parse(readFileSync(join(cacheDir(), 'index', `${imageSha}.json`), 'utf8')) as Record<string, string>;
    return current[`${role}@${epochFor(kind)}`] ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rateLimit(kind: ProviderKind): Promise<void> {
  const interval = state.minIntervalMs[kind];
  if (!interval) return;
  const now = Date.now();
  const slot = Math.max(now, state.nextSlot[kind]);
  state.nextSlot[kind] = slot + interval;
  if (slot > now) await sleep(slot - now);
}

const TRANSIENT = new Set([429, 502, 503, 504]);
export const MAX_ATTEMPTS = 3;

async function fetchWithRetry(kind: ProviderKind, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await rateLimit(kind);
    try {
      const res = await state.realFetch(input, init);
      if (!TRANSIENT.has(res.status) || attempt >= MAX_ATTEMPTS || init?.signal?.aborted) return res;
    } catch (error) {
      const aborted = (error instanceof Error && error.name === 'AbortError') || init?.signal?.aborted;
      if (aborted || attempt >= MAX_ATTEMPTS) {
        state.errors[kind] += 1;
        throw error;
      }
    }
    state.retries[kind] += 1;
    await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
  }
}

async function cachedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  const kind = classify(url, method);
  if (!kind) return state.realFetch(input, init);

  const ctx = itemContext.getStore();
  const body = typeof init?.body === 'string' ? init.body : init?.body == null ? '' : null;
  const useCache = state.enabled && (ctx?.cacheEnabled ?? true) && body !== null;
  const key = body !== null ? cacheKey(method, url, body, epochFor(kind)) : null;
  if (key && body !== null) recordIndex(ctx, kind, body, key);

  if (useCache && key) {
    const hit = readEntry(key);
    if (hit) {
      state.hits[kind] += 1;
      return toResponse(hit);
    }
  }

  state.misses[kind] += 1;
  if (kind !== 'fal_media') state.onBilledCall?.(kind);
  const res = await fetchWithRetry(kind, input, init);
  if (!useCache || !key || !res.ok) return res;

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const textual = /json|text|xml/i.test(contentType);
  const buf = Buffer.from(await res.arrayBuffer());
  const parsed = new URL(url);
  writeEntry(key, {
    host: parsed.hostname,
    kind,
    path: parsed.pathname,
    status: res.status,
    contentType,
    body: textual ? buf.toString('utf8') : buf.toString('base64'),
    binary: !textual,
    storedAt: new Date().toISOString(),
    epoch: epochFor(kind),
  });
  return new Response(textual ? buf.toString('utf8') : buf, { status: res.status, headers: { 'content-type': contentType } });
}

export function installProviderCache(opts: { enabled?: boolean; epoch?: string; dir?: string; realFetch?: typeof fetch } = {}): void {
  // (Re)install whenever `fetch` is not the wrapper — something else may have replaced it.
  if (globalThis.fetch !== (cachedFetch as typeof fetch)) {
    state.realFetch = opts.realFetch ?? globalThis.fetch;
    globalThis.fetch = cachedFetch as typeof fetch;
    state.installed = true;
  } else if (opts.realFetch) {
    state.realFetch = opts.realFetch;
  }
  if (opts.enabled !== undefined) state.enabled = opts.enabled;
  if (opts.epoch) state.epoch = opts.epoch;
  if (opts.dir !== undefined) state.dirOverride = opts.dir || null;
  if (state.enabled && process.env.SAM3_SYNC_MODE === 'false') {
    console.warn('provider cache: SAM3_SYNC_MODE=false — SAM 3 returns mask URLs, which will be fetched and cached too.');
  }
}

export function isInstalled(): boolean {
  return state.installed && globalThis.fetch === (cachedFetch as typeof fetch);
}

export function assertInstalled(): void {
  if (!isInstalled()) throw new Error('provider cache: not installed before the first segmentation call (spec §13.7).');
}

export function setCacheEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

export function cacheEnabled(): boolean {
  return state.enabled;
}

/** Requests per minute per provider; 0 / undefined = unlimited. */
export function setRateLimits(rpm: Partial<Record<ProviderKind, number>>): void {
  for (const [k, v] of Object.entries(rpm) as [ProviderKind, number | undefined][]) {
    state.minIntervalMs[k] = v && v > 0 ? 60_000 / v : undefined;
  }
}

export function onBilledCall(fn: ((kind: ProviderKind) => void) | null): void {
  state.onBilledCall = fn;
}

export function counters(): { hits: Counts; misses: Counts; retries: Counts; errors: Counts } {
  return { hits: { ...state.hits }, misses: { ...state.misses }, retries: { ...state.retries }, errors: { ...state.errors } };
}

export function resetCounters(): void {
  state.hits = zero();
  state.misses = zero();
  state.retries = zero();
  state.errors = zero();
}

// ---------------------------------------------------------------------------
// `cache stats` / `cache clear`
// ---------------------------------------------------------------------------

function* entries(): Generator<{ path: string; size: number }> {
  const root = cacheDir();
  if (!existsSync(root)) return;
  for (const shard of readdirSync(root)) {
    if (shard === 'index' || shard.length !== 2) continue;
    const dir = join(root, shard);
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) yield { path: join(dir, f), size: statSync(join(dir, f)).size };
  }
}

export function cacheStats(): Record<string, { entries: number; bytes: number }> {
  const out: Record<string, { entries: number; bytes: number }> = {};
  for (const e of entries()) {
    let host = 'unknown';
    try {
      host = (JSON.parse(readFileSync(e.path, 'utf8')) as CacheEntry).host;
    } catch {
      /* unreadable entry */
    }
    out[host] ??= { entries: 0, bytes: 0 };
    out[host].entries += 1;
    out[host].bytes += e.size;
  }
  return out;
}

export function cacheClear(opts: { host?: string; before?: string } = {}): number {
  const before = opts.before ? Date.parse(opts.before) : null;
  let removed = 0;
  for (const e of entries()) {
    let entry: CacheEntry | null = null;
    try {
      entry = JSON.parse(readFileSync(e.path, 'utf8')) as CacheEntry;
    } catch {
      entry = null;
    }
    if (opts.host) {
      const matches = opts.host === 'modal' ? entry?.kind === 'modal' : entry?.host === opts.host || entry?.kind === opts.host;
      if (!matches) continue;
    }
    if (before !== null && entry && Date.parse(entry.storedAt) >= before) continue;
    rmSync(e.path, { force: true });
    removed += 1;
  }
  return removed;
}

export function cacheCommand(args: { _: string[]; [k: string]: unknown }): number {
  const sub = args._[1];
  if (sub === 'stats') {
    const stats = cacheStats();
    console.log(`provider cache: ${cacheDir()}`);
    const rows = Object.entries(stats);
    if (rows.length === 0) console.log('  (empty)');
    for (const [host, s] of rows) console.log(`  ${host.padEnd(40)} ${String(s.entries).padStart(6)} entries  ${(s.bytes / 1e6).toFixed(1)} MB`);
    const totals = readTotals();
    if (totals) console.log(`  cumulative hits: ${JSON.stringify(totals.hits)}  misses: ${JSON.stringify(totals.misses)}`);
    return 0;
  }
  if (sub === 'clear') {
    const removed = cacheClear({
      host: typeof args.host === 'string' ? args.host : undefined,
      before: typeof args.before === 'string' ? args.before : undefined,
    });
    console.log(`provider cache: removed ${removed} entr${removed === 1 ? 'y' : 'ies'}.`);
    return 0;
  }
  console.log('usage: npx tsx eval/cli.mts cache stats | clear [--host=fal.run|modal] [--before=<date>]');
  return 2;
}

/** Cumulative hit/miss totals across runs (cache/http/stats.json), for `cache stats`. */
export function flushTotals(): void {
  try {
    const path = join(cacheDir(), 'stats.json');
    mkdirSync(cacheDir(), { recursive: true });
    const current = readTotals() ?? { hits: zero(), misses: zero() };
    for (const k of PROVIDER_KINDS) {
      current.hits[k] += state.hits[k];
      current.misses[k] += state.misses[k];
    }
    writeFileSync(path, JSON.stringify(current));
  } catch {
    /* stats are informational */
  }
}

function readTotals(): { hits: Counts; misses: Counts } | null {
  try {
    return JSON.parse(readFileSync(join(cacheDir(), 'stats.json'), 'utf8')) as { hits: Counts; misses: Counts };
  } catch {
    return null;
  }
}
