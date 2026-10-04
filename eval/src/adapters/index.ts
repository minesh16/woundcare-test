/** Adapter registry: manifest `adapter:` name → implementation (spec §8). */
import type { Manifest } from '../manifest';
import { classFolders } from './classFolders';
import { coco } from './coco';
import type { Adapter } from './common';
import { custom } from './custom';
import { folderMasks } from './folderMasks';
import { labelme } from './labelme';
import { tabular } from './tabular';

export type { Adapter, RawItem, Polygon } from './common';

export const ADAPTER_REGISTRY: Record<Manifest['adapter'], Adapter> = {
  folderMasks,
  classFolders,
  tabular,
  coco,
  labelme,
  custom,
};

export function getAdapter(manifest: Manifest): Adapter {
  return ADAPTER_REGISTRY[manifest.adapter];
}
