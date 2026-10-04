/**
 * Ingest (spec §9): manifest → canonical `EvalItem`s.
 *
 * For each raw item: read the original bytes (hashed with the app's
 * `imageSha256`), orient and normalise the image exactly as the app would see
 * it, resample every ground-truth mask onto THAT grid (the app's
 * `resampleMask`), derive tissue % from tissue masks, map labels onto the
 * canonical vocabulary — counting, never coercing, what does not map — and
 * write the item to `eval_items` and `EVAL_OUT_DIR/items/<dataset>.jsonl`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { rasterisePolygon } from '../../api/_maskGeometry';
import { BODY_ZONE_LABELS } from '../../src/constants/bodyZones';
import { getAdapter, type RawItem } from './adapters';
import { getPath } from './adapters/common';
import { dataDir, datasetCacheDir, outDir } from './env';
import {
  applyOrientation,
  decodeBinaryMask,
  decodePaletteMask,
  imageSha256,
  maskPixelsFrom,
  prepareImage,
  safeKey,
  toGrid,
  writeMaskPng,
  dHash,
  type MaskPixels,
} from './io';
import { DEDUPE_ORDER, dedupeRank, isExcluded, listManifests, loadManifest, type Manifest } from './manifest';
import { GroundTruth, type EvalItem } from './schema';
import { EvalSink } from './sink';
import {
  DOMINANT_TISSUE,
  dominantFromPct,
  EXUDATE,
  isIgnored,
  mapLabel,
  TISSUE_CLASSES,
  TISSUE_SYNONYMS,
  WOUND_TYPES,
  YES_NO,
  type TissueClass,
} from './vocab';

// ---------------------------------------------------------------------------
// Label mapping
// ---------------------------------------------------------------------------

type FieldKind =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'number'; int?: boolean }
  | { kind: 'list' }
  | { kind: 'string' };

const BODY_ZONES = Object.keys(BODY_ZONE_LABELS);

export const FIELD_KINDS: Record<string, FieldKind> = {
  woundPresent: { kind: 'bool' },
  woundType: { kind: 'enum', values: WOUND_TYPES },
  pressureStage: { kind: 'enum', values: ['1', '2', '3', '4', 'unstageable', 'dti'] },
  bodyZone: { kind: 'enum', values: BODY_ZONES },
  dominantTissue: { kind: 'enum', values: DOMINANT_TISSUE },
  exudate: { kind: 'enum', values: EXUDATE },
  infection: { kind: 'enum', values: YES_NO },
  ischaemia: { kind: 'enum', values: YES_NO },
  markerPresent: { kind: 'bool' },
  lengthCm: { kind: 'number' },
  widthCm: { kind: 'number' },
  areaCm2: { kind: 'number' },
  expectedPathwayId: { kind: 'number', int: true },
  expectedReferralCodes: { kind: 'list' },
};

const TRUE = new Set(['yes', 'y', 'true', '1', 'present']);
const FALSE = new Set(['no', 'n', 'false', '0', 'absent']);

export type Unmapped = Record<string, Record<string, number>>;

/**
 * One raw value → GT fields. A labelMap value may be a canonical value, an
 * object of several GT fields (e.g. `Normal: { woundPresent: false }`), or
 * null (a known value that sets nothing).
 */
