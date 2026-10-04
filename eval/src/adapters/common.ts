/**
 * The adapter contract (spec §8) and the helpers the built-in adapters share.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import type { Manifest } from '../manifest';
import type { MaskPixels } from '../io';

export type Polygon = { label: string; points: [number, number][] };

export type RawItem = {
  /** Stable within the dataset: the relative image path, no extension. */
  key: string;
  /** Absolute. */
  imagePath: string;
  split?: string;
  /** Binary wound mask file. */
  maskPath?: string;
  /** Palette tissue mask file (decoded with the manifest's tissueMaskMap). */
  tissueMaskPath?: string;
  /** Labelled polygons, in image pixel coordinates of `polygonFrame`. */
  polygons?: Polygon[];
  /** The frame polygon coordinates refer to (defaults to the upright image). */
  polygonFrame?: { width: number; height: number };
  /** Already-decoded per-label masks (e.g. COCO RLE). */
  labelMasks?: { label: string; mask: MaskPixels }[];
  /** Raw fields: folder name, CSV row, JSON attributes. */
  labels: Record<string, unknown>;
};

export interface Adapter {
  name: string;
  /** Yield raw items: an image path plus whatever labels the format carries. */
  enumerate(manifest: Manifest, root: string): AsyncIterable<RawItem>;
}

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp']);
/** Suffixes a mask's stem may carry beyond its image's stem. */
export const MASK_SUFFIXES = ['_mask', '-mask', '_masks', '_gt', '-gt', '_label', '_labels', '_seg', '_segmentation', '_annotation'];

export const isImage = (p: string) => IMAGE_EXTS.has(extname(p).toLowerCase());
export const stemOf = (p: string) => basename(p, extname(p));

/** Files under `dir`, sorted; recursive when asked. Hidden files are skipped. */
export function listFiles(dir: string, recursive = false): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.') || name === '__MACOSX') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (recursive) walk(p);
      } else out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== '__MACOSX')
    .map((d) => d.name)
    .sort();
}

/** Strip a known mask suffix from a stem, case-insensitively. */
export function maskBaseStem(stem: string, suffixes: readonly string[] = MASK_SUFFIXES): string {
  const lower = stem.toLowerCase();
  for (const s of suffixes) if (lower.endsWith(s)) return stem.slice(0, stem.length - s.length);
  return stem;
}

/** stem → file, for a directory of masks named after their images (with or without a suffix). */
export function maskIndex(dir: string, recursive = false): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of listFiles(dir, recursive)) {
    if (!isImage(f)) continue;
    const stem = stemOf(f);
    map.set(stem.toLowerCase(), f);
    const base = maskBaseStem(stem);
    if (!map.has(base.toLowerCase())) map.set(base.toLowerCase(), f);
  }
  return map;
}

export function keyFor(root: string, imagePath: string): string {
  const rel = relative(root, imagePath).split('\\').join('/');
  return rel.slice(0, rel.length - extname(rel).length);
}

export function opt<T>(manifest: Manifest, name: string, fallback: T): T {
  const v = manifest.options[name];
  return (v === undefined || v === null ? fallback : v) as T;
}

/** `{split}` (and other `{name}`) substitution. */
export function fill(pattern: string, vars: Record<string, string | undefined>): string {
  return pattern.replace(/\{([^}]+)\}/g, (_m, k: string) => vars[k] ?? '');
}

/** The (split name, folder) pairs to walk: the manifest's splits, or one unnamed split. */
export function splitsOf(manifest: Manifest): { split?: string; folder: string }[] {
  if (manifest.splits && Object.keys(manifest.splits).length) {
    return Object.entries(manifest.splits).map(([split, folder]) => ({ split, folder }));
  }
  return [{ folder: '' }];
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** RFC-4180-ish CSV/TSV parser: quotes, escaped quotes, newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Read CSV / TSV / JSONL / JSON (array) into objects. XLSX is not supported (see eval/NOTES.md). */
export function readTable(path: string): Record<string, unknown>[] {
  const ext = extname(path).toLowerCase();
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  if (ext === '.jsonl' || ext === '.ndjson') {
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  if (ext === '.json') {
    const data = JSON.parse(text) as unknown;
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    throw new Error(`${path}: expected a JSON array of objects.`);
  }
  if (ext === '.xlsx' || ext === '.xls') {
    throw new Error(`${path}: XLSX is not supported — export it to CSV (eval/NOTES.md).`);
  }
  const rows = parseDelimited(text, ext === '.tsv' || ext === '.tab' ? '\t' : ',');
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

/** Dotted-path lookup (`a.b.0.c`) for JSON metadata. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
