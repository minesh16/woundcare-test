/**
 * Procedural images for the harness: test fixtures (spec §21), the parity
 * images (§12) and the `synthetic-negatives` dataset (§23). No external data.
 *
 * A "wound" is an ellipse split into granulation (red), slough (yellow) and
 * necrotic (black) bands; a "coin" is a grey disc with a darker rim, sized like
 * an Australian 20c (28.52 mm) at the requested px/cm.
 */
import { rng } from './score/stats';

export type SynthOptions = {
  width?: number;
  height?: number;
  seed?: number;
  /** Background RGB. Default: a pale, desaturated surface the HSV fallback does not pick up. */
  background?: [number, number, number];
  /** Per-pixel background noise amplitude. */
  noise?: number;
  /** null → no wound (a negative). */
  wound?: { cx: number; cy: number; rx: number; ry: number; granulation: number; slough: number; necrotic: number } | null;
  coin?: { cx: number; cy: number; pxPerCm: number } | null;
  whitePatch?: { x: number; y: number; w: number; h: number } | null;
};

export type SynthImage = {
  rgba: Uint8Array;
  width: number;
  height: number;
  woundMask: Uint8Array;
  /** Per-class 0/255 masks inside the wound. */
  tissue: { granulation: Uint8Array; slough: Uint8Array; necrotic: Uint8Array };
  /** Ground-truth tissue % of the wound area. */
  tissuePct: { granulation: number; slough: number; necrotic: number; epithelial: number; other: number } | null;
};

export const COIN_20C_DIAMETER_CM = 2.852;

// Chosen inside the app's own classifier bands (src/cv/tissueClassifier.ts):
// granulation hue ≈ 8°, slough ≈ 39°, necrotic V < 45 — a 358° red would wrap out of both.
const COLOURS = {
  granulation: [190, 60, 40] as const,
  slough: [215, 165, 70] as const,
  necrotic: [30, 25, 22] as const,
};

export function synthImage(opts: SynthOptions = {}): SynthImage {
  const width = opts.width ?? 320;
  const height = opts.height ?? 240;
  const r = rng(opts.seed ?? 1);
  const bg = opts.background ?? [200, 196, 192];
  const noise = opts.noise ?? 6;
  const rgba = new Uint8Array(width * height * 4);
  const woundMask = new Uint8Array(width * height);
  const tissue = { granulation: new Uint8Array(width * height), slough: new Uint8Array(width * height), necrotic: new Uint8Array(width * height) };
  const w = opts.wound === undefined ? { cx: 0.55, cy: 0.5, rx: 0.2, ry: 0.15, granulation: 0.6, slough: 0.3, necrotic: 0.1 } : opts.wound;
  const coin = opts.coin ?? null;
  const patch = opts.whitePatch ?? null;
  let counts = { granulation: 0, slough: 0, necrotic: 0 };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const o = i * 4;
      const n = (r() - 0.5) * 2 * noise;
      let c: readonly number[] = [bg[0] + n, bg[1] + n, bg[2] + n];

      if (patch && x >= patch.x * width && x < (patch.x + patch.w) * width && y >= patch.y * height && y < (patch.y + patch.h) * height) {
        c = [250, 250, 250];
      }
      if (coin) {
        const rad = (coin.pxPerCm * COIN_20C_DIAMETER_CM) / 2;
        const d = Math.hypot(x - coin.cx * width, y - coin.cy * height);
        if (d < rad) c = d > rad - 2 ? [80, 80, 82] : [150, 150, 155];
      }
      if (w) {
        const dx = (x - w.cx * width) / (w.rx * width);
        const dy = (y - w.cy * height) / (w.ry * height);
        if (dx * dx + dy * dy < 1) {
          woundMask[i] = 255;
          // Bands left → right so each class is a contiguous region of the requested share.
          const t = (dx + 1) / 2;
          const cls = t < w.necrotic ? 'necrotic' : t < w.necrotic + w.slough ? 'slough' : 'granulation';
          tissue[cls][i] = 255;
          counts = { ...counts, [cls]: counts[cls] + 1 };
          const base = COLOURS[cls];
          c = [base[0] + n / 2, base[1] + n / 2, base[2] + n / 2];
        }
      }
      rgba[o] = Math.max(0, Math.min(255, Math.round(c[0])));
      rgba[o + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
      rgba[o + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
      rgba[o + 3] = 255;
    }
  }
  const total = counts.granulation + counts.slough + counts.necrotic;
  const tissuePct = total
    ? {
        granulation: (100 * counts.granulation) / total,
        slough: (100 * counts.slough) / total,
        necrotic: (100 * counts.necrotic) / total,
        epithelial: 0,
        other: 0,
      }
    : null;
  return { rgba, width, height, woundMask, tissue, tissuePct };
}

/** Skin-like RGB across a light → dark range (synthetic-negatives). */
export function skinTone(t: number): [number, number, number] {
  const light = [236, 200, 175];
  const dark = [92, 60, 44];
  return [0, 1, 2].map((k) => Math.round(light[k] + (dark[k] - light[k]) * t)) as [number, number, number];
}

/**
 * A non-wound skin photo: smooth shading, mottling, a few freckles and
 * occasionally a hair line. No wound — `woundPresent: false`.
 */
export function synthNegative(seed: number, width = 480, height = 360): SynthImage {
  const r = rng(seed);
  const tone = skinTone(r());
  const base = synthImage({ width, height, seed, background: tone, noise: 5, wound: null });
  const freckles = Array.from({ length: Math.floor(r() * 12) }, () => ({ x: r() * width, y: r() * height, rad: 1 + r() * 3 }));
  const shade = 0.15 + r() * 0.25;
  const angle = r() * Math.PI;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const g = 1 - shade * (((x / width) * Math.cos(angle) + (y / height) * Math.sin(angle)) * 0.5 + 0.5);
      let f = 1;
      for (const fr of freckles) if (Math.hypot(x - fr.x, y - fr.y) < fr.rad) f = 0.8;
      for (let c = 0; c < 3; c += 1) base.rgba[o + c] = Math.max(0, Math.min(255, Math.round(base.rgba[o + c] * g * f)));
    }
  }
  return base;
}
