import type { BodyZone } from '../decision/types.ts';
import type { BodySide } from './bodyZones.ts';

/**
 * Geometry for the wound-location body diagram.
 *
 * Shared figure space: 200 wide x 440 tall. x=100 is the midline.
 *   y= 10 crown      y= 58 chin       y= 78 neck base       y=118 mid-chest
 *   y=168 waist      y=206 hip        y=222 crotch          y=304 knee
 *   y=392 ankle      y=424 sole.      Arms reach out to x=16.
 *
 * Paired regions and the silhouette outline are authored for the PATIENT'S
 * RIGHT half only (x < 100); mirrorX() produces the other half. Nothing in
 * this file knows about left vs right as the *viewer* sees it -- regionsFor()
 * resolves that from the view, so laterality lives in exactly one place.
 *
 * Region polygons are deliberately oversized: they bleed past the silhouette
 * and are clipped back to it at render time. That makes gaps at the outline
 * impossible by construction. Only the seams *between* regions need care.
 *
 * No React here, and no `@/` aliases -- scripts/preview-body.mts loads this
 * module under bare Node to render the figures without the bundler.
 */

export const FIGURE_VIEWBOX = { width: 200, height: 440 } as const;

export type BodySex = 'male' | 'female';
export type Point = readonly [number, number];

/** Reflect a half-figure across the midline. */
export function mirrorX(points: readonly Point[]): Point[] {
  return points.map(([x, y]) => [FIGURE_VIEWBOX.width - x, y] as Point);
}

/**
 * Closed Catmull-Rom spline through every point, emitted as cubic beziers.
 * This is what makes the outline read as a body rather than a polygon.
 */
export function smoothClosedPath(points: readonly Point[], tension = 1): string {
  const n = points.length;
  if (n < 3) return '';
  const f = tension / 6;
  const at = (i: number) => points[((i % n) + n) % n];

  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i += 1) {
    const [x0, y0] = at(i - 1);
    const [x1, y1] = at(i);
    const [x2, y2] = at(i + 1);
    const [x3, y3] = at(i + 2);
    const c1x = x1 + (x2 - x0) * f;
    const c1y = y1 + (y2 - y0) * f;
    const c2x = x2 - (x3 - x1) * f;
    const c2y = y2 - (y3 - y1) * f;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  return `${d} Z`;
}

