/**
 * `custom` (spec §8.6–§8.7): loads `eval/datasets/<id>/adapter.ts`, which must
 * export an `Adapter` (as `adapter` or default). The escape hatch for formats
 * YAML cannot express — keep those files under 150 lines, with a top comment
 * saying why.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { datasetsDir } from '../manifest';
import type { Adapter } from './common';

export const custom: Adapter = {
  name: 'custom',
  async *enumerate(manifest, root) {
    const path = join(datasetsDir(), manifest.id, 'adapter.ts');
    if (!existsSync(path)) throw new Error(`custom adapter: ${path} not found`);
    const lines = readFileSync(path, 'utf8').split('\n').length;
    if (lines > 150) console.warn(`custom adapter ${path} is ${lines} lines — the spec asks for ≤150 (§8.7).`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(path) as { adapter?: Adapter; default?: Adapter };
    const adapter = mod.adapter ?? mod.default;
    if (!adapter || typeof adapter.enumerate !== 'function') throw new Error(`custom adapter ${path} must export an Adapter`);
    yield* adapter.enumerate(manifest, root);
  },
};
