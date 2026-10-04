/**
 * `tabular` (spec §8.3): one row per image (or several images per row) in a
 * CSV / TSV / JSONL / JSON table. Columns reach canonical fields through the
 * manifest's `fieldMap`; every column is kept in `rawLabels`.
 *
 *   options: table, key_column, image_pattern ("images/{key}.jpg", any {column})
 *            | image_column | image_columns[], mask_pattern?, split_column?
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { fill, opt, readTable, type Adapter } from './common';

export const tabular: Adapter = {
  name: 'tabular',
  async *enumerate(manifest, root) {
    const table = opt<string | null>(manifest, 'table', null);
    if (!table) throw new Error('tabular: options.table is required');
    const keyColumn = opt<string | null>(manifest, 'key_column', null);
    const imagePattern = opt<string | null>(manifest, 'image_pattern', null);
    const imageColumn = opt<string | null>(manifest, 'image_column', null);
    const imageColumns = opt<string[]>(manifest, 'image_columns', []);
    const maskPattern = opt<string | null>(manifest, 'mask_pattern', null);
    const splitColumn = opt<string | null>(manifest, 'split_column', null);

    const rows = readTable(join(root, table));
    for (const [i, row] of rows.entries()) {
      const vars = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? undefined : String(v)]));
      const key = keyColumn ? String(row[keyColumn] ?? '') : String(i);
      const images: { key: string; rel: string }[] = [];
      if (imageColumns.length) {
        for (const col of imageColumns) {
          const rel = row[col];
          if (typeof rel === 'string' && rel.trim()) images.push({ key: `${key}/${col}`, rel: rel.trim() });
        }
      } else if (imageColumn) {
        const rel = row[imageColumn];
        if (typeof rel === 'string' && rel.trim()) images.push({ key, rel: rel.trim() });
      } else if (imagePattern) {
        images.push({ key, rel: fill(imagePattern, { ...vars, key }) });
      } else {
        throw new Error('tabular: set options.image_pattern, image_column or image_columns');
      }
      for (const img of images) {
        const imagePath = join(root, img.rel);
        const maskRel = maskPattern ? fill(maskPattern, { ...vars, key: img.key }) : null;
        const maskPath = maskRel && existsSync(join(root, maskRel)) ? join(root, maskRel) : undefined;
        yield {
          key: img.key.replace(/\.[a-z0-9]+$/i, ''),
          imagePath,
          split: splitColumn ? String(row[splitColumn] ?? '') || undefined : undefined,
          maskPath,
          labels: row,
        };
      }
    }
  },
};
