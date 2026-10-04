/** §21.1 — statistics and mask metrics against hand-worked values. */
import type { T } from './run.mts';

export default async function (t: T) {
  const s = await t.load<typeof import('../src/score/stats')>('../src/score/stats.ts');
  const m = await t.load<typeof import('../src/score/masks')>('../src/score/masks.ts');

  // --- 10×10 masks: P = rows 0–4 × cols 0–4 (25 px), G = rows 0–4 × cols 2–6 (25 px). Overlap = 5×3 = 15.
  const W = 10;
  const H = 10;
  const P = new Uint8Array(W * H);
  const G = new Uint8Array(W * H);
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) P[y * W + x] = 255;
  for (let y = 0; y < 5; y += 1) for (let x = 2; x < 7; x += 1) G[y * W + x] = 255;
  const mm = m.maskMetrics(P, G, W, H);
  t.near(mm.dice, (2 * 15) / (25 + 25), 1e-12, 'dice 10×10');
  t.near(mm.iou, 15 / 35, 1e-12, 'iou 10×10');
  t.near(mm.precision, 15 / 25, 1e-12, 'precision');
  t.near(mm.recall, 15 / 25, 1e-12, 'recall');
  t.near(mm.areaErrPct, 0, 1e-12, 'area error 0%');
  // Boundaries: shifting a 5×5 square by 2 columns. Each P boundary px is ≤ 2 from G's boundary except
  // none — the left edge (x=0) is 2 from G's left edge (x=2). So boundary F1 at tolerance 2 is 1.
  t.near(mm.boundaryF1, 1, 1e-12, 'boundary F1 with a 2-px shift at tolerance 2');
  t.near(mm.hd95Px, 2, 1e-9, 'HD95 of a 2-px shift');
  const empty = new Uint8Array(W * H);
  t.eq(m.maskMetrics(empty, empty, W, H).dice, 1, 'both empty → dice 1');
  t.eq(m.maskMetrics(P, empty, W, H).dice, 0, 'P vs empty G → dice 0');
  t.eq(m.maskMetrics(P, empty, W, H).recall, null, 'recall undefined with empty G');
  const shifted = new Uint8Array(W * H);
  for (let y = 0; y < 5; y += 1) for (let x = 5; x < 10; x += 1) shifted[y * W + x] = 255;
  t.near(m.maskMetrics(P, shifted, W, H).hd95Px, 5, 1e-9, 'HD95 of a 5-px shift');
  const far = new Uint8Array(W * H);
  for (let y = 6; y < 10; y += 1) for (let x = 6; x < 10; x += 1) far[y * W + x] = 255;
  t.near(m.maskMetrics(P, far, W, H).boundaryF1, 0, 1e-12, 'boundary F1 of squares > 2 px apart');
  t.ok((m.maskMetrics(P, shifted, W, H).boundaryF1 ?? 0) > 0, 'adjacent squares share boundary within tolerance');

  // EDT: distance from a single pixel.
  const dot = new Uint8Array(25);
  dot[12] = 1;
  const d = m.edt(dot, 5, 5);
  t.near(d[0], Math.SQRT2 * 2, 1e-9, 'EDT corner of 5×5 = 2√2');
  t.near(d[2], 2, 1e-9, 'EDT straight distance 2');

  // --- Wilson: k=8, n=10 (hand: 0.4902 – 0.9433)
  const w = s.wilson(8, 10);
  t.near(w.low, 0.4902, 1e-4, 'wilson low 8/10');
  t.near(w.high, 0.9433, 1e-4, 'wilson high 8/10');
  t.near(s.wilson(0, 10).low, 0, 1e-12, 'wilson 0/10 low');
  t.near(s.wilson(0, 10).high, 0.2775, 1e-4, 'wilson 0/10 high');

  // --- Bootstrap: reproducible under a seed, CI brackets the mean.
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b1 = s.bootstrap(xs, s.mean, { seed: 7 });
  const b2 = s.bootstrap(xs, s.mean, { seed: 7 });
  t.eq([b1.low, b1.high], [b2.low, b2.high], 'bootstrap reproducible with a fixed seed');
  t.ok(b1.low < 5.5 && b1.high > 5.5 && b1.value === 5.5, 'bootstrap CI brackets the mean', b1);
  const ys = Array.from({ length: 10 }, (_, i) => Math.sqrt(i + 1) * 1.37);
  const b3 = s.bootstrap(ys, s.mean, { seed: 8 });
  const b4 = s.bootstrap(ys, s.mean, { seed: 7 });
  t.ok(b3.low !== b4.low || b3.high !== b4.high, 'a different seed gives a different CI');

  // --- McNemar exact: b=1, c=9 → p = 2·P(X≤1 | n=10, ½) = 2·11/1024 = 0.021484375
  t.near(s.mcnemarExact(1, 9).p, 22 / 1024, 1e-12, 'McNemar exact b=1 c=9');
  t.near(s.mcnemarExact(5, 5).p, 1, 1e-12, 'McNemar balanced → 1');
  t.eq(s.mcnemarExact(0, 0).p, 1, 'McNemar no discordance → 1');

  // --- Cohen's κ: hand example. a = [y,y,n,n,y,n], b = [y,n,n,n,y,y]: po = 4/6, pe = (3/6·3/6)+(3/6·3/6) = 0.5 → κ = 1/3
  t.near(s.cohensKappa(['y', 'y', 'n', 'n', 'y', 'n'], ['y', 'n', 'n', 'n', 'y', 'y']), 1 / 3, 1e-12, 'kappa hand example');
  t.near(s.cohensKappa(['a', 'b'], ['a', 'b']), 1, 1e-12, 'kappa perfect');

  // --- Bland–Altman: a = [1,2,3,4], b = [2,3,5,4] → d = [1,1,2,0], bias 1, SD = √(2/3)
  const ba = s.blandAltman([1, 2, 3, 4], [2, 3, 5, 4]);
  t.near(ba.bias, 1, 1e-12, 'BA bias');
  t.near(ba.high - ba.bias, 1.96 * Math.sqrt(2 / 3), 1e-9, 'BA limit');

  // --- Paired bootstrap, AUROC, correlation, macro-F1, calibration.
  const pb = s.pairedBootstrap([1, 1, 1, 1], [2, 2, 2, 2], { seed: 1 });
  t.near(pb.value, 1, 1e-12, 'paired bootstrap constant difference');
  t.eq(pb.shareAbove0, 1, 'paired bootstrap share > 0');
  t.near(s.auroc([0.9, 0.8, 0.3, 0.1], [true, true, false, false]), 1, 1e-12, 'AUROC perfect');
  t.near(s.auroc([0.5, 0.5], [true, false]), 0.5, 1e-12, 'AUROC tie = ½');
  t.near(s.pearson([1, 2, 3], [2, 4, 6]), 1, 1e-12, 'pearson linear');
  t.near(s.spearman([1, 2, 3, 4], [1, 4, 9, 16]), 1, 1e-12, 'spearman monotone');
  t.near(s.macroF1(['a', 'a', 'b', 'b'], ['a', 'b', 'b', 'b'], ['a', 'b']), (2 / 3 + 0.8) / 2, 1e-12, 'macro-F1 hand example');
  const cal = s.calibrationBins([0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4], 2);
  t.ok(cal.monotonic && cal.bins.length === 2, 'calibration bins monotone', cal);
  const thr = s.bestThreshold([0.9, 0.8, 0.3, 0.1], [true, true, false, false]);
  t.eq(thr?.t, 0.8, 'best threshold separates good from bad');
}
