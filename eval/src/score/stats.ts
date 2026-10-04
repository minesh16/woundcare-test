/**
 * Statistics (spec §15). Every function is pure and seeded where random, and
 * each has a hand-worked unit test in eval/test.
 */

/** mulberry32 — small, fast, seedable PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed from a string (FNV-1a), so a scope or metric name gives a stable seed. */
export function seedOf(s: string, base = 42): number {
  let h = 0x811c9dc5 ^ base;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (xs: readonly number[]) => quantile(xs, 0.5);

export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export type Interval = { value: number; low: number; high: number; n: number };

/** Wilson score 95% interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.959964): Interval {
  if (n === 0) return { value: NaN, low: NaN, high: NaN, n: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half), n };
}

/** Percentile bootstrap 95% CI of `stat` over items, seeded. */
export function bootstrap(
  xs: readonly number[],
  stat: (sample: number[]) => number = mean,
  opts: { resamples?: number; seed?: number } = {},
): Interval {
  const n = xs.length;
  if (n === 0) return { value: NaN, low: NaN, high: NaN, n: 0 };
  const value = stat([...xs]);
  if (n === 1) return { value, low: value, high: value, n };
  const B = opts.resamples ?? 2000;
  const r = rng(opts.seed ?? 42);
  const stats: number[] = [];
  const sample = new Array<number>(n);
  for (let b = 0; b < B; b += 1) {
    for (let i = 0; i < n; i += 1) sample[i] = xs[Math.floor(r() * n)];
    stats.push(stat(sample));
  }
  return { value, low: quantile(stats, 0.025), high: quantile(stats, 0.975), n };
}

/** Paired bootstrap of mean(b − a): 95% CI and the share of resamples above 0. */
export function pairedBootstrap(
  a: readonly number[],
  b: readonly number[],
  opts: { resamples?: number; seed?: number } = {},
): Interval & { shareAbove0: number } {
  if (a.length !== b.length) throw new Error('pairedBootstrap: arrays must be paired');
  const d = a.map((x, i) => b[i] - x);
  const n = d.length;
  if (n === 0) return { value: NaN, low: NaN, high: NaN, n: 0, shareAbove0: NaN };
  const B = opts.resamples ?? 2000;
  const r = rng(opts.seed ?? 42);
  const stats: number[] = [];
  for (let k = 0; k < B; k += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += d[Math.floor(r() * n)];
    stats.push(s / n);
  }
  return {
    value: mean(d),
    low: quantile(stats, 0.025),
    high: quantile(stats, 0.975),
    n,
    shareAbove0: stats.filter((s) => s > 0).length / B,
  };
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i += 1) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/**
 * McNemar's exact test on discordant pairs: b = base right/head wrong,
 * c = base wrong/head right. Two-sided binomial p-value.
 */
export function mcnemarExact(b: number, c: number): { b: number; c: number; p: number } {
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { b, c, p: Math.min(1, 2 * tail) };
}

/** Cohen's κ (unweighted) for two label sequences. */
export function cohensKappa(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length || a.length === 0) return NaN;
  const labels = [...new Set([...a, ...b])];
  const n = a.length;
  let agree = 0;
  for (let i = 0; i < n; i += 1) if (a[i] === b[i]) agree += 1;
  const po = agree / n;
  let pe = 0;
  for (const l of labels) pe += (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/** Macro-averaged F1 over the given labels (labels with no support and no predictions are skipped). */
export function macroF1(truth: readonly string[], pred: readonly string[], labels: readonly string[]): number {
  const f1s: number[] = [];
  for (const l of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < truth.length; i += 1) {
      if (pred[i] === l && truth[i] === l) tp += 1;
      else if (pred[i] === l) fp += 1;
      else if (truth[i] === l) fn += 1;
    }
    if (tp + fp + fn === 0) continue;
    f1s.push((2 * tp) / (2 * tp + fp + fn));
  }
  return f1s.length ? mean(f1s) : NaN;
}

/** Bland–Altman: bias = mean(b − a), limits = bias ± 1.96·SD. */
export function blandAltman(a: readonly number[], b: readonly number[]): { bias: number; low: number; high: number; n: number } {
  const d = a.map((x, i) => b[i] - x);
  const bias = mean(d);
  const s = sd(d);
  return { bias, low: bias - 1.96 * s, high: bias + 1.96 * s, n: d.length };
}

export function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}

/** Average ranks (ties share the mean rank). */
export function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

export const spearman = (x: readonly number[], y: readonly number[]) => pearson(ranks(x), ranks(y));

/** AUROC of `score` for predicting `positive` (Mann–Whitney, ties count ½). */
export function auroc(score: readonly number[], positive: readonly boolean[]): number {
  const pos = score.filter((_, i) => positive[i]);
  const neg = score.filter((_, i) => !positive[i]);
  if (pos.length === 0 || neg.length === 0) return NaN;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** Decile calibration bins of `y` against `x`, plus whether bin means rise monotonically. */
export function calibrationBins(
  x: readonly number[],
  y: readonly number[],
  bins = 10,
): { bins: { lo: number; hi: number; n: number; meanX: number; meanY: number }[]; monotonic: boolean } {
  const pairs = x.map((v, i) => [v, y[i]] as const).sort((a, b) => a[0] - b[0]);
  const out: { lo: number; hi: number; n: number; meanX: number; meanY: number }[] = [];
  if (pairs.length === 0) return { bins: out, monotonic: true };
  const per = pairs.length / bins;
  for (let b = 0; b < bins; b += 1) {
    const slice = pairs.slice(Math.round(b * per), Math.round((b + 1) * per));
    if (slice.length === 0) continue;
    out.push({
      lo: slice[0][0],
      hi: slice[slice.length - 1][0],
      n: slice.length,
      meanX: mean(slice.map((p) => p[0])),
      meanY: mean(slice.map((p) => p[1])),
    });
  }
  let monotonic = true;
  for (let i = 1; i < out.length; i += 1) if (out[i].meanY < out[i - 1].meanY) monotonic = false;
  return { bins: out, monotonic };
}

/**
 * The threshold on `score` that best separates `good` items (Youden's J =
 * sensitivity + specificity − 1). Advisory output for the app's confidence bands.
 */
export function bestThreshold(score: readonly number[], good: readonly boolean[]): { t: number; j: number; sens: number; spec: number } | null {
  const P = good.filter(Boolean).length;
  const N = good.length - P;
  if (P === 0 || N === 0) return null;
  let best: { t: number; j: number; sens: number; spec: number } | null = null;
  for (const t of [...new Set(score)].sort((a, b) => a - b)) {
    let tp = 0;
    let tn = 0;
    for (let i = 0; i < score.length; i += 1) {
      if (score[i] >= t && good[i]) tp += 1;
      if (score[i] < t && !good[i]) tn += 1;
    }
    const sens = tp / P;
    const spec = tn / N;
    const j = sens + spec - 1;
    if (!best || j > best.j) best = { t, j, sens, spec };
  }
  return best;
}
