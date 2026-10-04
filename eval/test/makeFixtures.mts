/**
 * Tiny synthetic datasets for the harness's own tests (spec §21): one per
 * adapter, a palette tissue-mask set, negatives, an EXIF-rotated JPEG and a
 * cross-dataset duplicate. Pure procedural images — no external data.
 *
 *   npx tsx eval/test/makeFixtures.mts [dataRoot] [manifestsDir]
 *     defaults: eval/fixtures/data and eval/fixtures/datasets (both gitignored)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const load = async <T,>(path: string): Promise<T> => {
  const mod = (await import(path)) as Record<string, unknown>;
  const named = Object.keys(mod).filter((k) => k !== 'default');
  return (named.length === 0 && mod.default && typeof mod.default === 'object' ? mod.default : mod) as T;
};
const { synthImage, synthNegative } = await load<typeof import('../src/synth')>('../src/synth.ts');
const io = await load<typeof import('../src/io')>('../src/io.ts');
const { PNG } = (await import('pngjs')) as typeof import('pngjs');

type Synth = ReturnType<typeof synthImage>;

const W = 160;
const H = 120;

function png(rgba: Uint8Array, w: number, h: number): Buffer {
  const p = new PNG({ width: w, height: h });
  p.data = Buffer.from(rgba);
  return PNG.sync.write(p);
}

function maskPng(mask: Uint8Array, w: number, h: number, on = 255): Buffer {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const v = mask[i] ? on : 0;
    rgba.set([v, v, v, 255], i * 4);
  }
  return png(rgba, w, h);
}

/** Insert an EXIF APP1 segment carrying only an Orientation tag after SOI. */
export function withExifOrientation(jpegBytes: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = payload.length + 2;
  const app1 = [0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload];
  return Uint8Array.from([...jpegBytes.subarray(0, 2), ...app1, ...jpegBytes.subarray(2)]);
}

const wound = (seed: number, g: number, s: number, n: number) =>
  synthImage({ width: W, height: H, seed, wound: { cx: 0.5 + ((seed % 5) - 2) * 0.04, cy: 0.5, rx: 0.22, ry: 0.18, granulation: g, slough: s, necrotic: n } });

