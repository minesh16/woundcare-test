/**
 * Parity (spec §12): does the harness still decide exactly what the app's real
 * orchestrator decides, given the same image and mask?
 *
 * Stage A runs the app's `runAssessment` in a CHILD process with the database
 * and gateway environment removed and both segmentation providers blanked —
 * nothing can be persisted, nothing is paid for, and the result is
 * deterministic. Stage B runs the harness pipeline on the same image and mask
 * in this process and compares.
 *
 * A failure means the app's orchestration changed. Fix `engineInputs.ts`, never
 * the app.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EngineInputs, EngineResult } from '../../src/decision/engine.types';
import { REPO_ROOT } from './env';
import { encodeJpeg, normaliseImage, readMaskPng } from './io';
import { runPipeline } from './pipeline';
import type { EvalItem } from './schema';
import { synthImage, type SynthOptions } from './synth';

/** The five parity images: tissue mixes, a coin (so the px/cm path runs), a white patch. */
export const PARITY_IMAGES: { id: string; opts: SynthOptions }[] = [
  { id: 'granulating', opts: { seed: 11, wound: { cx: 0.5, cy: 0.5, rx: 0.22, ry: 0.16, granulation: 0.85, slough: 0.15, necrotic: 0 } } },
  { id: 'sloughy', opts: { seed: 12, wound: { cx: 0.45, cy: 0.55, rx: 0.2, ry: 0.18, granulation: 0.4, slough: 0.6, necrotic: 0 } } },
  { id: 'necrotic', opts: { seed: 13, wound: { cx: 0.55, cy: 0.45, rx: 0.18, ry: 0.14, granulation: 0.5, slough: 0.2, necrotic: 0.3 } } },
  {
    id: 'coin',
    opts: { seed: 14, width: 400, height: 300, wound: { cx: 0.62, cy: 0.5, rx: 0.16, ry: 0.13, granulation: 0.7, slough: 0.3, necrotic: 0 }, coin: { cx: 0.2, cy: 0.5, pxPerCm: 18 } },
  },
  {
    id: 'coin_patch',
    opts: {
      seed: 15,
      width: 400,
      height: 300,
      wound: { cx: 0.6, cy: 0.55, rx: 0.15, ry: 0.12, granulation: 0.6, slough: 0.3, necrotic: 0.1 },
      coin: { cx: 0.2, cy: 0.3, pxPerCm: 16 },
      whitePatch: { x: 0.08, y: 0.65, w: 0.22, h: 0.22 },
    },
  },
];

export type ParityChildInput = { images: { id: string; path: string }[]; outDir: string };
export type ParityChildOutput = {
  env: { supabase: boolean; gateway: boolean; fal: boolean; modal: boolean };
  cases: { id: string; maskPath: string; result: EngineResult; engineInputs: EngineInputs; pxPerCm: number | null }[];
};

const STRIP = [/^SUPABASE_/, /^AI_GATEWAY_/, /^VERCEL_OIDC_TOKEN$/, /^VERCEL$/];

/** The child's environment: no database, no gateway, no paid segmentation. */
export function childEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(parent)) if (!STRIP.some((re) => re.test(k))) env[k] = v;
  env.FAL_KEY = '';
  env.FUSEGNET_MODAL_URL = '';
  env.EVAL_PARITY_CHILD = '1';
  delete env.SEGMENTATION_PROVIDERS;
  delete env.TISSUE_RELATIVE;
  return env as NodeJS.ProcessEnv;
}

function pick(result: EngineResult) {
  return {
    status: result.status,
    axes: result.axes,
    cwcsPathwayId: result.cwcsPathwayId,
    referrals: result.referrals.map((r) => r.code),
    gateCodes: result.gateCodes,
    confidence: result.confidence,
  };
}

function pickInputs(inputs: EngineInputs) {
  return { tissue: inputs.tissue, periwound: inputs.periwound ?? null };
}

