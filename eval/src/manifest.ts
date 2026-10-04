/**
 * Dataset manifests: `eval/datasets/<id>/dataset.yaml` (spec §6), validated
 * with Zod. A manifest is the only thing a new dataset needs, unless YAML truly
 * cannot express its format (then `adapter: custom`, §8.7).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { EVAL_ROOT } from './env';
import { TISSUE_CLASSES } from './vocab';

export const ADAPTERS = ['folderMasks', 'classFolders', 'tabular', 'coco', 'labelme', 'custom'] as const;
export const IMAGE_SOURCES = ['public_dataset', 'synthetic', 'consented_demo'] as const;

export const Manifest = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case id: letters, digits, dashes'),
    name: z.string(),
    version: z.union([z.string(), z.number()]).transform(String).optional(),
    source_url: z.string(),
    // Spec §2.7: direct download only. `generated` is for datasets the harness makes itself.
    access: z.enum(['direct_download', 'generated']),
    licence: z.string().min(1),
    image_source: z.enum(IMAGE_SOURCES),
    known_training_use: z.array(z.string()).default([]),
    root: z.string(),
    adapter: z.enum(ADAPTERS),
    splits: z.record(z.string(), z.string()).optional(),
    options: z.record(z.string(), z.unknown()).default({}),
    defaults: z.record(z.string(), z.unknown()).default({}),
    labelMap: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    fieldMap: z.record(z.string(), z.string()).default({}),
    tissueMaskMap: z.record(z.string(), z.string()).default({}),
    tissueClassesLabelled: z.array(z.enum(TISSUE_CLASSES)).optional(),
    externalProcessingConsent: z.boolean().optional(),
    exclude: z.array(z.string()).default([]),
    strata: z.array(z.string()).default([]),
    sample_weight: z.number().positive().default(1),
    notes: z.string().optional(),
  })
  .superRefine((m, ctx) => {
    // fal.ai, Modal and the gateway process data outside Australia (spec §6, §25).
    if (m.image_source === 'consented_demo' && m.externalProcessingConsent !== true) {
      ctx.addIssue({ code: 'custom', message: 'non-public datasets need externalProcessingConsent: true', path: ['externalProcessingConsent'] });
    }
    for (const cls of Object.values(m.tissueMaskMap)) {
      if (!(TISSUE_CLASSES as readonly string[]).includes(cls) && !/^_?background$/i.test(cls)) {
        ctx.addIssue({ code: 'custom', message: `tissueMaskMap value "${cls}" is not a tissue class or "background"`, path: ['tissueMaskMap'] });
      }
    }
  });
export type Manifest = z.infer<typeof Manifest>;

export function datasetsDir(): string {
  return process.env.EVAL_DATASETS_DIR || join(EVAL_ROOT, 'datasets');
}

export function manifestPath(id: string, dir = datasetsDir()): string {
  return join(dir, id, 'dataset.yaml');
}

export function parseManifest(text: string, source = 'dataset.yaml'): Manifest {
  const raw = parseYaml(text) as unknown;
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid manifest ${source}:\n${issues}`);
  }
  return parsed.data;
}

export function loadManifest(id: string, dir = datasetsDir()): Manifest {
  const path = manifestPath(id, dir);
  if (!existsSync(path)) throw new Error(`No manifest at ${path}. Onboard the dataset first (.cursor/rules/eval-dataset-onboarding.mdc).`);
  const m = parseManifest(readFileSync(path, 'utf8'), path);
  if (m.id !== id) throw new Error(`Manifest ${path} declares id "${m.id}", expected "${id}".`);
  return m;
}

/** Every onboarded dataset (directories with a dataset.yaml). */
export function listManifests(dir = datasetsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'dataset.yaml')))
    .map((d) => d.name)
    .sort();
}

/** Dedupe precedence across datasets (spec §9): the first occurrence wins. */
export const DEDUPE_ORDER = ['fuseg2021', 'dfutissue', 'azh-woundclass', 'medetec', 'woundcarevqa'];

export function dedupeRank(id: string): number {
  const i = DEDUPE_ORDER.indexOf(id);
  return i === -1 ? DEDUPE_ORDER.length : i;
}

/** Glob → RegExp (`**`, `*`, `?`), matched against '/'-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function isExcluded(relPath: string, exclude: readonly string[]): boolean {
  return exclude.some((g) => globToRegExp(g).test(relPath));
}
