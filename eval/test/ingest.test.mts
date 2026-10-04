/** §21.3–§21.4 — adapters produce the expected GroundTruth; ingest normalises, dedupes, reports unmapped labels. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { T } from './run.mts';

export default async function (t: T) {
  const { makeFixtures } = await import('./makeFixtures.mts');
  const info = makeFixtures(process.env.EVAL_DATA_DIR!, process.env.EVAL_DATASETS_DIR!);
  const { ingestDataset, loadItems } = await t.load<typeof import('../src/ingest')>('../src/ingest.ts');
  const { loadManifest, listManifests, parseManifest } = await t.load<typeof import('../src/manifest')>('../src/manifest.ts');
  const io = await t.load<typeof import('../src/io')>('../src/io.ts');
  const masks = await t.load<typeof import('../src/score/masks')>('../src/score/masks.ts');
  const { datasetCacheDir } = await t.load<typeof import('../src/env')>('../src/env.ts');
  const quiet = { log: () => {} };

  t.eq(listManifests(), [...info.ids].sort(), 'every fixture manifest is discovered');
  await t.throws(() => parseManifest('id: x\nname: x\nsource_url: u\naccess: needs_form\nlicence: l\nimage_source: public_dataset\nroot: x\nadapter: folderMasks\n'), 'manifest refuses a non-direct access', /access/);
  await t.throws(
    () => parseManifest('id: x\nname: x\nsource_url: u\naccess: direct_download\nlicence: l\nimage_source: consented_demo\nroot: x\nadapter: folderMasks\n'),
    'non-public data needs externalProcessingConsent',
    /externalProcessingConsent/,
  );

  // --- EXIF orientation helper
  const jpeg = io.encodeJpeg({ data: new Uint8Array(4 * 4 * 4).fill(128), width: 4, height: 4 }, 90);
  const { withExifOrientation } = await import('./makeFixtures.mts');
  t.eq(io.exifOrientation(withExifOrientation(jpeg, 6)), 6, 'EXIF orientation read back');
  t.eq(io.exifOrientation(jpeg), 1, 'no EXIF → 1');

  // --- folderMasks: splits, suffix matching, PNG → JPEG, EXIF rotation, an image with no mask.
  const folder = await ingestDataset(loadManifest('fx-folder'), quiet);
  t.eq(folder.coverage.ok, 4, 'folderMasks: 4 items');
  t.eq(folder.coverage.masks.withMask, 3, 'folderMasks: 3 with masks (one test image unlabelled)');
  const byKey = new Map(folder.items.map((i) => [i.key, i]));
  t.eq(byKey.get('train/images/a')?.split, 'train', 'split recorded');
  t.ok(byKey.get('train/images/b')?.gt.woundMaskPath, 'mask with _mask suffix matched');
  t.eq(byKey.get('validation/images/nolabel')?.gt.woundMaskPath, undefined, 'no mask → no woundMaskPath');
  t.eq(byKey.get('train/images/a')?.gt.woundType, 'diabetic_foot', 'defaults applied');
  t.eq(folder.coverage.reencoded, 3, 'PNG and EXIF-rotated images re-encoded');
  t.eq(folder.coverage.exifRotated, 1, 'one EXIF-rotated image');
  t.eq(folder.coverage.masks.orientedToMatch, 1, 'its mask rotated with it');

  // The rotated image's mask, on the normalise grid, must match the upright wound.
  const rot = byKey.get(info.folder.exifKey)!;
  t.eq([rot.width, rot.height], [160, 120], 'EXIF-rotated image is upright on the grid');
  const rotMask = io.readMaskPng(join(datasetCacheDir('fx-folder'), rot.gt.woundMaskPath!));
  const iou = masks.maskMetrics(rotMask.data, info.folder.upright.woundMask, 160, 120).iou;
  t.ok(iou > 0.97, 'rotated mask aligns with the upright wound', iou);
  // Grid: every cached mask is exactly the normalised image's size.
  for (const it of folder.items.filter((i) => i.gt.woundMaskPath)) {
    const mk = io.readMaskPng(join(datasetCacheDir('fx-folder'), it.gt.woundMaskPath!));
    const img = io.normaliseImage(readFileSync(join(datasetCacheDir('fx-folder'), it.normPath)).toString('base64'));
    t.eq([mk.width, mk.height], [img.width, img.height], `mask on the normalise grid (${it.key})`);
  }
  t.ok(existsSync(join(process.env.EVAL_OUT_DIR!, 'ingest/fx-folder/coverage.md')), 'coverage report written');

  // --- classFolders: label map, object mapping → woundPresent false, unmapped reported not coerced, _ignore honoured.
  const cls = await ingestDataset(loadManifest('fx-class'), quiet);
  const types = Object.fromEntries(cls.items.map((i) => [i.key, i.gt.woundType ?? null]));
  t.eq(types['Venous/venous_0'], 'venous', 'class folder → venous');
  t.eq(types['Diabetic/diabetic_0'], 'diabetic_foot', 'class folder → diabetic_foot');
  t.eq(cls.items.find((i) => i.key === 'Normal/normal_0')?.gt.woundPresent, false, 'Normal → woundPresent false');
  t.eq(types['Burnz/burnz_0'], null, 'unmapped class is NOT coerced');
  t.eq(cls.coverage.unmapped, { woundType: { Burnz: 1 } }, 'unmapped value counted; ignored one is not');
  t.eq(cls.items.find((i) => i.key === 'Burnz/burnz_0')?.gt.rawLabels.woundType, 'Burnz', 'raw value kept in rawLabels');
  // Cross-dataset duplicate: fx-class's dup_of_b has fx-folder's bytes. Neither fixture is in the
  // §9 precedence list, so ties break by dataset id: fx-class keeps it and fx-folder's copy — in an
  // ALREADY-INGESTED dataset — is re-marked and its JSONL rewritten.
  t.eq(cls.coverage.duplicates.crossExact, 1, 'cross-dataset exact duplicate found by sha256');
  t.eq(cls.items.find((i) => i.key === 'Diabetic/dup_of_b')?.duplicateOf, null, 'first occurrence (by precedence) is kept');
  t.eq(loadItems('fx-folder').find((i) => i.key === 'train/images/b')?.duplicateOf, 'fx-class:Diabetic/dup_of_b', 'the other copy is marked, in the earlier dataset');

  // --- tabular: fieldMap, numbers, booleans, tissue %, Monk tone, unmapped exudate.
  const tab = await ingestDataset(loadManifest('fx-table'), quiet);
  const t1 = tab.items.find((i) => i.key === 't1')!.gt;
  t.eq([t1.woundType, t1.bodyZone, t1.exudate, t1.infection, t1.ischaemia, t1.markerPresent, t1.areaCm2], ['venous', 'lower_leg_left', 'moderate', 'no', 'no', true, 4.5], 'tabular row mapped');
  t.eq(t1.tissuePct, { granulation: 70, slough: 30, necrotic: 0, epithelial: 0, other: 0 }, 'tissue % columns');
  t.eq(t1.dominantTissue, 'slough', 'dominant tissue derived by the ENGINE precedence (30% slough ≥ 10%)');
  t.eq(t1.skinTone, { scale: 'monk', value: 4 }, 'Monk tone');
  t.eq(t1.expectedPathwayId, 15, 'expected pathway');
  t.eq(tab.coverage.unmapped, { exudate: { loads: 1 } }, 'unmapped exudate counted');
  t.eq(tab.items.find((i) => i.key === 't3')!.gt.exudate, undefined, 'unmapped exudate left unset');

  // --- coco: polygon category "ulcer" → wound; RLE "fibrin" → slough.
  const co = await ingestDataset(loadManifest('fx-coco'), quiet);
  const o1 = co.items[0];
  t.ok(o1?.gt.woundMaskPath && o1.gt.tissueMaskPaths?.slough, 'coco: wound polygon + RLE slough mask', o1?.gt);
  const slough = io.readMaskPng(join(datasetCacheDir('fx-coco'), o1.gt.tissueMaskPaths!.slough!));
  t.eq(slough.areaPx, 400, 'coco: 20×20 RLE block decoded exactly');

  // --- labelme: wound polygon + granulation rectangle; an ignored label is not unmapped.
  const lm = await ingestDataset(loadManifest('fx-labelme'), quiet);
  const l1 = lm.items[0];
  const lw = io.readMaskPng(join(datasetCacheDir('fx-labelme'), l1.gt.woundMaskPath!));
  t.near(lw.areaPx, 80 * 60, 200, 'labelme: wound rectangle-polygon area');
  t.near(l1.gt.tissuePct?.granulation ?? -1, 50, 2, 'labelme: granulation = half the wound');
  t.eq(lm.coverage.unmappedTotal, 0, 'labelme: ignored label not counted');
  t.eq(l1.gt.rawLabels.flags, { reviewed: true }, 'labelme flags kept');

  // --- palette tissue masks: classes, snapping, only labelled classes, wound derived from tissue.
  const pal = await ingestDataset(loadManifest('fx-palette'), quiet);
  const p0 = pal.items[0].gt;
  t.eq(p0.tissueClassesLabelled, ['granulation', 'slough', 'other'], 'tissueClassesLabelled carried');
  t.ok(p0.woundMaskPath, 'wound mask derived from the tissue classes');
  t.near(p0.tissuePct?.granulation ?? -1, 50, 3, 'palette granulation ≈ 50%');
  t.ok((pal.coverage.masks.paletteSnappedRate ?? 0) > 0, 'stray palette values snapped and reported', pal.coverage.masks);

  // --- negatives
  const neg = await ingestDataset(loadManifest('fx-neg'), quiet);
  t.ok(neg.items.every((i) => i.gt.woundPresent === false && !i.gt.woundMaskPath), 'negatives: woundPresent false, no mask');

  // --- JSONL mirror round-trips, dry run writes nothing new.
  t.eq(loadItems('fx-folder').length, 4, 'items JSONL written');
  const dry = await ingestDataset(loadManifest('fx-neg'), { ...quiet, dryRun: true });
  t.eq(dry.coverage.ok, 3, 'dry run still reports coverage');
}