/** Deep-equality diff: a list of `path: a ≠ b` lines. */
export function diff(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return [`${path || '(root)'}: app=${JSON.stringify(a)} harness=${JSON.stringify(b)}`];
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}

export type ParityReport = {
  ok: boolean;
  cases: { id: string; diffs: string[]; pathway: number | null; status: string; pxPerCm?: number | null; periwound?: boolean; tissue?: string }[];
  childLog: string;
};

export async function runParity(opts: { verbose?: boolean } = {}): Promise<ParityReport> {
  const dir = mkdtempSync(join(tmpdir(), 'mendwise-parity-'));
  try {
    const images = PARITY_IMAGES.map(({ id, opts: o }) => {
      const s = synthImage(o);
      const path = join(dir, `${id}.jpg`);
      writeFileSync(path, encodeJpeg({ data: s.rgba, width: s.width, height: s.height }, 92));
      return { id, path };
    });
    const input: ParityChildInput = { images, outDir: dir };
    const inputPath = join(dir, 'input.json');
    const outputPath = join(dir, 'output.json');
    writeFileSync(inputPath, JSON.stringify(input));

    const env = childEnv();
    // Safety assertion (spec §12): the child must not be able to reach the database.
    if ('SUPABASE_URL' in env || 'SUPABASE_SERVICE_ROLE_KEY' in env) throw new Error('parity: refusing to spawn — SUPABASE_* present in the child env.');

    const child = spawnSync('npx', ['tsx', join(REPO_ROOT, 'eval/src/parity.child.mts'), inputPath, outputPath], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const childLog = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    if (child.status !== 0) throw new Error(`parity child exited ${child.status}:\n${childLog}`);
    const output = JSON.parse(readFileSync(outputPath, 'utf8')) as ParityChildOutput;
    if (output.env.supabase || output.env.gateway || output.env.fal || output.env.modal) {
      throw new Error(`parity child saw a live service: ${JSON.stringify(output.env)}`);
    }

    // Stage B — the harness on the same image, same mask, image_only.
    const cases: ParityReport['cases'] = [];
    for (const c of output.cases) {
      const bytes = readFileSync(images.find((i) => i.id === c.id)!.path);
      const img = normaliseImage(bytes.toString('base64'));
      const mask = readMaskPng(c.maskPath);
      const item: EvalItem = {
        id: `parity:${c.id}`,
        datasetId: 'parity',
        key: c.id,
        split: null,
        imageSha256: img.sha256,
        dhash: '',
        relPath: '',
        normPath: '',
        width: img.width,
        height: img.height,
        gt: { rawLabels: {} },
        strata: {},
        duplicateOf: null,
      };
      const out = await runPipeline(
        item,
        { runId: 'parity', runDir: dir, seg: 'hsv', boundary: 'auto', policy: 'image_only' },
        { image: img, maskOverride: mask.data, writeMask: false },
      );
      if (!out.result || !out.engineInputs) {
        cases.push({ id: c.id, diffs: [`harness produced no result: ${JSON.stringify(out.row.prediction?.errors ?? out.row.error)}`], pathway: null, status: 'n/a' });
        continue;
      }
      const diffs = [
        ...diff(pick(c.result), pick(out.result)).map((d) => `result.${d}`),
        ...diff(pickInputs(c.engineInputs), pickInputs(out.engineInputs)).map((d) => `engineInputs.${d}`),
      ];
      const t = out.engineInputs.tissue;
      cases.push({
        id: c.id,
        diffs,
        pathway: out.result.cwcsPathwayId,
        status: out.result.status,
        pxPerCm: c.pxPerCm,
        periwound: Boolean(out.engineInputs.periwound),
        tissue: `g${t.granulation}/s${t.slough}/n${t.necrosis}/e${t.epithelial}/o${t.other}`,
      });
    }
    if (opts.verbose) console.log(childLog);
    return { ok: cases.length === PARITY_IMAGES.length && cases.every((c) => c.diffs.length === 0), cases, childLog };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