export function mapField(
  field: string,
  raw: unknown,
  labelMap: Manifest['labelMap'],
  unmapped: Unmapped,
): Record<string, unknown> {
  if (raw === undefined || raw === null || String(raw).trim() === '') return {};
  const record = (r: unknown) => {
    if (isIgnored(field, r, labelMap)) return;
    unmapped[field] ??= {};
    const k = String(r).trim();
    unmapped[field][k] = (unmapped[field][k] ?? 0) + 1;
  };

  if (field.startsWith('tissuePct.')) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return record(raw), {};
    return { [field]: n };
  }
  if (field === 'skinTone.monk' || field === 'skinTone.fitzpatrick') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return record(raw), {};
    return { skinTone: { scale: field.split('.')[1], value: n } };
  }

  const kind = FIELD_KINDS[field];
  const table = labelMap[field];
  if (table) {
    const hit = Object.entries(table).find(([k]) => k.trim().toLowerCase() === String(raw).trim().toLowerCase());
    if (hit) {
      const v = hit[1];
      if (v === null) return {};
      if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
      return { [field]: v };
    }
  }
  if (!kind) return record(raw), {};
  switch (kind.kind) {
    case 'enum': {
      const m = mapLabel(field, raw, labelMap, kind.values);
      if ('value' in m) return { [field]: m.value };
      record(raw);
      return {};
    }
    case 'bool': {
      const s = String(raw).trim().toLowerCase();
      if (TRUE.has(s)) return { [field]: true };
      if (FALSE.has(s)) return { [field]: false };
      record(raw);
      return {};
    }
    case 'number': {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return { [field]: kind.int ? Math.round(n) : n };
      record(raw);
      return {};
    }
    case 'list': {
      const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
      return list.length ? { [field]: list } : {};
    }
    default:
      return { [field]: String(raw) };
  }
}

/** Polygon / mask label → 'wound' | a tissue class | 'ignore' | null (unmapped). */
export function resolveRegionLabel(label: string, labelMap: Manifest['labelMap'], unmapped: Unmapped): 'wound' | TissueClass | 'ignore' | null {
  const table = labelMap.category;
  if (table) {
    const hit = Object.entries(table).find(([k]) => k.trim().toLowerCase() === label.trim().toLowerCase());
    if (hit) {
      const v = hit[1];
      if (v === null || v === 'ignore' || v === 'background') return 'ignore';
      if (v === 'wound' || (TISSUE_CLASSES as readonly string[]).includes(String(v))) return v as 'wound' | TissueClass;
    }
  }
  const s = label.trim().toLowerCase();
  if (s === 'wound' || s === 'ulcer') return 'wound';
  if (TISSUE_SYNONYMS[s]) return TISSUE_SYNONYMS[s];
  if (isIgnored('category', label, labelMap)) return 'ignore';
  unmapped.category ??= {};
  unmapped.category[label] = (unmapped.category[label] ?? 0) + 1;
  return null;
}

