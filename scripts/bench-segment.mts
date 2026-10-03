/**
 * Segmentation benchmark on labelled images (segmentation spec §3.4 acceptance).
 *
 *   set -a; . ./.env.local; set +a
 *   npm run bench:segment -- --dir=path/to/set [--zone=foot_left] [--base=http://localhost:3000]
 *
 * `--dir` holds `images/` and `labels/` with matching filenames (e.g. the public
 * FUSeg Challenge validation set). PUBLIC OR SYNTHETIC IMAGES ONLY.
 *
 * Reports, per image and in aggregate:
 *   - /segment latency (wall and model) → p50 / p90 (acceptance: p50 < 8 s)
 *   - IoU of the draft outline vs the ground truth
 *   - one positive tap at a ground-truth point → does the new mask contain it?
 *     (acceptance), and the IoU after the tap
 *   - FUSegNet second opinion (with a foot zone): agreement IoU, and FUSegNet's
 *     own IoU vs the ground truth
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { compareMasks } from '../api/_maskGeometry.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]));
const BASE = args.base ?? 'http://localhost:3000';
const ZONE = args.zone ?? 'foot_left';
const KEY = process.env.MENDWISE_APP_KEY ?? '';
if (!args.dir || !KEY) {
  console.error('Usage: npm run bench:segment -- --dir=<set with images/ and labels/>   (MENDWISE_APP_KEY in the environment)');
  process.exit(1);
}

type Raster = { data: Uint8Array; width: number; height: number };

function decode(bytes: Buffer): { rgba: Uint8Array; width: number; height: number } {
  if (bytes[0] === 0x89) {
    const png = PNG.sync.read(bytes);
    return { rgba: png.data, width: png.width, height: png.height };
  }
  const j = jpeg.decode(bytes, { useTArray: true });
  return { rgba: j.data, width: j.width, height: j.height };
}

function toJpegBase64(bytes: Buffer): string {
  const { rgba, width, height } = decode(bytes);
  return jpeg.encode({ data: Buffer.from(rgba), width, height }, 92).data.toString('base64');
}

function maskOf(bytes: Buffer): Raster {
  const { rgba, width, height } = decode(bytes);
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) data[i] = rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2] > 3 * 127 ? 255 : 0;
  return { data, width, height };
}

function maskFromDataUri(uri: string | null | undefined): Raster | null {
  if (!uri?.startsWith('data:')) return null;
  return maskOf(Buffer.from(uri.split(',')[1], 'base64'));
}

/** A ground-truth pixel near the label's centroid — inside the wound. */
function interiorPoint(m: Raster): { xPct: number; yPct: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < m.height; y += 1) for (let x = 0; x < m.width; x += 1) if (m.data[y * m.width + x]) { sx += x; sy += y; n += 1; }
  if (!n) return null;
  const cx = sx / n;
  const cy = sy / n;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let y = 0; y < m.height; y += 1) {
    for (let x = 0; x < m.width; x += 1) {
      if (!m.data[y * m.width + x]) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best ? { xPct: (best[0] + 0.5) / m.width, yPct: (best[1] + 0.5) / m.height } : null;
}

function contains(m: Raster, p: { xPct: number; yPct: number }): boolean {
  const x = Math.min(m.width - 1, Math.floor(p.xPct * m.width));
  const y = Math.min(m.height - 1, Math.floor(p.yPct * m.height));
  return m.data[y * m.width + x] !== 0;
}

const iou = (a: Raster | null, gt: Raster) => (a ? compareMasks(a, gt, gt.width, gt.height).iou ?? 0 : 0);

async function segment(base64: string, prompts?: unknown) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/v1/assessments/segment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ base64, body_zone: ZONE, prompts }),
  });
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, json, wallMs: Date.now() - t0 };
}

const files = readdirSync(join(args.dir, 'images')).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
const rows: Record<string, unknown>[] = [];
const wall: number[] = [];
const model: number[] = [];
let tapHits = 0;
let taps = 0;

for (const file of files) {
  const base64 = toJpegBase64(readFileSync(join(args.dir, 'images', file)));
  const gt = maskOf(readFileSync(join(args.dir, 'labels', file)));
  const first = await segment(base64);
  wall.push(first.wallMs);
  if (typeof first.json.latencyMs === 'number') model.push(first.json.latencyMs);
  const draft = maskFromDataUri(first.json.mask);
  const opinion = first.json.secondOpinion;

  const tapPoint = interiorPoint(gt);
  let tapped: Raster | null = null;
  if (tapPoint) {
    const second = await segment(base64, { points: [{ ...tapPoint, label: 1 }] });
    tapped = maskFromDataUri(second.json.mask);
    taps += 1;
    if (tapped && contains(tapped, tapPoint)) tapHits += 1;
  }

  rows.push({
    image: file,
    source: first.json.source,
    score: typeof first.json.score === 'number' ? Number(first.json.score.toFixed(2)) : null,
    conf: first.json.confidence,
    wallMs: first.wallMs,
    modelMs: first.json.latencyMs,
    iouDraft: Number(iou(draft, gt).toFixed(3)),
    tapInside: tapped && tapPoint ? contains(tapped, tapPoint) : null,
    iouAfterTap: Number(iou(tapped, gt).toFixed(3)),
    fusegIoUvsSam: opinion?.status === 'ok' ? opinion.agreementIoU : opinion?.status ?? null,
    fusegIoUvsGT: opinion?.status === 'ok' ? Number(iou(maskFromDataUri(opinion.mask), gt).toFixed(3)) : null,
  });
}

console.table(rows);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const num = (k: string) => rows.map((r) => r[k]).filter((v): v is number => typeof v === 'number');
console.log(`\nimages: ${rows.length}`);
console.log(`latency /segment wall: p50 ${pct(wall, 50)} ms, p90 ${pct(wall, 90)} ms  (acceptance: p50 < 8000 ms → ${pct(wall, 50) < 8000 ? 'PASS' : 'FAIL'})`);
if (model.length) console.log(`latency model+chain:   p50 ${pct(model, 50)} ms, p90 ${pct(model, 90)} ms`);
console.log(`IoU vs ground truth — draft: mean ${mean(num('iouDraft')).toFixed(3)}; after one tap: mean ${mean(num('iouAfterTap')).toFixed(3)}`);
console.log(`one positive tap → mask contains the tap: ${tapHits}/${taps}  (acceptance → ${tapHits === taps ? 'PASS' : 'FAIL'})`);
const fus = num('fusegIoUvsGT');
if (fus.length) console.log(`FUSegNet second opinion — agreement with SAM 3: mean ${mean(num('fusegIoUvsSam')).toFixed(3)}; FUSegNet vs GT: mean ${mean(fus).toFixed(3)}`);
