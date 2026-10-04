/**
 * `labelme` (spec §8.5): one LabelMe JSON per image. Its `shapes` become
 * polygons (rectangles → 4 corners, circles → 32-gons) and are rasterised the
 * same way as COCO's. `flags` and any extra top-level keys land in rawLabels.
 *
 *   options: annotations (folder of JSON files, default '.'), recursive?
 */
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { keyFor, listFiles, opt, type Adapter, type Polygon } from './common';

type Shape = { label: string; points: [number, number][]; shape_type?: string };
type LabelMeFile = { shapes?: Shape[]; imagePath?: string; imageWidth?: number; imageHeight?: number; flags?: Record<string, unknown>; [k: string]: unknown };

export function shapeToPolygon(shape: Shape): Polygon | null {
  const type = shape.shape_type ?? 'polygon';
  const pts = shape.points ?? [];
  if (type === 'polygon' && pts.length >= 3) return { label: shape.label, points: pts };
  if (type === 'rectangle' && pts.length === 2) {
    const [[x0, y0], [x1, y1]] = pts;
    return { label: shape.label, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
  }
  if (type === 'circle' && pts.length === 2) {
    const [[cx, cy], [ex, ey]] = pts;
    const r = Math.hypot(ex - cx, ey - cy);
    return { label: shape.label, points: Array.from({ length: 32 }, (_, i) => [cx + r * Math.cos((i / 32) * 2 * Math.PI), cy + r * Math.sin((i / 32) * 2 * Math.PI)] as [number, number]) };
  }
  return null;
}

export const labelme: Adapter = {
  name: 'labelme',
  async *enumerate(manifest, root) {
    const dir = join(root, opt<string>(manifest, 'annotations', '.'));
    for (const jsonPath of listFiles(dir, opt<boolean>(manifest, 'recursive', false))) {
      if (extname(jsonPath).toLowerCase() !== '.json') continue;
      const file = JSON.parse(readFileSync(jsonPath, 'utf8')) as LabelMeFile;
      if (!Array.isArray(file.shapes) || typeof file.imagePath !== 'string') continue;
      const imagePath = join(dirname(jsonPath), file.imagePath);
      const polygons = file.shapes.map(shapeToPolygon).filter((p): p is Polygon => p !== null);
      const { shapes: _s, imageData: _d, imagePath: _p, imageWidth, imageHeight, ...rest } = file;
      yield {
        key: keyFor(root, imagePath),
        imagePath,
        polygons,
        polygonFrame: imageWidth && imageHeight ? { width: imageWidth, height: imageHeight } : undefined,
        labels: { ...rest, shape_labels: [...new Set(file.shapes.map((s) => s.label))] },
      };
    }
  },
};
