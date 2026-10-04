/**
 * The `synthetic-negatives` dataset (spec §23): 50 procedurally generated
 * non-wound skin images, written to EVAL_DATA_DIR/synthetic-negatives/images.
 * No external data. Deterministic: image i is seeded with 1000 + i.
 *
 *   npx tsx eval/cli.mts negatives [--count=50]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataDir } from './env';
import { encodeJpeg } from './io';
import { synthNegative } from './synth';

export function generateNegatives(args: Record<string, unknown> = {}): number {
  const count = Number(args.count ?? 50);
  const dir = join(dataDir(), 'synthetic-negatives', 'images');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    // Vary the frame like phone photos do: landscape and portrait, 640–1280 px.
    const landscape = i % 3 !== 0;
    const long = 640 + ((i * 97) % 641);
    const short = Math.round(long * 0.75);
    const img = synthNegative(1000 + i, landscape ? long : short, landscape ? short : long);
    writeFileSync(join(dir, `neg_${String(i).padStart(3, '0')}.jpg`), encodeJpeg({ data: img.rgba, width: img.width, height: img.height }, 90));
  }
  console.log(`synthetic-negatives: ${count} image(s) → ${dir}`);
  return 0;
}
