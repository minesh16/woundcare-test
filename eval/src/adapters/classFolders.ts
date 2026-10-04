/**
 * `classFolders` (spec §8.2): the label is the image's class folder. Map folder
 * names to canonical values with `labelMap.<label_field>`.
 *
 *   options: images (may contain {split}), label_field (default woundType),
 *            ignore_folders?, recursive (default true, within a class folder)
 */
import { join } from 'node:path';

import { fill, isImage, keyFor, listDirs, listFiles, opt, splitsOf, type Adapter } from './common';

export const classFolders: Adapter = {
  name: 'classFolders',
  async *enumerate(manifest, root) {
    const imagesPattern = opt<string>(manifest, 'images', '.');
    const field = opt<string>(manifest, 'label_field', 'woundType');
    const ignore = new Set(opt<string[]>(manifest, 'ignore_folders', []).map((s) => s.toLowerCase()));
    const recursive = opt<boolean>(manifest, 'recursive', true);
    for (const { split, folder } of splitsOf(manifest)) {
      const dir = join(root, fill(imagesPattern, { split: folder }));
      for (const cls of listDirs(dir)) {
        if (ignore.has(cls.toLowerCase())) continue;
        for (const imagePath of listFiles(join(dir, cls), recursive)) {
          if (!isImage(imagePath)) continue;
          yield { key: keyFor(root, imagePath), imagePath, split, labels: { [field]: cls, class_folder: cls, ...(split ? { split } : {}) } };
        }
      }
    }
  },
};
