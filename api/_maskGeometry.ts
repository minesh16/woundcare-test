/**
 * Mask ⇄ polygon geometry — pure functions, NO imports.
 *
 * This is what makes a clinician's judgement about the boundary expressible as
 * data. The review screen needs two directions:
 *
 *   mask → polygon   (`traceOutline`)     seed the editor with the model's
 *                                          boundary so "Adjust" starts from it
 *   polygon → mask   (`rasterisePolygon`)  turn an approved/adjusted/drawn
 *                                          outline back into the binary mask the
 *                                          HSI tissue classifier measures inside
 *
 * Polygons are **fractional** (0–1), like every other point in this app, so they
 * survive the resize between capture, display and measurement. Pixels only ever
 * appear inside these functions.
 *
 * Import-free and self-contained for the same reason as `engine.ts` and
 * `_segmentationParse.ts`: `node --experimental-strip-types` resolves ESM
 * specifiers literally, so a cross-file import would make it untestable offline.
 *
 * The cage is unaffected. A clinician-drawn boundary is still only a BOUNDARY —
 * tissue composition is still measured by OpenCV HSI inside it, and the dressing
 * pathway still comes from the deterministic engine. What changes is that the
 * boundary now has a human in the loop, and the audit trail records which.
 */

/** A point in fractional image coordinates (0–1). */
export type MaskPoint = { x: number; y: number };

/** What the clinician did with the model's proposed boundary. */
export type BoundaryApproval = 'approved' | 'adjusted' | 'drawn';

/** A polygon needs at least a triangle to enclose any area. */
export const MIN_POLYGON_POINTS = 3;

/**
 * Upper bound on points we accept or emit. A traced contour can be thousands of
 * pixels long; nobody edits that, and it would bloat every request and audit
 * record. Simplification brings it under this.
 */
export const MAX_POLYGON_POINTS = 400;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type PolygonValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validate a polygon arriving over HTTP. Deliberately strict: this is
 * caller-supplied data that ends up deciding which pixels count as wound, and
 * `docs/SECURITY_AUDIT.md` MW-12 is about exactly this class of input.
 */
export function validatePolygon(points: unknown): PolygonValidation {
  if (!Array.isArray(points)) return { ok: false, reason: 'polygon must be an array of points' };
  if (points.length < MIN_POLYGON_POINTS) {
    return { ok: false, reason: `a boundary needs at least ${MIN_POLYGON_POINTS} points` };
  }
  if (points.length > MAX_POLYGON_POINTS) {
    return { ok: false, reason: `a boundary may not exceed ${MAX_POLYGON_POINTS} points` };
  }
  for (const point of points) {
    if (!point || typeof point !== 'object') return { ok: false, reason: 'each point must be an object' };
    const { x, y } = point as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: 'each point needs finite numeric x and y' };
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return { ok: false, reason: 'points are fractional image coordinates and must be within 0–1' };
    }
  }
  return { ok: true };
}

/** Shoelace area as a fraction of the frame. Sign-independent. */
export function polygonAreaFraction(points: readonly MaskPoint[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

// ---------------------------------------------------------------------------
// polygon → mask
// ---------------------------------------------------------------------------

/**
 * Scanline-fill a polygon into a 0/255 single-channel mask.
 *
 * Even-odd rule, sampling each row at its centre (`y + 0.5`) so a horizontal
 * edge lying exactly on a pixel boundary does not produce a row of
 * double-counted crossings. Points are fractional, so the same polygon
 * rasterises correctly at any resolution.
 */
export function rasterisePolygon(
  points: readonly MaskPoint[],
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  if (points.length < 3 || width <= 0 || height <= 0) return out;

  const xs = points.map((p) => p.x * width);
  const ys = points.map((p) => p.y * height);

  for (let row = 0; row < height; row += 1) {
    const y = row + 0.5;
    const crossings: number[] = [];

    for (let i = 0; i < points.length; i += 1) {
      const j = (i + 1) % points.length;
      const y0 = ys[i];
      const y1 = ys[j];
      // Half-open test: counts an edge once even when a vertex sits on the row.
      if (y0 === y1) continue;
      if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) {
        const t = (y - y0) / (y1 - y0);
        crossings.push(xs[i] + t * (xs[j] - xs[i]));
      }
    }

    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let col = from; col <= to; col += 1) out[row * width + col] = 255;
    }
  }

  return out;
}

