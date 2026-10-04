/**
 * Dataset profiler (spec §7): deterministic, offline. It describes a downloaded
 * dataset's layout so a person (or Cursor, following the onboarding rule) can
 * write its manifest. It never overwrites an existing `dataset.yaml`.
 *
 *   npx tsx eval/cli.mts profile --dir=<abs path> --id=<dataset-id>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { stringify as toYaml } from 'yaml';

import { colourHistogram, dHash, decodeImage, exifOrientation, imageSize, sha256Hex } from './io';
import { isImage, listDirs, listFiles, maskBaseStem, parseDelimited, stemOf } from './adapters/common';
import { datasetsDir } from './manifest';
import { outDir } from './env';

type TreeNode = { name: string; files: number; dirs?: TreeNode[]; truncated?: boolean };

function tree(dir: string, depth: number): TreeNode {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
  const files = entries.filter((e) => e.isFile()).length;
  const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const node: TreeNode = { name: basename(dir), files };
  if (depth > 0 && subdirs.length) {
    node.dirs = subdirs.slice(0, 20).map((d) => tree(join(dir, d), depth - 1));
    if (subdirs.length > 20) node.truncated = true;
  }
  return node;
}

// Whole words only: `Annotations/` and `labels/` are masks, `Labeled/` is not.
const MASKY = /(^|[^a-z])(masks?|labels?|gt|seg|segmentation|annotations?|palette)([^a-z]|$)/i;
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null;
};

export type Profile = {
  id: string;
  dir: string;
  generatedAt: string;
  tree: TreeNode;
  extensions: Record<string, number>;
  filesPerDir: Record<string, number>;
  images: {
    count: number;
    formats: Record<string, number>;
    width: { min: number | null; median: number | null; max: number | null };
    height: { min: number | null; median: number | null; max: number | null };
    exifOriented: number;
    unreadable: number;
  };
  pairing: { images: string; masks: string; matched: number; of: number; fraction: number }[];
  masks: { dir: string; sampled: number; binary: boolean; palette: { value: string; share: number }[] }[];
  tables: { path: string; rows: number; headers: string[]; columns: Record<string, { cardinality: number; top: [string, number][] }>; joinKey: string | null }[];
  json: { path: string; flavour: 'coco' | 'labelme' | 'vqa' | 'unknown'; detail: Record<string, unknown> }[];
  classFolders: { parent: string; classes: Record<string, number> }[];
  duplicates: { exact: number; near: number };
  suggestion: { adapter: string; confidence: number; reason: string; draft: Record<string, unknown> };
};

export function profileDataset(dir: string, id: string): Profile {
  const files = listFiles(dir, true);
  const rel = (p: string) => relative(dir, p).split('\\').join('/');
  const extensions: Record<string, number> = {};
  const filesPerDir: Record<string, number> = {};
  for (const f of files) {
    const e = extname(f).toLowerCase() || '(none)';
    extensions[e] = (extensions[e] ?? 0) + 1;
    const d = rel(dirname(f)) || '.';
    filesPerDir[d] = (filesPerDir[d] ?? 0) + 1;
  }

  // Images (headers only for size; a bounded sample is decoded for hashing).
  const images = files.filter(isImage);
  const photoDirs = new Map<string, string[]>();
  const maskDirs = new Map<string, string[]>();
  for (const f of images) {
    const d = dirname(f);
    const target = MASKY.test(rel(d)) || MASKY.test(stemOf(f).replace(/^\d+/, '')) ? maskDirs : photoDirs;
    target.set(d, [...(target.get(d) ?? []), f]);
  }
  const photos = [...photoDirs.values()].flat();
  const widths: number[] = [];
  const heights: number[] = [];
  const formats: Record<string, number> = {};
  let exifOriented = 0;
  let unreadable = 0;
  for (const f of photos) {
    const bytes = readFileSync(f);
    const size = imageSize(bytes);
    const fmt = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpeg' : bytes[0] === 0x89 ? 'png' : extname(f).slice(1).toLowerCase();
    formats[fmt] = (formats[fmt] ?? 0) + 1;
    if (!size) {
      unreadable += 1;
      continue;
    }
    widths.push(size.width);
    heights.push(size.height);
    if (exifOrientation(bytes) !== 1) exifOriented += 1;
  }

  // Pairing: photo dir A × mask dir B, by stem (mask suffixes allowed).
  const pairing: Profile['pairing'] = [];
  for (const [a, aFiles] of photoDirs) {
    for (const [b, bFiles] of maskDirs) {
      const stems = new Set(bFiles.map((f) => maskBaseStem(stemOf(f)).toLowerCase()));
      const matched = aFiles.filter((f) => stems.has(stemOf(f).toLowerCase())).length;
      if (matched) pairing.push({ images: rel(a) || '.', masks: rel(b) || '.', matched, of: aFiles.length, fraction: matched / aFiles.length });
    }
  }
  pairing.sort((x, y) => y.matched - x.matched);

  // Masks: unique values on up to 50 per directory.
  const masks: Profile['masks'] = [];
  for (const [d, mFiles] of maskDirs) {
    const totals = new Map<string, number>();
    const sample = mFiles.slice(0, 50);
    for (const f of sample) {
      try {
        for (const { value, share } of colourHistogram(readFileSync(f), 64)) totals.set(value, (totals.get(value) ?? 0) + share / sample.length);
      } catch {
        /* unreadable mask */
      }
    }
    const palette = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([value, share]) => ({ value, share: Number(share.toFixed(4)) }));
    masks.push({ dir: rel(d) || '.', sampled: sample.length, binary: palette.length <= 3, palette: palette.slice(0, 24) });
  }

  // Tables.
  const stems = new Set(photos.map((f) => stemOf(f).toLowerCase()));
  const tables: Profile['tables'] = [];
  for (const f of files.filter((p) => /\.(csv|tsv|tab)$/i.test(p))) {
    const rows = parseDelimited(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''), /\.csv$/i.test(f) ? ',' : '\t');
    const [header = [], ...body] = rows;
    const columns: Profile['tables'][number]['columns'] = {};
    let joinKey: string | null = null;
    let bestJoin = 0;
    header.forEach((h, i) => {
      const counts = new Map<string, number>();
      for (const r of body) counts.set(r[i] ?? '', (counts.get(r[i] ?? '') ?? 0) + 1);
      columns[h] = { cardinality: counts.size, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15) };
      const hits = body.filter((r) => stems.has(stemOf(String(r[i] ?? '')).toLowerCase())).length;
      if (hits > bestJoin) {
        bestJoin = hits;
        joinKey = h;
      }
    });
    tables.push({ path: rel(f), rows: body.length, headers: header, columns, joinKey });
  }
  if (files.some((p) => /\.xlsx?$/i.test(p))) {
    tables.push({ path: '(xlsx present — not parsed; export to CSV)', rows: 0, headers: [], columns: {}, joinKey: null });
  }

  // JSON flavours.
  const json: Profile['json'] = [];
  for (const f of files.filter((p) => /\.json$/i.test(p)).slice(0, 200)) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      json.push({ path: rel(f), flavour: 'unknown', detail: { error: 'invalid JSON' } });
      continue;
    }
    const o = data as Record<string, unknown>;
    if (o && typeof o === 'object' && 'images' in o && 'annotations' in o && 'categories' in o) {
      json.push({ path: rel(f), flavour: 'coco', detail: { images: (o.images as unknown[]).length, annotations: (o.annotations as unknown[]).length, categories: o.categories } });
    } else if (o && typeof o === 'object' && 'shapes' in o && 'imagePath' in o) {
      json.push({ path: rel(f), flavour: 'labelme', detail: { labels: [...new Set((o.shapes as { label: string }[]).map((s) => s.label))] } });
    } else if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
      const keys: Record<string, { cardinality: number; top: [string, number][] }> = {};
      for (const k of Object.keys(data[0] as object)) {
        const counts = new Map<string, number>();
        for (const row of data as Record<string, unknown>[]) {
          const v = JSON.stringify(row[k] ?? null).slice(0, 80);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        keys[k] = { cardinality: counts.size, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15) };
      }
      json.push({ path: rel(f), flavour: 'vqa', detail: { rows: data.length, keys } });
    } else {
      json.push({ path: rel(f), flavour: 'unknown', detail: { keys: o && typeof o === 'object' ? Object.keys(o).slice(0, 20) : typeof o } });
    }
  }
  const labelmeCount = json.filter((j) => j.flavour === 'labelme').length;

  // Class folders: a directory whose image-bearing children look like classes.
  const classFolders: Profile['classFolders'] = [];
  const parents = new Set([...photoDirs.keys()].map((d) => dirname(d)));
  for (const p of parents) {
    const kids = listDirs(p).filter((k) => photoDirs.has(join(p, k)) || listFiles(join(p, k), true).some(isImage));
    if (kids.length >= 2 && !kids.some((k) => MASKY.test(k))) {
      classFolders.push({ parent: rel(p) || '.', classes: Object.fromEntries(kids.map((k) => [k, listFiles(join(p, k), true).filter(isImage).length])) });
    }
  }

  // Duplicates over a bounded sample (decoding is the slow part).
  const sample = photos.slice(0, 3000);
  const shas = new Map<string, number>();
  const hashes: string[] = [];
  let near = 0;
  for (const f of sample) {
    const bytes = readFileSync(f);
    const sha = sha256Hex(bytes);
    shas.set(sha, (shas.get(sha) ?? 0) + 1);
    try {
      const h = dHash(decodeImage(bytes));
      if (hashes.some((x) => hamming(x, h) <= 4)) near += 1;
      hashes.push(h);
    } catch {
      /* not decodable here */
    }
  }
  const exact = [...shas.values()].reduce((a, n) => a + (n - 1), 0);

  // Suggestion.
  const best = pairing[0];
  let suggestion: Profile['suggestion'];
  const base = { id, name: id, version: '', source_url: '<fill in>', access: 'direct_download', licence: '<paste the licence text, or "none stated" + URL checked + date>', image_source: 'public_dataset', known_training_use: [], root: id };
  if (json.some((j) => j.flavour === 'coco')) {
    const c = json.find((j) => j.flavour === 'coco')!;
    suggestion = { adapter: 'coco', confidence: 0.9, reason: `COCO file ${c.path}`, draft: { ...base, adapter: 'coco', options: { annotations: c.path, images: '.' }, labelMap: { category: {} } } };
  } else if (labelmeCount > 0) {
    suggestion = { adapter: 'labelme', confidence: 0.85, reason: `${labelmeCount} LabelMe JSON file(s)`, draft: { ...base, adapter: 'labelme', options: { annotations: '.' }, labelMap: { category: {} } } };
  } else if (best && best.fraction > 0.5) {
    const palette = masks.find((m) => m.dir === best.masks);
    suggestion = {
      adapter: 'folderMasks',
      confidence: Math.min(0.95, 0.5 + best.fraction / 2),
      reason: `${best.matched}/${best.of} images in ${best.images} have a mask in ${best.masks}${palette && !palette.binary ? ' (palette → tissue masks?)' : ''}`,
      draft: { ...base, adapter: 'folderMasks', options: palette && !palette.binary ? { images: best.images, tissue_masks: best.masks } : { images: best.images, masks: best.masks, mask_threshold: 127 }, defaults: { woundPresent: true }, labelMap: {} },
    };
  } else if (tables.some((t) => t.joinKey)) {
    const t = tables.find((x) => x.joinKey)!;
    suggestion = { adapter: 'tabular', confidence: 0.7, reason: `table ${t.path} joins on column "${t.joinKey}"`, draft: { ...base, adapter: 'tabular', options: { table: t.path, key_column: t.joinKey, image_pattern: '<dir>/{key}.jpg' }, fieldMap: {}, labelMap: {} } };
  } else if (classFolders.length) {
    const cf = classFolders[0];
    suggestion = {
      adapter: 'classFolders',
      confidence: 0.75,
      reason: `class folders under ${cf.parent}: ${Object.keys(cf.classes).join(', ')}`,
      draft: { ...base, adapter: 'classFolders', options: { images: cf.parent, label_field: 'woundType' }, labelMap: { woundType: Object.fromEntries(Object.keys(cf.classes).map((k) => [k, '<canonical>'])) } },
    };
  } else {
    suggestion = { adapter: 'custom', confidence: 0.2, reason: 'no known layout recognised — inspect manually', draft: { ...base, adapter: 'custom' } };
  }

  return {
    id,
    dir,
    generatedAt: new Date().toISOString(),
    tree: tree(dir, 4),
    extensions,
    filesPerDir,
    images: {
      count: photos.length,
      formats,
      width: { min: widths.length ? Math.min(...widths) : null, median: quantile(widths, 0.5), max: widths.length ? Math.max(...widths) : null },
      height: { min: heights.length ? Math.min(...heights) : null, median: quantile(heights, 0.5), max: heights.length ? Math.max(...heights) : null },
      exifOriented,
      unreadable,
    },
    pairing: pairing.slice(0, 20),
    masks,
    tables,
    json,
    classFolders,
    duplicates: { exact, near },
    suggestion,
  };
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export function profileCommand(args: Record<string, unknown>): number {
  const dir = typeof args.dir === 'string' ? args.dir : null;
  const id = typeof args.id === 'string' ? args.id : null;
  if (!dir || !id || !existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error('usage: npx tsx eval/cli.mts profile --dir=<abs path> --id=<dataset-id>');
    return 2;
  }
  const profile = profileDataset(dir, id);
  const pDir = join(outDir(), 'profiles', id);
  mkdirSync(pDir, { recursive: true });
  writeFileSync(join(pDir, 'profile.json'), JSON.stringify(profile, null, 2));
  const mDir = join(datasetsDir(), id);
  mkdirSync(mDir, { recursive: true });
  const draftPath = join(mDir, 'dataset.draft.yaml');
  writeFileSync(draftPath, `# DRAFT from the profiler (${profile.generatedAt}). Review, complete and save as dataset.yaml.\n# ${profile.suggestion.reason} (confidence ${profile.suggestion.confidence.toFixed(2)})\n${toYaml(profile.suggestion.draft)}`);
  console.log(`profile → ${join(pDir, 'profile.json')}`);
  console.log(`draft   → ${draftPath}${existsSync(join(mDir, 'dataset.yaml')) ? '  (dataset.yaml exists and was left alone)' : ''}`);
  console.log(`images ${profile.images.count} (${JSON.stringify(profile.images.formats)}), ${profile.images.width.median}×${profile.images.height.median} median; suggested adapter: ${profile.suggestion.adapter}`);
  return 0;
}