function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (const p of parts.slice(0, -1)) {
    cur[p] = (cur[p] as Record<string, unknown> | undefined) ?? {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type Coverage = {
  dataset: string;
  generatedAt: string;
  items: number;
  ok: number;
  failures: { key: string; reason: string }[];
  fieldCoverage: Record<string, number>;
  unmapped: Unmapped;
  unmappedTotal: number;
  duplicates: {
    withinExact: number;
    withinNear: number;
    crossExact: number;
    crossNear: number;
    examples: { item: string; duplicateOf: string; kind: string }[];
  };
  masks: { withMask: number; orientedToMatch: number; sizeMismatch: number; paletteSnappedRate: number | null };
  reencoded: number;
  exifRotated: number;
};

const COVERAGE_FIELDS = [
  'woundPresent',
  'woundType',
  'bodyZone',
  'woundMaskPath',
  'tissueMaskPaths',
  'tissuePct',
  'dominantTissue',
  'exudate',
  'infection',
  'ischaemia',
  'markerPresent',
  'areaCm2',
  'expectedPathwayId',
  'skinTone',
];

function coverageMarkdown(c: Coverage): string {
  const lines = [
    `# Ingest coverage — ${c.dataset}`,
    '',
    `Generated ${c.generatedAt}. Items: **${c.ok}** ok of ${c.items} (${c.failures.length} failed).`,
    '',
    '## Field coverage',
    '',
    '| field | coverage |',
    '|---|---|',
    ...Object.entries(c.fieldCoverage).map(([f, v]) => `| ${f} | ${(100 * v).toFixed(1)}% |`),
    '',
    `## Unmapped raw values (${c.unmappedTotal})`,
    '',
  ];
  if (c.unmappedTotal === 0) lines.push('None. ✓');
  for (const [field, values] of Object.entries(c.unmapped)) {
    lines.push(`- **${field}**: ${Object.entries(values).map(([v, n]) => `\`${v}\` ×${n}`).join(', ')}`);
  }
  lines.push(
    '',
    '## Duplicates',
    '',
    `within dataset: ${c.duplicates.withinExact} exact (sha256), ${c.duplicates.withinNear} near (dHash ≤ 4)  `,
    `across datasets: ${c.duplicates.crossExact} exact, ${c.duplicates.crossNear} near (precedence: ${DEDUPE_ORDER.join(' → ')})`,
    '',
    '## Masks and images',
    '',
    `- items with a wound mask: ${c.masks.withMask}`,
    `- masks rotated to match an EXIF-rotated image: ${c.masks.orientedToMatch}`,
    `- masks whose size differs from the image (resampled anyway): ${c.masks.sizeMismatch}`,
    `- palette snapping rate: ${c.masks.paletteSnappedRate === null ? 'n/a' : `${(100 * c.masks.paletteSnappedRate).toFixed(2)}%`}`,
    `- images re-encoded (PNG or EXIF-rotated): ${c.reencoded}; EXIF-rotated: ${c.exifRotated}`,
    '',
  );
  if (c.failures.length) {
    lines.push('## Failures', '', ...c.failures.slice(0, 50).map((f) => `- \`${f.key}\`: ${f.reason}`), '');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export function itemsPath(datasetId: string): string {
  return join(outDir(), 'items', `${datasetId}.jsonl`);
}

export function loadItems(datasetId: string): EvalItem[] {
  const path = itemsPath(datasetId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalItem);
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hashParts(h: string): [number, number] {
  return [parseInt(h.slice(0, 8), 16) >>> 0, parseInt(h.slice(8, 16), 16) >>> 0];
}

export const NEAR_DUP_HAMMING = 4;

/**
 * Mark duplicates within and across datasets (spec §9): the first occurrence
 * wins, in dedupe precedence order, then by item id. Mutates `duplicateOf`.
 * Returns which items were marked and why.
 */
export function markDuplicates(
  items: EvalItem[],
  /** Datasets excluded from NEAR-duplicate matching (generated images: smooth, low-texture → dHash collisions). */
  nearExempt: (datasetId: string) => boolean = () => false,
): { item: string; duplicateOf: string; kind: 'exact' | 'near'; cross: boolean }[] {
  const ordered = [...items].sort((a, b) => dedupeRank(a.datasetId) - dedupeRank(b.datasetId) || a.datasetId.localeCompare(b.datasetId) || a.id.localeCompare(b.id));
  const bySha = new Map<string, EvalItem>();
  const kept: { item: EvalItem; parts: [number, number] }[] = [];
  const marks: { item: string; duplicateOf: string; kind: 'exact' | 'near'; cross: boolean }[] = [];
  for (const it of ordered) {
    it.duplicateOf = null;
    const exact = bySha.get(it.imageSha256);
    if (exact) {
      it.duplicateOf = exact.id;
      marks.push({ item: it.id, duplicateOf: exact.id, kind: 'exact', cross: exact.datasetId !== it.datasetId });
      continue;
    }
    bySha.set(it.imageSha256, it);
    const parts = it.dhash && !nearExempt(it.datasetId) ? hashParts(it.dhash) : null;
    if (parts) {
      const near = kept.find((k) => popcount32(k.parts[0] ^ parts[0]) + popcount32(k.parts[1] ^ parts[1]) <= NEAR_DUP_HAMMING);
      if (near) {
        it.duplicateOf = near.item.id;
        marks.push({ item: it.id, duplicateOf: near.item.id, kind: 'near', cross: near.item.datasetId !== it.datasetId });
        continue;
      }
      kept.push({ item: it, parts });
    }
  }
  return marks;
}

type IngestOptions = { dryRun?: boolean; sink?: EvalSink | null; log?: (s: string) => void };

/** Build one item's mask from file / polygons / decoded masks, on the analysis grid. */
function regionMasks(
  raw: RawItem,
  manifest: Manifest,
  grid: { width: number; height: number },
  prep: { orientation: number; rawSize: { width: number; height: number }; orientedSize: { width: number; height: number } },
  unmapped: Unmapped,
  stats: { orientedToMatch: number; sizeMismatch: number; snapped: number[] },
): { wound: Uint8Array | null; tissue: Partial<Record<TissueClass, Uint8Array>> } {
  const threshold = Number(manifest.options.mask_threshold ?? 127);
  const upright = (m: MaskPixels): MaskPixels => {
    // A mask the size of the RAW (pre-EXIF) frame is rotated with its image.
    if (prep.orientation !== 1 && m.width === prep.rawSize.width && m.height === prep.rawSize.height) {
      stats.orientedToMatch += 1;
      const o = applyOrientation(m, prep.orientation, 1);
      return maskPixelsFrom(o.data, o.width, o.height);
    }
    const a = m.width / m.height;
    const b = prep.orientedSize.width / prep.orientedSize.height;
    if (Math.abs(a - b) > 0.02) stats.sizeMismatch += 1;
    return m;
  };
  const onGrid = (m: MaskPixels) => toGrid(upright(m), grid.width, grid.height);
  const union = (a: Uint8Array | null, b: Uint8Array) => {
    if (!a) return Uint8Array.from(b);
    for (let i = 0; i < a.length; i += 1) if (b[i]) a[i] = 255;
    return a;
  };

  let wound: Uint8Array | null = null;
  const tissue: Partial<Record<TissueClass, Uint8Array>> = {};

  if (raw.maskPath) wound = onGrid(decodeBinaryMask(readFileSync(raw.maskPath), threshold));
  if (raw.tissueMaskPath && Object.keys(manifest.tissueMaskMap).length) {
    const decoded = decodePaletteMask(readFileSync(raw.tissueMaskPath), manifest.tissueMaskMap);
    stats.snapped.push(decoded.snappedRate);
    for (const [cls, data] of Object.entries(decoded.classes)) {
      tissue[cls as TissueClass] = union(tissue[cls as TissueClass] ?? null, onGrid(maskPixelsFrom(data, decoded.width, decoded.height)));
    }
  }
  const frame = raw.polygonFrame ?? prep.orientedSize;
  for (const poly of raw.polygons ?? []) {
    const target = resolveRegionLabel(poly.label, manifest.labelMap, unmapped);
    if (!target || target === 'ignore') continue;
    const pts = poly.points.map(([x, y]) => ({ x: x / frame.width, y: y / frame.height }));
    const m = rasterisePolygon(pts, grid.width, grid.height);
    if (target === 'wound') wound = union(wound, m);
    else tissue[target] = union(tissue[target] ?? null, m);
  }
  for (const lm of raw.labelMasks ?? []) {
    const target = resolveRegionLabel(lm.label, manifest.labelMap, unmapped);
    if (!target || target === 'ignore') continue;
    const m = onGrid(lm.mask);
    if (target === 'wound') wound = union(wound, m);
    else tissue[target] = union(tissue[target] ?? null, m);
  }
  return { wound, tissue };
}

/** Tissue % inside the wound: the wound mask if there is one, else the union of the wound-bed classes. */
export function tissuePctFrom(
  wound: Uint8Array | null,
  tissue: Partial<Record<TissueClass, Uint8Array>>,
): Record<TissueClass, number> | null {
  const classes = Object.keys(tissue) as TissueClass[];
  if (!classes.length) return null;
  const n = tissue[classes[0]]!.length;
  const counts: Record<TissueClass, number> = { granulation: 0, slough: 0, necrotic: 0, epithelial: 0, other: 0 };
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const inWound = wound ? wound[i] !== 0 : classes.some((c) => tissue[c]![i] !== 0);
    if (!inWound) continue;
    total += 1;
    // First class wins on overlap, in canonical order; unlabelled wound pixels count as `other`.
    const cls = TISSUE_CLASSES.find((c) => tissue[c]?.[i]) ?? 'other';
    counts[cls] += 1;
  }
  if (total === 0) return null;
  return Object.fromEntries(TISSUE_CLASSES.map((c) => [c, Number(((100 * counts[c]) / total).toFixed(3))])) as Record<TissueClass, number>;
}

export async function ingestDataset(manifest: Manifest, opts: IngestOptions = {}): Promise<{ items: EvalItem[]; coverage: Coverage }> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const root = join(dataDir(), manifest.root);
  if (!existsSync(root)) throw new Error(`Dataset root ${root} does not exist. Download the data there first.`);
  const cacheDir = datasetCacheDir(manifest.id);
  if (!opts.dryRun) {
    for (const d of ['images', 'masks', 'tissue']) mkdirSync(join(cacheDir, d), { recursive: true });
  }

  const unmapped: Unmapped = {};
  const failures: Coverage['failures'] = [];
  const stats = { orientedToMatch: 0, sizeMismatch: 0, snapped: [] as number[] };
  const items: EvalItem[] = [];
  let total = 0;
  let reencoded = 0;
  let exifRotated = 0;
  const seenKeys = new Set<string>();

  for await (const raw of getAdapter(manifest).enumerate(manifest, root)) {
    const rel = relative(root, raw.imagePath).split('\\').join('/');
    if (isExcluded(rel, manifest.exclude)) continue;
    total += 1;
    try {
      if (seenKeys.has(raw.key)) throw new Error(`duplicate key ${raw.key}`);
      seenKeys.add(raw.key);
      if (!existsSync(raw.imagePath)) throw new Error('image file not found');
      const bytes = readFileSync(raw.imagePath);
      const sha = imageSha256(bytes.toString('base64'));
      const prep = prepareImage(bytes);
      if (prep.reencoded) reencoded += 1;
      if (prep.orientation !== 1) exifRotated += 1;
      const grid = { width: prep.normalised.width, height: prep.normalised.height };
      const sk = safeKey(raw.key);

      // Ground truth
      const gtFields: Record<string, unknown> = structuredClone(manifest.defaults);
      const labels: Record<string, unknown> = { ...raw.labels, ...(raw.split ? { split: raw.split } : {}) };
      for (const [field, column] of Object.entries(manifest.fieldMap)) {
        const mapped = mapField(field, getPath(labels, column), manifest.labelMap, unmapped);
        for (const [k, v] of Object.entries(mapped)) setDeep(gtFields, k, v);
      }
      // classFolders: the folder label goes through the same mapping.
      const labelField = manifest.adapter === 'classFolders' ? String(manifest.options.label_field ?? 'woundType') : null;
      if (labelField && labels[labelField] !== undefined && !manifest.fieldMap[labelField]) {
        Object.assign(gtFields, mapField(labelField, labels[labelField], manifest.labelMap, unmapped));
      }

      const { wound, tissue } = regionMasks(raw, manifest, grid, prep, unmapped, stats);
      const tissueClasses = Object.keys(tissue) as TissueClass[];
      // Tissue-only datasets: the wound bed is the union of the wound-bed classes (`wound_from_tissue`,
      // default all), and tissue % is measured inside THAT — callus around an ulcer is not wound bed.
      let woundMask = wound ?? null;
      if (!woundMask && tissueClasses.length) {
        const bed = (manifest.options.wound_from_tissue as TissueClass[] | undefined) ?? tissueClasses;
        const derived = new Uint8Array(grid.width * grid.height);
        for (const cls of bed) for (let i = 0; i < derived.length; i += 1) if (tissue[cls]?.[i]) derived[i] = 255;
        if (derived.some((v) => v)) {
          woundMask = derived;
          gtFields.provenance = { ...((gtFields.provenance as Record<string, string>) ?? {}), woundMaskPath: 'derived' };
        }
      }
      if (woundMask && !opts.dryRun) writeMaskPng(join(cacheDir, 'masks', `${sk}.png`), woundMask, grid.width, grid.height);
      if (woundMask) gtFields.woundMaskPath = `masks/${sk}.png`;
      if (tissueClasses.length) {
        const paths: Record<string, string> = {};
        for (const cls of tissueClasses) {
          paths[cls] = `tissue/${sk}__${cls}.png`;
          if (!opts.dryRun) writeMaskPng(join(cacheDir, paths[cls]), tissue[cls]!, grid.width, grid.height);
        }
        gtFields.tissueMaskPaths = paths;
        const pct = tissuePctFrom(woundMask, tissue);
        if (pct && !gtFields.tissuePct) gtFields.tissuePct = pct;
      }
      if (manifest.tissueClassesLabelled && !gtFields.tissueClassesLabelled) gtFields.tissueClassesLabelled = manifest.tissueClassesLabelled;
      // tissuePct.<class> columns (tabular) arrive as a partial object; complete it.
      if (gtFields.tissuePct) {
        gtFields.tissuePct = Object.fromEntries(TISSUE_CLASSES.map((c) => [c, Number((gtFields.tissuePct as Record<string, number>)[c] ?? 0)]));
      }
      if (!gtFields.dominantTissue && gtFields.tissuePct) {
        const dom = dominantFromPct(gtFields.tissuePct as Record<TissueClass, number>);
        if (dom) {
          gtFields.dominantTissue = dom;
          gtFields.provenance = { ...((gtFields.provenance as Record<string, string>) ?? {}), dominantTissue: 'derived' };
        }
      }
      gtFields.rawLabels = labels;

      const parsed = GroundTruth.safeParse(gtFields);
      if (!parsed.success) throw new Error(`ground truth invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

      if (!opts.dryRun) writeFileSync(join(cacheDir, 'images', `${sk}.jpg`), prep.normalised.bytes);
      const gt = parsed.data;
      const strata: Record<string, string> = { woundType: gt.woundType ?? 'unknown', ...(raw.split ? { split: raw.split } : {}) };
      for (const s of manifest.strata) {
        if (s === 'split') continue;
        const v = getPath(gt, s) ?? getPath(labels, s);
        strata[s] = v === undefined || v === null ? 'unknown' : String(v);
      }
      items.push({
        id: `${manifest.id}:${raw.key}`,
        datasetId: manifest.id,
        key: raw.key,
        split: raw.split ?? null,
        imageSha256: sha,
        dhash: dHash(prep.oriented),
        relPath: `${manifest.root}/${rel}`,
        normPath: `images/${sk}.jpg`,
        width: grid.width,
        height: grid.height,
        gt,
        strata,
        duplicateOf: null,
      });
    } catch (error) {
      failures.push({ key: raw.key, reason: error instanceof Error ? error.message : String(error) });
    }
    if (total % 100 === 0) log(`  ${manifest.id}: ${total} read, ${items.length} ok, ${failures.length} failed`);
  }

  // Duplicates: within this dataset, then against every other ingested dataset.
  const others = listManifests()
    .filter((id) => id !== manifest.id)
    .flatMap((id) => loadItems(id));
  const all = [...others.map((o) => ({ ...o })), ...items];
  const synthetic = new Set(
    [...new Set(all.map((i) => i.datasetId))].filter((id) => {
      try {
        return (id === manifest.id ? manifest : loadManifest(id)).image_source === 'synthetic';
      } catch {
        return false;
      }
    }),
  );
  const marks = markDuplicates(all, (id) => synthetic.has(id));
  const mine = new Set(items.map((i) => i.id));
  const byId = new Map(all.map((i) => [i.id, i]));
  const myMarks = marks.filter((m) => mine.has(m.item) || mine.has(m.duplicateOf));
  const examples = myMarks.slice(0, 25).map((m) => ({ item: m.item, duplicateOf: m.duplicateOf, kind: `${m.cross ? 'cross' : 'within'}-${m.kind}` }));

  const fieldCoverage: Record<string, number> = {};
  for (const f of COVERAGE_FIELDS) {
    fieldCoverage[f] = items.length ? items.filter((i) => (i.gt as Record<string, unknown>)[f] !== undefined).length / items.length : 0;
  }
  const unmappedTotal = Object.values(unmapped).reduce((a, v) => a + Object.values(v).reduce((x, y) => x + y, 0), 0);
  const coverage: Coverage = {
    dataset: manifest.id,
    generatedAt: new Date().toISOString(),
    items: total,
    ok: items.length,
    failures,
    fieldCoverage,
    unmapped,
    unmappedTotal,
    duplicates: {
      withinExact: myMarks.filter((m) => !m.cross && m.kind === 'exact' && mine.has(m.item)).length,
      withinNear: myMarks.filter((m) => !m.cross && m.kind === 'near' && mine.has(m.item)).length,
      crossExact: myMarks.filter((m) => m.cross && m.kind === 'exact').length,
      crossNear: myMarks.filter((m) => m.cross && m.kind === 'near').length,
      examples,
    },
    masks: {
      withMask: items.filter((i) => i.gt.woundMaskPath).length,
      orientedToMatch: stats.orientedToMatch,
      sizeMismatch: stats.sizeMismatch,
      paletteSnappedRate: stats.snapped.length ? stats.snapped.reduce((a, b) => a + b, 0) / stats.snapped.length : null,
    },
    reencoded,
    exifRotated,
  };

  const covDir = join(outDir(), 'ingest', manifest.id);
  mkdirSync(covDir, { recursive: true });
  writeFileSync(join(covDir, 'coverage.json'), JSON.stringify(coverage, null, 2));
  writeFileSync(join(covDir, 'coverage.md'), coverageMarkdown(coverage));

  if (!opts.dryRun) {
    // Persist this dataset's items, and any other dataset whose duplicate marks changed.
    mkdirSync(join(outDir(), 'items'), { recursive: true });
    const write = (id: string, list: EvalItem[]) => writeFileSync(itemsPath(id), list.map((i) => JSON.stringify(i)).join('\n') + (list.length ? '\n' : ''));
    write(manifest.id, items.map((i) => byId.get(i.id) ?? i));
    const changed = new Set<string>();
    for (const o of others) if ((byId.get(o.id)?.duplicateOf ?? null) !== o.duplicateOf) changed.add(o.datasetId);
    for (const id of changed) write(id, loadItems(id).map((i) => byId.get(i.id) ?? i));

    const sink = opts.sink;
    if (sink?.enabled) {
      await sink.upsertDataset({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version ?? null,
        sourceUrl: manifest.source_url,
        licence: manifest.licence,
        imageSource: manifest.image_source,
        knownTrainingUse: manifest.known_training_use,
        manifest,
      });
      // An exact within-dataset duplicate would violate unique(dataset_id, image_sha256): it is not written.
      const writable = items
        .map((i) => byId.get(i.id) ?? i)
        .filter((i) => !(i.duplicateOf && byId.get(i.duplicateOf)?.datasetId === i.datasetId && byId.get(i.duplicateOf)?.imageSha256 === i.imageSha256));
      await sink.upsertItems(writable);
      for (const id of changed) await sink.upsertItems(loadItems(id).filter((i) => !i.duplicateOf || byId.get(i.duplicateOf)?.imageSha256 !== i.imageSha256 || byId.get(i.duplicateOf)?.datasetId !== i.datasetId));
    }
  }
  return { items: items.map((i) => byId.get(i.id) ?? i), coverage };
}

export async function ingestCommand(args: Record<string, unknown>): Promise<number> {
  const which = typeof args.dataset === 'string' ? args.dataset : null;
  if (!which) {
    console.error('usage: npx tsx eval/cli.mts ingest --dataset=<id>|all [--dry-run]');
    return 2;
  }
  const ids = which === 'all' ? [...listManifests()].sort((a, b) => dedupeRank(a) - dedupeRank(b)) : which.split(',');
  const dryRun = Boolean(args['dry-run']);
  const sink = dryRun ? null : EvalSink.fromEnv();
  let worst = 0;
  for (const id of ids) {
    const manifest = loadManifest(id);
    console.log(`ingest ${id}${dryRun ? ' (dry run)' : ''} …`);
    const { coverage } = await ingestDataset(manifest, { dryRun, sink });
    console.log(
      `  ${coverage.ok}/${coverage.items} ok, ${coverage.failures.length} failed, ${coverage.unmappedTotal} unmapped value(s), ` +
        `dupes: ${coverage.duplicates.withinExact}+${coverage.duplicates.withinNear} within, ${coverage.duplicates.crossExact}+${coverage.duplicates.crossNear} cross`,
    );
    console.log(`  coverage → ${join(outDir(), 'ingest', id, 'coverage.md')}`);
    if (coverage.unmappedTotal > 0) worst = Math.max(worst, 1);
  }
  if (sink && sink.failures > 0) console.warn(`  ${sink.failures} database write(s) failed; the JSONL mirror is complete.`);
  return worst;
}