/** Count set pixels in a 0/255 mask. */
export function countSet(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] !== 0) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// mask → polygon
// ---------------------------------------------------------------------------

/**
 * Largest 4-connected component of a 0/255 mask, as a new mask.
 *
 * The model's mask can contain several regions — FUSegNet reports
 * `regions_found` / `regions_kept` and does its own filtering, and SAM 3 can
 * match more than one instance. Tracing a multi-region mask would produce a
 * contour that jumps between blobs, so the outline is traced from the largest
 * region only. Iterative BFS, not recursion: a wound can be hundreds of
 * thousands of pixels and a recursive flood fill would blow the stack.
 */
export function largestComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): { mask: Uint8Array; areaPx: number } {
  const labels = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  let best = { label: -1, area: 0 };
  let label = 0;

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    let area = 0;

    while (head < tail) {
      const index = queue[head++];
      area += 1;
      const x = index % width;
      const y = (index - x) / width;
      // 4-connectivity: diagonal-only touching is two regions, not one.
      if (x > 0) {
        const n = index - 1;
        if (mask[n] !== 0 && labels[n] === -1) { labels[n] = label; queue[tail++] = n; }
      }
      if (x < width - 1) {
        const n = index + 1;
        if (mask[n] !== 0 && labels[n] === -1) { labels[n] = label; queue[tail++] = n; }
      }
      if (y > 0) {
        const n = index - width;
        if (mask[n] !== 0 && labels[n] === -1) { labels[n] = label; queue[tail++] = n; }
      }
      if (y < height - 1) {
        const n = index + width;
        if (mask[n] !== 0 && labels[n] === -1) { labels[n] = label; queue[tail++] = n; }
      }
    }

    if (area > best.area) best = { label, area };
    label += 1;
  }

  const out = new Uint8Array(width * height);
  if (best.label === -1) return { mask: out, areaPx: 0 };
  for (let i = 0; i < labels.length; i += 1) if (labels[i] === best.label) out[i] = 255;
  return { mask: out, areaPx: best.area };
}

/** Clockwise 8-neighbour offsets, starting west. Used by the contour walk. */
const NEIGHBOURS: readonly [number, number][] = [
  [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1],
];

/**
 * Moore-neighbour contour trace of a single-region 0/255 mask, in pixels.
 *
 * Walks the outer boundary in order, which a "collect boundary pixels and sort
 * them" approach cannot do — that produces self-crossing polygons on any
 * concave shape, and wounds are concave. Bounded by `maxSteps` so a pathological
 * mask cannot spin forever inside a request.
 */
export function traceContourPixels(
  mask: Uint8Array,
  width: number,
  height: number,
): { x: number; y: number }[] {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;

  // Start at the topmost-then-leftmost set pixel; its west neighbour is outside
  // the shape by construction, which is the backtrack the walk needs.
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startY === -1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (at(x, y)) { startX = x; startY = y; break; }
    }
  }
  if (startX === -1) return [];

  const contour: { x: number; y: number }[] = [{ x: startX, y: startY }];
  const maxSteps = 4 * (width + height) + 8 * countSet(mask);

  let currentX = startX;
  let currentY = startY;
  let backtrackIndex = 0; // west of the start
  let steps = 0;

  for (;;) {
    let found = false;
    // Sweep clockwise from just after the direction we arrived from.
    for (let k = 1; k <= 8; k += 1) {
      const dirIndex = (backtrackIndex + k) % 8;
      const [dx, dy] = NEIGHBOURS[dirIndex];
      const nx = currentX + dx;
      const ny = currentY + dy;
      if (at(nx, ny)) {
        // The new backtrack is the neighbour we last rejected, i.e. one step back.
        backtrackIndex = (dirIndex + 4 + 1) % 8;
        currentX = nx;
        currentY = ny;
        found = true;
        break;
      }
    }

    // An isolated pixel has no set neighbour at all.
    if (!found) break;

    steps += 1;
    if (currentX === startX && currentY === startY) break;
    contour.push({ x: currentX, y: currentY });
    if (steps > maxSteps) break;
  }

  return contour;
}

/**
 * Perpendicular-distance polyline simplification (Douglas–Peucker), iterative.
 *
 * A traced contour is one point per boundary pixel — thousands of them. Nobody
 * drags three thousand handles, and the editor needs a polygon a person can
 * actually manipulate, so the contour is reduced to its load-bearing vertices.
 */
