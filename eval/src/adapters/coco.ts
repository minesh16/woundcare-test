/**
 * `coco` (spec §8.4): a COCO instances file. Polygons stay polygons (the ingest
 * step rasterises them with the app's `rasterisePolygon`); RLE segmentations —
 * compressed or not — are decoded here. Category names are the polygon labels;
 * `labelMap.category` maps them to `wound` / a tissue class / `ignore`.
 *
 *   options: annotations (path to the JSON), images (folder, default '.')
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { maskPixelsFrom, type MaskPixels } from '../io';
import { keyFor, opt, type Adapter, type Polygon } from './common';

type CocoImage = { id: number; file_name: string; width: number; height: number; [k: string]: unknown };
type CocoAnn = { image_id: number; category_id: number; segmentation: unknown; iscrowd?: number };
type CocoFile = { images: CocoImage[]; annotations: CocoAnn[]; categories: { id: number; name: string }[] };

/** pycocotools' compressed RLE string → run lengths. */
export function rleCountsFromString(s: string): number[] {
  const counts: number[] = [];
  let p = 0;
  while (p < s.length) {
    let x = 0;
    let k = 0;
    let more = 1;
    while (more) {
      const c = s.charCodeAt(p) - 48;
      x |= (c & 0x1f) << (5 * k);
      more = c & 0x20;
      p += 1;
      k += 1;
      if (!more && c & 0x10) x |= -1 << (5 * k);
    }
    if (counts.length > 2) x += counts[counts.length - 2];
    counts.push(x);
  }
  return counts;
}

/** Column-major COCO RLE → a row-major 0/255 mask. */
export function decodeRle(rle: { counts: number[] | string; size: [number, number] }): MaskPixels {
  const [h, w] = rle.size;
  const counts = typeof rle.counts === 'string' ? rleCountsFromString(rle.counts) : rle.counts;
  const data = new Uint8Array(w * h);
  let idx = 0;
  let on = false;
  for (const run of counts) {
    if (on) {
      for (let i = idx; i < idx + run && i < w * h; i += 1) {
        const x = Math.floor(i / h);
        const y = i % h;
        data[y * w + x] = 255;
      }
    }
    idx += run;
    on = !on;
  }
  return maskPixelsFrom(data, w, h);
}

export const coco: Adapter = {
  name: 'coco',
  async *enumerate(manifest, root) {
    const annPath = opt<string | null>(manifest, 'annotations', null);
    if (!annPath) throw new Error('coco: options.annotations is required');
    const imagesDir = join(root, opt<string>(manifest, 'images', '.'));
    const file = JSON.parse(readFileSync(join(root, annPath), 'utf8')) as CocoFile;
    const categories = new Map(file.categories.map((c) => [c.id, c.name]));
    const byImage = new Map<number, CocoAnn[]>();
    for (const a of file.annotations) byImage.set(a.image_id, [...(byImage.get(a.image_id) ?? []), a]);

    for (const image of file.images) {
      const imagePath = join(imagesDir, image.file_name);
      const polygons: Polygon[] = [];
      const labelMasks: { label: string; mask: MaskPixels }[] = [];
      const names = new Set<string>();
      for (const ann of byImage.get(image.id) ?? []) {
        const label = categories.get(ann.category_id) ?? String(ann.category_id);
        names.add(label);
        const seg = ann.segmentation;
        if (Array.isArray(seg)) {
          for (const poly of seg as number[][]) {
            const points: [number, number][] = [];
            for (let i = 0; i + 1 < poly.length; i += 2) points.push([poly[i], poly[i + 1]]);
            if (points.length >= 3) polygons.push({ label, points });
          }
        } else if (seg && typeof seg === 'object' && 'counts' in seg) {
          labelMasks.push({ label, mask: decodeRle(seg as { counts: number[] | string; size: [number, number] }) });
        }
      }
      const { id: _id, file_name, width, height, ...attrs } = image;
      yield {
        key: keyFor(root, imagePath),
        imagePath,
        polygons,
        polygonFrame: { width, height },
        labelMasks,
        labels: { file_name, categories: [...names], ...attrs },
      };
    }
  },
};