function put(path: string, bytes: Uint8Array | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function manifest(dir: string, id: string, body: string) {
  put(join(dir, id, 'dataset.yaml'), Buffer.from(`id: ${id}\nname: ${id} fixture\nsource_url: synthetic\naccess: generated\nlicence: synthetic test fixture\nimage_source: synthetic\nroot: ${id}\n${body}`));
}

export type FixtureInfo = {
  folder: { upright: Synth; exifKey: string };
  ids: string[];
};

export function makeFixtures(dataRoot: string, manifestsDir: string): FixtureInfo {
  // 1. folderMasks — splits, a PNG, a _mask suffix, an image with no mask, an EXIF-rotated JPEG.
  const fRoot = join(dataRoot, 'fx-folder');
  const a = wound(1, 0.7, 0.3, 0);
  put(join(fRoot, 'train/images/a.png'), png(a.rgba, W, H));
  put(join(fRoot, 'train/labels/a.png'), maskPng(a.woundMask, W, H));
  const b = wound(2, 0.5, 0.3, 0.2);
  put(join(fRoot, 'train/images/b.jpg'), io.encodeJpeg({ data: b.rgba, width: W, height: H }, 92));
  put(join(fRoot, 'train/labels/b_mask.png'), maskPng(b.woundMask, W, H));
  const upright = wound(3, 0.8, 0.2, 0);
  const raw = io.applyOrientation({ data: upright.rgba, width: W, height: H }, 8, 4); // stored rotated, as a camera would
  put(join(fRoot, 'validation/images/rot.jpg'), withExifOrientation(io.encodeJpeg({ data: raw.data, width: raw.width, height: raw.height }, 95), 6));
  const rawMask = io.applyOrientation({ data: upright.woundMask, width: W, height: H }, 8, 1);
  put(join(fRoot, 'validation/labels/rot.png'), maskPng(rawMask.data, raw.width, raw.height));
  const c = wound(4, 0.6, 0.4, 0);
  put(join(fRoot, 'validation/images/nolabel.png'), png(c.rgba, W, H));
  manifest(
    manifestsDir,
    'fx-folder',
    `adapter: folderMasks\nsplits: { train: train, validation: validation }\noptions: { images: "{split}/images", masks: "{split}/labels", mask_threshold: 127 }\ndefaults: { woundPresent: true, woundType: diabetic_foot, bodyZone: foot_left }\nstrata: [split]\n`,
  );

  // 2. classFolders — mapped classes, a negative class, one unmapped folder, one ignored.
  const cRoot = join(dataRoot, 'fx-class');
  const classes: [string, number][] = [['Venous', 3], ['Diabetic', 3], ['Pressure', 2], ['Normal', 2], ['Burnz', 1], ['Mystery', 1]];
  let seed = 100;
  for (const [cls, n] of classes) {
    for (let i = 0; i < n; i += 1) {
      const img = cls === 'Normal' ? synthNegative((seed += 1), W, H) : wound((seed += 1), 0.6, 0.3, 0.1);
      put(join(cRoot, cls, `${cls.toLowerCase()}_${i}.jpg`), io.encodeJpeg({ data: img.rgba, width: W, height: H }, 90));
    }
  }
  // A cross-dataset duplicate: the same bytes as fx-folder's b.jpg.
  put(join(cRoot, 'Diabetic', 'dup_of_b.jpg'), io.encodeJpeg({ data: b.rgba, width: W, height: H }, 92));
  manifest(
    manifestsDir,
    'fx-class',
    `adapter: classFolders\noptions: { images: ".", label_field: woundType }\nlabelMap:\n  woundType:\n    Venous: venous\n    Diabetic: diabetic_foot\n    Pressure: pressure\n    Normal: { woundPresent: false }\n  _ignore:\n    woundType: { Mystery: "unlabelled folder in the source" }\ndefaults: { woundPresent: true }\n`,
  );

  // 3. tabular — the §25 labelling template.
  const tRoot = join(dataRoot, 'fx-table');
  const rows = [
    ['image_file', 'wound_type', 'body_zone', 'exudate', 'infection', 'ischaemia', 'marker_present', 'area_cm2', 'granulation_pct', 'slough_pct', 'necrotic_pct', 'epithelial_pct', 'monk_tone', 'expected_pathway_id'],
    ['t1.jpg', 'Venous', 'lower_leg_left', 'moderate', 'no', 'no', 'yes', '4.5', '70', '30', '0', '0', '4', '15'],
    ['t2.jpg', 'pressure', 'sacrum', 'high', 'yes', 'no', 'no', '', '20', '60', '20', '0', '8', ''],
    ['t3.jpg', 'Venous', 'lower_leg_right', 'loads', 'no', '', 'yes', '2', '90', '10', '0', '0', '', ''],
  ];
  rows.slice(1).forEach((r, i) => {
    const img = wound(200 + i, 0.7, 0.3, 0);
    put(join(tRoot, 'images', r[0]), io.encodeJpeg({ data: img.rgba, width: W, height: H }, 90));
  });
  put(join(tRoot, 'labels.csv'), Buffer.from(rows.map((r) => r.join(',')).join('\n')));
  manifest(
    manifestsDir,
    'fx-table',
    `adapter: tabular\noptions: { table: labels.csv, key_column: image_file, image_pattern: "images/{key}" }\nfieldMap:\n  woundType: wound_type\n  bodyZone: body_zone\n  exudate: exudate\n  infection: infection\n  ischaemia: ischaemia\n  markerPresent: marker_present\n  areaCm2: area_cm2\n  tissuePct.granulation: granulation_pct\n  tissuePct.slough: slough_pct\n  tissuePct.necrotic: necrotic_pct\n  tissuePct.epithelial: epithelial_pct\n  skinTone.monk: monk_tone\n  expectedPathwayId: expected_pathway_id\nlabelMap:\n  woundType: { Venous: venous }\ndefaults: { woundPresent: true }\n`,
  );

  // 4. coco — a wound polygon and an RLE slough region.
  const oRoot = join(dataRoot, 'fx-coco');
  const o1 = wound(300, 0.6, 0.4, 0);
  put(join(oRoot, 'images', 'o1.jpg'), io.encodeJpeg({ data: o1.rgba, width: W, height: H }, 90));
  const poly = Array.from({ length: 24 }, (_, i) => {
    const t = (i / 24) * 2 * Math.PI;
    return [0.5 * W + 0.22 * W * Math.cos(t), 0.5 * H + 0.18 * H * Math.sin(t)];
  }).flat();
  // Uncompressed column-major RLE for a 20×20 block at (60,40).
  const rle: number[] = [];
  let last = 0;
  let on = false;
  for (let x = 0; x < W; x += 1) {
    for (let y = 0; y < H; y += 1) {
      const v = x >= 60 && x < 80 && y >= 40 && y < 60;
      if (v !== on) {
        rle.push(x * H + y - last);
        last = x * H + y;
        on = v;
      }
    }
  }
  rle.push(W * H - last);
  put(
    join(oRoot, 'annotations.json'),
    Buffer.from(
      JSON.stringify({
        images: [{ id: 1, file_name: 'o1.jpg', width: W, height: H }],
        annotations: [
          { image_id: 1, category_id: 1, segmentation: [poly] },
          { image_id: 1, category_id: 2, segmentation: { counts: rle, size: [H, W] } },
        ],
        categories: [{ id: 1, name: 'ulcer' }, { id: 2, name: 'fibrin' }],
      }),
    ),
  );
  manifest(manifestsDir, 'fx-coco', `adapter: coco\noptions: { annotations: annotations.json, images: images }\ndefaults: { woundPresent: true }\n`);

  // 5. labelme
  const lRoot = join(dataRoot, 'fx-labelme');
  const l1 = wound(400, 0.6, 0.4, 0);
  put(join(lRoot, 'l1.jpg'), io.encodeJpeg({ data: l1.rgba, width: W, height: H }, 90));
  put(
    join(lRoot, 'l1.json'),
    Buffer.from(
      JSON.stringify({
        imagePath: 'l1.jpg',
        imageWidth: W,
        imageHeight: H,
        flags: { reviewed: true },
        shapes: [
          { label: 'wound', shape_type: 'polygon', points: [[40, 30], [120, 30], [120, 90], [40, 90]] },
          { label: 'granulation', shape_type: 'rectangle', points: [[40, 30], [80, 90]] },
          { label: 'pen mark', shape_type: 'polygon', points: [[0, 0], [10, 0], [10, 10]] },
        ],
      }),
    ),
  );
  manifest(manifestsDir, 'fx-labelme', `adapter: labelme\noptions: { annotations: "." }\ndefaults: { woundPresent: true }\nlabelMap:\n  _ignore:\n    category: { "pen mark": "annotator's scribble" }\n`);

  // 6. palette tissue masks (DFUTissue-like: values 1/2/3, no epithelial, JPEG noise via stray values).
  const pRoot = join(dataRoot, 'fx-palette');
  for (let i = 0; i < 2; i += 1) {
    const img = wound(500 + i, 0.5, 0.3, 0.2);
    put(join(pRoot, 'images', `p${i}.png`), png(img.rgba, W, H));
    const rgba = new Uint8Array(W * H * 4);
    for (let k = 0; k < W * H; k += 1) {
      const v = img.tissue.granulation[k] ? 1 : img.tissue.slough[k] ? 2 : img.tissue.necrotic[k] ? 3 : 0;
      const noisy = k % 97 === 0 && v > 0 ? v + 1 : v; // stray values to snap
      rgba.set([noisy, noisy, noisy, 255], k * 4);
    }
    put(join(pRoot, 'labels', `p${i}.png`), png(rgba, W, H));
  }
  manifest(
    manifestsDir,
    'fx-palette',
    `adapter: folderMasks\noptions: { images: images, tissue_masks: labels }\ntissueMaskMap: { "0": background, "1": granulation, "2": slough, "3": other }\ntissueClassesLabelled: [granulation, slough, other]\ndefaults: { woundPresent: true, woundType: diabetic_foot }\n`,
  );

  // 7. negatives
  const nRoot = join(dataRoot, 'fx-neg');
  for (let i = 0; i < 3; i += 1) {
    const img = synthNegative(600 + i, W, H);
    put(join(nRoot, 'images', `n${i}.jpg`), io.encodeJpeg({ data: img.rgba, width: W, height: H }, 90));
  }
  manifest(manifestsDir, 'fx-neg', `adapter: folderMasks\noptions: { images: images }\ndefaults: { woundPresent: false }\n`);

  return { folder: { upright, exifKey: 'validation/images/rot' }, ids: ['fx-folder', 'fx-class', 'fx-table', 'fx-coco', 'fx-labelme', 'fx-palette', 'fx-neg'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataRoot = resolve(process.argv[2] ?? join(here, '../fixtures/data'));
  const manifestsDir = resolve(process.argv[3] ?? join(here, '../fixtures/datasets'));
  const info = makeFixtures(dataRoot, manifestsDir);
  console.log(`fixtures: ${info.ids.join(', ')} → ${dataRoot} (manifests in ${manifestsDir})`);
}