export function simplifyPolyline(points: readonly MaskPoint[], tolerance: number): MaskPoint[] {
  if (points.length <= 2 || tolerance <= 0) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;

    const ax = points[first].x;
    const ay = points[first].y;
    const bx = points[last].x;
    const by = points[last].y;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;

    let worst = -1;
    let worstDistance = 0;
    for (let i = first + 1; i < last; i += 1) {
      const px = points[i].x - ax;
      const py = points[i].y - ay;
      // Distance from the point to the segment (degenerate segment → to the point).
      const distance =
        lengthSq === 0
          ? Math.hypot(px, py)
          : Math.abs(px * dy - py * dx) / Math.sqrt(lengthSq);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = i;
      }
    }

    if (worst !== -1 && worstDistance > tolerance) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  const out: MaskPoint[] = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i]);
  return out;
}

/** Default simplification tolerance, as a fraction of the frame. ~0.5% of width. */
export const OUTLINE_TOLERANCE = 0.005;

/**
 * Mask → an editable fractional polygon: largest region, traced, simplified.
 *
 * Returns null when there is nothing to trace or the result cannot enclose an
 * area — the review screen then offers "draw" rather than a degenerate outline
 * to adjust.
 */
export function traceOutline(
  mask: Uint8Array,
  width: number,
  height: number,
  tolerance: number = OUTLINE_TOLERANCE,
): MaskPoint[] | null {
  if (width <= 0 || height <= 0) return null;
  const { mask: region, areaPx } = largestComponent(mask, width, height);
  if (areaPx === 0) return null;

  const pixels = traceContourPixels(region, width, height);
  if (pixels.length < MIN_POLYGON_POINTS) return null;

  // Pixel centres → fractional, so the polygon is resolution-independent.
  const fractional = pixels.map((p) => ({ x: (p.x + 0.5) / width, y: (p.y + 0.5) / height }));
  let simplified = simplifyPolyline(fractional, tolerance);

  // Keep relaxing until it fits the editable budget rather than truncating,
  // which would cut a hole in the boundary.
  let guard = 0;
  let currentTolerance = tolerance;
  while (simplified.length > MAX_POLYGON_POINTS && guard < 12) {
    currentTolerance *= 1.8;
    simplified = simplifyPolyline(fractional, currentTolerance);
    guard += 1;
  }

  return simplified.length >= MIN_POLYGON_POINTS ? simplified : null;
}

/** A one-byte-per-pixel mask and its dimensions. */
export type MaskRaster = { data: Uint8Array; width: number; height: number };

export type MaskComparison = {
  /** Intersection over union, or null when both masks are empty. */
  iou: number | null;
  /** Set pixels of each mask, counted on the common grid so they are comparable. */
  aAreaPx: number;
  bAreaPx: number;
  /** (b − a) / a × 100, or null when `a` is empty. */
  areaDeltaPct: number | null;
};

/**
 * Compare two masks — the model's draft and the clinician's final (segmentation
 * spec §4.1). They can arrive at different resolutions and aspect ratios (SAM 3
 * returns the photo's grid; a rasterised polygon is square by default), so both
 * are sampled at FRACTIONAL positions on one `gridW × gridH` grid, nearest
 * neighbour. Comparing raw pixel arrays of different shapes would be meaningless.
 */
export function compareMasks(a: MaskRaster, b: MaskRaster, gridW: number, gridH: number): MaskComparison {
  const sample = (m: MaskRaster, gx: number, gy: number) => {
    const x = Math.min(m.width - 1, Math.floor(((gx + 0.5) / gridW) * m.width));
    const y = Math.min(m.height - 1, Math.floor(((gy + 0.5) / gridH) * m.height));
    return m.data[y * m.width + x] !== 0;
  };
  let aArea = 0;
  let bArea = 0;
  let inter = 0;
  for (let gy = 0; gy < gridH; gy += 1) {
    for (let gx = 0; gx < gridW; gx += 1) {
      const inA = sample(a, gx, gy);
      const inB = sample(b, gx, gy);
      if (inA) aArea += 1;
      if (inB) bArea += 1;
      if (inA && inB) inter += 1;
    }
  }
  const union = aArea + bArea - inter;
  return {
    iou: union === 0 ? null : inter / union,
    aAreaPx: aArea,
    bAreaPx: bArea,
    areaDeltaPct: aArea === 0 ? null : ((bArea - aArea) / aArea) * 100,
  };
}

/** IoU below this means the clinician materially changed the boundary (spec §4.1). */
export const BOUNDARY_CHANGED_IOU = 0.95;
