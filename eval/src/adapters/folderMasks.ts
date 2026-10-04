/**
 * `folderMasks` (spec §8.1): images in one folder, binary masks in another with
 * the same stem (a `_mask` / `_gt`-style suffix is accepted). `{split}` in either
 * pattern walks the manifest's splits. Images with no mask still ingest — a
 * test split whose labels are withheld simply has no `woundMaskPath`.
 *
 *   options: images, masks?, tissue_masks?, recursive?, mask_threshold?
 */
import { join } from 'node:path';

import { fill, isImage, keyFor, listFiles, maskIndex, opt, splitsOf, stemOf, type Adapter, type RawItem } from './common';

export const folderMasks: Adapter = {
  name: 'folderMasks',
  async *enumerate(manifest, root) {
    const imagesPattern = opt<string>(manifest, 'images', 'images');
    const masksPattern = opt<string | null>(manifest, 'masks', null);
    const tissuePattern = opt<string | null>(manifest, 'tissue_masks', null);
    const recursive = opt<boolean>(manifest, 'recursive', false);
    for (const { split, folder } of splitsOf(manifest)) {
      const vars = { split: folder };
      const masks = masksPattern ? maskIndex(join(root, fill(masksPattern, vars)), recursive) : new Map<string, string>();
      const tissue = tissuePattern ? maskIndex(join(root, fill(tissuePattern, vars)), recursive) : new Map<string, string>();
      for (const imagePath of listFiles(join(root, fill(imagesPattern, vars)), recursive)) {
        if (!isImage(imagePath)) continue;
        const stem = stemOf(imagePath).toLowerCase();
        const item: RawItem = {
          key: keyFor(root, imagePath),
          imagePath,
          split,
          maskPath: masks.get(stem),
          tissueMaskPath: tissue.get(stem),
          labels: { ...(split ? { split } : {}) },
        };
        yield item;
      }
    }
  },
};