/** Straight-edged polygon with rounded corners, for region shapes. */
export function roundedPolygonPath(points: readonly Point[], radius = 6): string {
  const n = points.length;
  if (n < 3) return '';
  const at = (i: number) => points[((i % n) + n) % n];
  const along = (from: Point, to: Point, r: number): Point => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const len = Math.hypot(dx, dy) || 1;
    const t = Math.min(r, len / 2) / len;
    return [from[0] + dx * t, from[1] + dy * t];
  };

  let d = '';
  for (let i = 0; i < n; i += 1) {
    const prev = at(i - 1);
    const curr = at(i);
    const next = at(i + 1);
    const a = along(curr, prev, radius);
    const b = along(curr, next, radius);
    d += i === 0 ? `M ${b[0].toFixed(2)} ${b[1].toFixed(2)}` : ` L ${a[0].toFixed(2)} ${a[1].toFixed(2)}`;
    if (i > 0) {
      d += ` Q ${curr[0].toFixed(2)} ${curr[1].toFixed(2)}, ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
    }
  }
  const first = at(0);
  const a0 = along(first, at(-1), radius);
  d += ` L ${a0[0].toFixed(2)} ${a0[1].toFixed(2)} Q ${first[0].toFixed(2)} ${first[1].toFixed(2)}, ${along(first, at(1), radius)[0].toFixed(2)} ${along(first, at(1), radius)[1].toFixed(2)} Z`;
  return d;
}

// ---------------------------------------------------------------------------
// Silhouette outlines (patient's right half, crown -> hand -> foot -> crotch)
// ---------------------------------------------------------------------------

/** Head, neck and shoulder slope. Shared by every figure. */
const HEAD_AND_NECK: Point[] = [
  [100, 10],
  [89, 13],
  [82, 26],
  [82, 41],
  [86, 52],
  [91, 59],
  // Back out under the jaw: the overhang is what stops the head reading as an egg.
  [88, 65],
  [86, 72],
  [85, 80],
];

/** Outer shoulder -> down the arm -> fingertips -> back up the inner arm. */
const ARM: Point[] = [
  [80, 83],
  [68, 87],
  [56, 92],
  [44, 112],
  [36, 140],
  [28, 168],
  [21, 194],
  [16, 210],
  [19, 224],
  [33, 222],
  [38, 196],
  [44, 168],
  [50, 140],
  [56, 112],
  [66, 94],
];

/** Hip -> outer leg -> foot -> inner leg -> crotch, for a front view. */
const LEG_FRONT: Point[] = [
  [63, 228],
  [66, 258],
  [69, 288],
  [69, 306],
  [70, 332],
  [74, 362],
  [78, 392],
  [74, 410],
  [76, 424],
  [93, 425],
  [95, 410],
  [92, 392],
  [91, 360],
  [90, 308],
  [92, 268],
  [96, 240],
  [100, 222],
];

/** Same leg, but the foot reads as a heel seen from behind. */
const LEG_BACK: Point[] = [
  [63, 228],
  [66, 258],
  [69, 288],
  [69, 306],
  [70, 332],
  [74, 362],
  [78, 390],
  [76, 410],
  [79, 424],
  [93, 424],
  [95, 409],
  [92, 390],
  [91, 360],
  [90, 308],
  [92, 268],
  [96, 240],
  [100, 222],
];

/** Torso side between armpit and hip: chest, ribs, waist, hip flare. */
const TORSO_MALE: Point[] = [
  [67, 118],
  [69, 146],
  [72, 168],
  [68, 190],
  [63, 208],
];

const TORSO_FEMALE: Point[] = [
  [74, 120],
  [74, 146],
  [79, 170],
  [69, 192],
  [59, 210],
];

/** Female figure: slightly narrower shoulders and upper arms. */
const ARM_FEMALE: Point[] = [
  [80, 85],
  [70, 89],
  [59, 94],
  [47, 115],
  [39, 142],
  [31, 169],
  [24, 194],
  [19, 210],
  [22, 223],
  [36, 221],
  [41, 196],
  [47, 169],
  [53, 142],
  [59, 115],
  [69, 96],
];

const SILHOUETTE: Record<BodySide, Record<BodySex, readonly Point[]>> = {
  front: {
    male: [...HEAD_AND_NECK, ...ARM, ...TORSO_MALE, ...LEG_FRONT],
    female: [...HEAD_AND_NECK, ...ARM_FEMALE, ...TORSO_FEMALE, ...LEG_FRONT],
  },
  back: {
    male: [...HEAD_AND_NECK, ...ARM, ...TORSO_MALE, ...LEG_BACK],
    female: [...HEAD_AND_NECK, ...ARM_FEMALE, ...TORSO_FEMALE, ...LEG_BACK],
  },
};

const silhouetteCache = new Map<string, string>();

/** Full closed outline: the authored half plus its mirror, smoothed. */
export function silhouettePath(side: BodySide, sex: BodySex): string {
  const key = `${side}:${sex}`;
  const cached = silhouetteCache.get(key);
  if (cached) return cached;

  const half = SILHOUETTE[side][sex];
  // Drop both midline endpoints from the mirrored run so the loop closes cleanly.
  const other = mirrorX(half).reverse().slice(1, -1);
  const path = smoothClosedPath([...half, ...other]);
  silhouetteCache.set(key, path);
  return path;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/**
 * `base` is the zone id for unpaired regions, or the shared stem for paired
 * ones (`'thigh'` becomes `thigh_left` / `thigh_right`). Paired points are
 * authored on the patient's right; unpaired ones span the whole width.
 */
type RegionDef = {
  base: string;
  paired: boolean;
  points: readonly Point[];
  /** Corner rounding; lower for small regions so they keep their shape. */
  radius?: number;
};

/** Order matters: later regions win where two overlap after clipping. */
const FRONT_REGIONS: readonly RegionDef[] = [
  { base: 'head', paired: false, points: [[64, -16], [136, -16], [138, 60], [62, 60]] },
  { base: 'neck', paired: false, points: [[76, 58], [124, 58], [126, 86], [74, 86]] },
  { base: 'chest', paired: false, points: [[56, 80], [144, 80], [144, 150], [56, 150]] },
  { base: 'abdomen', paired: false, points: [[54, 148], [146, 148], [146, 198], [54, 198]] },
  { base: 'hip', paired: true, points: [[54, 196], [100, 196], [100, 230], [54, 230]] },
  { base: 'thigh', paired: true, points: [[46, 228], [100, 228], [100, 292], [46, 292]] },
  { base: 'knee', paired: true, points: [[48, 290], [100, 290], [100, 320], [48, 320]] },
  { base: 'lower_leg', paired: true, points: [[50, 318], [100, 318], [100, 382], [50, 382]] },
  { base: 'ankle', paired: true, points: [[54, 380], [100, 380], [100, 404], [54, 404]], radius: 4 },
  { base: 'foot', paired: true, points: [[52, 402], [100, 402], [100, 421], [52, 421]], radius: 4 },
  { base: 'toes', paired: true, points: [[52, 419], [100, 419], [100, 446], [52, 446]], radius: 4 },
  { base: 'shoulder', paired: true, points: [[38, 66], [82, 72], [82, 106], [44, 112]] },
  { base: 'upper_arm', paired: true, points: [[26, 104], [66, 104], [60, 142], [20, 142]] },
  { base: 'elbow', paired: true, points: [[16, 140], [60, 140], [56, 166], [12, 166]], radius: 4 },
  { base: 'forearm', paired: true, points: [[6, 164], [56, 164], [48, 198], [0, 198]] },
  { base: 'hand', paired: true, points: [[-8, 196], [48, 196], [48, 240], [-8, 240]] },
];

const BACK_REGIONS: readonly RegionDef[] = [
  { base: 'head', paired: false, points: [[64, -16], [136, -16], [138, 60], [62, 60]] },
  { base: 'neck', paired: false, points: [[76, 58], [124, 58], [126, 86], [74, 86]] },
  { base: 'upper_back', paired: false, points: [[56, 80], [144, 80], [144, 152], [56, 152]] },
  { base: 'lower_back', paired: false, points: [[54, 150], [146, 150], [146, 192], [54, 192]] },
  { base: 'buttock', paired: true, points: [[48, 190], [100, 190], [100, 236], [48, 236]] },
  { base: 'sacrum', paired: false, points: [[82, 186], [118, 186], [118, 222], [82, 222]] },
  { base: 'thigh', paired: true, points: [[46, 234], [100, 234], [100, 292], [46, 292]] },
  { base: 'knee', paired: true, points: [[48, 290], [100, 290], [100, 320], [48, 320]] },
  { base: 'lower_leg', paired: true, points: [[50, 318], [100, 318], [100, 382], [50, 382]] },
  { base: 'ankle', paired: true, points: [[54, 380], [100, 380], [100, 402], [54, 402]], radius: 4 },
  { base: 'heel', paired: true, points: [[52, 400], [100, 400], [100, 446], [52, 446]], radius: 4 },
  { base: 'shoulder', paired: true, points: [[38, 66], [82, 72], [82, 106], [44, 112]] },
  { base: 'upper_arm', paired: true, points: [[26, 104], [66, 104], [60, 142], [20, 142]] },
  { base: 'elbow', paired: true, points: [[16, 140], [60, 140], [56, 166], [12, 166]], radius: 4 },
  { base: 'forearm', paired: true, points: [[6, 164], [56, 164], [48, 198], [0, 198]] },
  { base: 'hand', paired: true, points: [[-8, 196], [48, 196], [48, 240], [-8, 240]] },
];

const REGIONS: Record<BodySide, readonly RegionDef[]> = {
  front: FRONT_REGIONS,
  back: BACK_REGIONS,
};

export type FigureRegion = { id: BodyZone; d: string };

const regionCache = new Map<BodySide, FigureRegion[]>();

/**
 * Resolve a view's regions, applying laterality.
 *
 * Anterior view: you face the patient, so their right side appears on your
 * left -- the authored half is drawn as-is. Posterior view: you stand behind
 * them, so their right side appears on your right -- the authored half is
 * mirrored. This boolean is the only place laterality is decided.
 */
export function regionsFor(side: BodySide): FigureRegion[] {
  const cached = regionCache.get(side);
  if (cached) return cached;

  const patientRightIsViewerLeft = side === 'front';
  const out: FigureRegion[] = [];

  for (const region of REGIONS[side]) {
    const radius = region.radius ?? 6;
    if (!region.paired) {
      out.push({ id: region.base as BodyZone, d: roundedPolygonPath(region.points, radius) });
      continue;
    }
    const authored = roundedPolygonPath(region.points, radius);
    const mirrored = roundedPolygonPath(mirrorX(region.points), radius);
    out.push(
      { id: `${region.base}_right` as BodyZone, d: patientRightIsViewerLeft ? authored : mirrored },
      { id: `${region.base}_left` as BodyZone, d: patientRightIsViewerLeft ? mirrored : authored },
    );
  }

  regionCache.set(side, out);
  return out;
}

/**
 * Where to draw the non-interactive L / R glyphs. They swap sides with the
 * view, which is the whole point -- it makes the mirroring visible.
 */
export const LR_GLYPHS: Record<BodySide, { left: Point; right: Point }> = {
  // Facing the patient: their left is on the viewer's right.
  front: { left: [176, 92], right: [24, 92] },
  // Behind the patient: their left is on the viewer's left.
  back: { left: [24, 92], right: [176, 92] },
};
