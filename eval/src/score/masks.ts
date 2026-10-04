/**
 * Pixel-level mask metrics (spec §14.2). P = predicted, G = ground truth, both
 * 0/non-zero on the same analysis grid.
 */

export type MaskMetrics = {
  dice: number;
  iou: number;
  precision: number | null;
  recall: number | null;
  hd95Px: number | null;
  hd95PctDiag: number | null;
  boundaryF1: number | null;
  areaP: number;
  areaG: number;
  /** (areaP − areaG) / areaG × 100; null when G is empty. */
  areaErrPct: number | null;
};

export function confusion(p: Uint8Array, g: Uint8Array): { tp: number; fp: number; fn: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < p.length; i += 1) {
    const a = p[i] !== 0;
    const b = g[i] !== 0;
    if (a && b) tp += 1;
    else if (a) fp += 1;
    else if (b) fn += 1;
  }
  return { tp, fp, fn };
}

/** Boundary pixels: set pixels with an unset 4-neighbour (the frame edge counts as unset). */
export function boundary(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) out[i] = 1;
    }
  }
  return out;
}

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q += 1) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k -= 1;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/** Exact Euclidean distance from every pixel to the nearest set pixel of `mask`. */
export function edt(mask: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e20;
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i += 1) grid[i] = mask[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y += 1) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x += 1) grid[y * w + x] = Math.sqrt(d[x]);
  }
  return grid;
}

function percentile95(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.sort((a, b) => a - b);
  const pos = (s.length - 1) * 0.95;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const BOUNDARY_TOLERANCE_PX = 2;

export function maskMetrics(p: Uint8Array, g: Uint8Array, w: number, h: number): MaskMetrics {
  const { tp, fp, fn } = confusion(p, g);
  const areaP = tp + fp;
  const areaG = tp + fn;
  const bothEmpty = areaP === 0 && areaG === 0;
  const dice = bothEmpty ? 1 : (2 * tp) / (2 * tp + fp + fn);
  const iou = bothEmpty ? 1 : tp / (tp + fp + fn);
  const precision = areaP === 0 ? null : tp / areaP;
  const recall = areaG === 0 ? null : tp / areaG;
  const areaErrPct = areaG === 0 ? null : ((areaP - areaG) / areaG) * 100;

  let hd95Px: number | null = null;
  let boundaryF1: number | null = null;
  if (bothEmpty) {
    hd95Px = 0;
    boundaryF1 = 1;
  } else if (areaP > 0 && areaG > 0) {
    const bp = boundary(p, w, h);
    const bg = boundary(g, w, h);
    const toG = edt(bg, w, h);
    const toP = edt(bp, w, h);
    const dPG: number[] = [];
    const dGP: number[] = [];
    let pHit = 0;
    let gHit = 0;
    for (let i = 0; i < bp.length; i += 1) {
      if (bp[i]) {
        dPG.push(toG[i]);
        if (toG[i] <= BOUNDARY_TOLERANCE_PX) pHit += 1;
      }
      if (bg[i]) {
        dGP.push(toP[i]);
        if (toP[i] <= BOUNDARY_TOLERANCE_PX) gHit += 1;
      }
    }
    hd95Px = Math.max(percentile95(dPG), percentile95(dGP));
    const bPrec = pHit / dPG.length;
    const bRec = gHit / dGP.length;
    boundaryF1 = bPrec + bRec === 0 ? 0 : (2 * bPrec * bRec) / (bPrec + bRec);
  } else {
    boundaryF1 = 0;
  }
  return {
    dice,
    iou,
    precision,
    recall,
    hd95Px,
    hd95PctDiag: hd95Px === null ? null : (100 * hd95Px) / Math.hypot(w, h),
    boundaryF1,
    areaP,
    areaG,
    areaErrPct,
  };
}
