/**
 * Which of OpenCV's Hough circles is the reference coin.
 *
 * Import-free, like `_maskGeometry.ts`, so `test:measure` can load it under
 * `node --experimental-strip-types`. The OpenCV calls that produce the inputs
 * (HoughCircles, Canny) live in `_measure.ts`; everything that decides lives here.
 *
 * Why this exists: the original detector took the FIRST circle HoughCircles
 * returned, with no radius bounds. On a leg-ulcer photo with a 20c coin beside
 * it, the first circle was a phantom centred on the wound at twice the coin's
 * radius, giving 84.5 px/cm against a true 42.1 — every area off by ~4×, stated
 * at "high" confidence. A wrong scale is worse than no scale, because no scale
 * withholds the pathway and a wrong one does not.
 *
 * Three filters, each cheap and each independently sufficient to have caught it:
 *  1. Radius bounds relative to the frame — a coin is neither a speck nor half
 *     the photo.
 *  2. Not touching the approved wound outline — the coin sits BESIDE the wound,
 *     and the wound's round edge is exactly what produces phantom circles.
 *  3. Edge support — the share of the circle's circumference that lands on a
 *     real edge. A coin's rim is a crisp, complete circle (0.93 on the demo
 *     photo); phantoms assembled from skin texture and the wound edge are not
 *     (every one ≤ 0.44).
 */

export type Circle = { x: number; y: number; r: number };

export type CoinCandidate = Circle & {
  /** Share of circumference samples (0–1) that land on an edge pixel. */
  support: number;
  /** The circle touches the wound outline (plus a margin). */
  overlapsWound: boolean;
};

export type CoinChoice = {
  circle: Circle;
  support: number;
  /** Every candidate considered, for the log — never images, only geometry. */
  candidates: CoinCandidate[];
};

/** Coin radius bounds as fractions of the frame's LONGER edge. */
export const COIN_RADIUS_MIN_FRACTION = 0.015;
export const COIN_RADIUS_MAX_FRACTION = 0.2;

/** Minimum share of the rim that must sit on a real edge. */
export const COIN_MIN_EDGE_SUPPORT = 0.6;

/** Clearance between a coin and the wound outline, in pixels. */
export const COIN_WOUND_MARGIN_PX = 5;

/** Circumference samples per candidate, and how far off the rim an edge may be. */
const SUPPORT_SAMPLES = 90;
const SUPPORT_TOLERANCE_PX = 2;

export function coinRadiusBounds(width: number, height: number): { minRadius: number; maxRadius: number } {
  const long = Math.max(width, height);
  return {
    minRadius: Math.max(3, Math.round(COIN_RADIUS_MIN_FRACTION * long)),
    maxRadius: Math.max(4, Math.round(COIN_RADIUS_MAX_FRACTION * long)),
  };
}

/** OpenCV packs circles as [x, y, r, x, y, r, …] floats. */
export function parseCircles(data: ArrayLike<number>, count: number): Circle[] {
  const out: Circle[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = data[i * 3];
    const y = data[i * 3 + 1];
    const r = data[i * 3 + 2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(r) && r > 0) {
      out.push({ x, y, r });
    }
  }
  return out;
}

/**
 * Share of the circle's rim that lies on an edge pixel (any non-zero byte in
 * `edges`), allowing ±`SUPPORT_TOLERANCE_PX` radially. Samples falling outside
 * the frame count as misses: a coin cut off by the frame edge is not a reliable
 * scale anyway.
 */
export function edgeSupport(circle: Circle, edges: ArrayLike<number>, width: number, height: number): number {
  let hits = 0;
  for (let k = 0; k < SUPPORT_SAMPLES; k += 1) {
    const angle = (2 * Math.PI * k) / SUPPORT_SAMPLES;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let dr = -SUPPORT_TOLERANCE_PX; dr <= SUPPORT_TOLERANCE_PX; dr += 1) {
      const px = Math.round(circle.x + (circle.r + dr) * cos);
      const py = Math.round(circle.y + (circle.r + dr) * sin);
      if (px >= 0 && py >= 0 && px < width && py < height && edges[py * width + px]) {
        hits += 1;
        break;
      }
    }
  }
  return hits / SUPPORT_SAMPLES;
}

/** True when any mask pixel lies within the circle grown by `marginPx`. */
export function overlapsMask(
  circle: Circle,
  mask: ArrayLike<number>,
  width: number,
  height: number,
  marginPx: number = COIN_WOUND_MARGIN_PX,
): boolean {
  const reach = circle.r + marginPx;
  const reach2 = reach * reach;
  const x0 = Math.max(0, Math.floor(circle.x - reach));
  const x1 = Math.min(width - 1, Math.ceil(circle.x + reach));
  const y0 = Math.max(0, Math.floor(circle.y - reach));
  const y1 = Math.min(height - 1, Math.ceil(circle.y + reach));
  for (let y = y0; y <= y1; y += 1) {
    const dy = y - circle.y;
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - circle.x;
      if (dx * dx + dy * dy <= reach2 && mask[y * width + x]) return true;
    }
  }
  return false;
}

/**
 * Pick the coin, or null. Among circles inside the radius bounds, not touching
 * the wound, and with enough edge support, the best-supported wins (ties go to
 * the earlier Hough candidate, i.e. the one with more accumulator votes).
 *
 * `mask` is null when there is no approved outline yet (the legacy analyze pass);
 * the radius and edge-support filters still apply.
 */
export function chooseCoin(
  circles: Circle[],
  frame: { edges: ArrayLike<number>; mask: ArrayLike<number> | null; width: number; height: number },
): CoinChoice | null {
  const { minRadius, maxRadius } = coinRadiusBounds(frame.width, frame.height);
  const candidates: CoinCandidate[] = circles
    .filter((c) => c.r >= minRadius && c.r <= maxRadius)
    .map((c) => ({
      ...c,
      support: edgeSupport(c, frame.edges, frame.width, frame.height),
      overlapsWound: frame.mask ? overlapsMask(c, frame.mask, frame.width, frame.height) : false,
    }));

  let best: CoinCandidate | null = null;
  for (const c of candidates) {
    if (c.overlapsWound || c.support < COIN_MIN_EDGE_SUPPORT) continue;
    if (!best || c.support > best.support) best = c;
  }
  if (!best) return null;
  return { circle: { x: best.x, y: best.y, r: best.r }, support: best.support, candidates };
}
