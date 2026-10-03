/**
 * Offline tests for mask ⇄ polygon geometry.
 * Run: npm run test:geometry
 *
 * The load-bearing test here is the ROUND TRIP: rasterise a known polygon, trace
 * it back, rasterise again, and check the two masks agree. That is what the
 * review screen actually does — the model's mask becomes an editable outline,
 * the clinician changes it, and it becomes the mask the tissue classifier
 * measures inside. A bug anywhere in that loop silently changes which pixels
 * count as wound, and every tissue percentage inherits it.
 *
 * No network. `api/_maskGeometry.ts` is import-free so it loads directly under
 * `node --experimental-strip-types`.
 */
import {
  countSet,
  largestComponent,
  MAX_POLYGON_POINTS,
  MIN_POLYGON_POINTS,
  polygonAreaFraction,
  rasterisePolygon,
  simplifyPolyline,
  traceContourPixels,
  traceOutline,
  validatePolygon,
  type MaskPoint,
} from '../api/_maskGeometry.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : { actual, expected });
}
function near(name: string, actual: number, expected: number, tolerance: number) {
  check(name, Math.abs(actual - expected) <= tolerance, { actual, expected, tolerance });
}

// ---------------------------------------------------------------------------
// Validation — this is caller-supplied data that decides which pixels are wound
// ---------------------------------------------------------------------------

const square: MaskPoint[] = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
];

eq('a valid square passes', validatePolygon(square), { ok: true });
check('a non-array is rejected', validatePolygon('nope').ok === false);
check('null is rejected', validatePolygon(null).ok === false);
check('two points cannot enclose an area', validatePolygon(square.slice(0, 2)).ok === false);
eq(
  `${MIN_POLYGON_POINTS} points is the minimum`,
  validatePolygon(square.slice(0, 3)),
  { ok: true },
);
check(
  'a point outside 0–1 is rejected (these are fractional, not pixels)',
  validatePolygon([...square.slice(0, 2), { x: 1.5, y: 0.5 }]).ok === false,
);
check('a negative coordinate is rejected', validatePolygon([...square.slice(0, 2), { x: -0.1, y: 0.5 }]).ok === false);
check('NaN is rejected', validatePolygon([...square.slice(0, 2), { x: NaN, y: 0.5 }]).ok === false);
check('a missing y is rejected', validatePolygon([...square.slice(0, 2), { x: 0.5 } as never]).ok === false);
check(
  'an absurd point count is rejected rather than rasterised',
  validatePolygon(Array.from({ length: MAX_POLYGON_POINTS + 1 }, () => ({ x: 0.5, y: 0.5 }))).ok === false,
);

// ---------------------------------------------------------------------------
// Area
// ---------------------------------------------------------------------------

near('a half-width square covers a quarter of the frame', polygonAreaFraction(square), 0.25, 1e-9);
eq('area is sign-independent (winding order must not matter)', polygonAreaFraction([...square].reverse()), polygonAreaFraction(square));
eq('two points have no area', polygonAreaFraction(square.slice(0, 2)), 0);

// ---------------------------------------------------------------------------
// polygon → mask
// ---------------------------------------------------------------------------

const W = 100;
const H = 100;
const squareMask = rasterisePolygon(square, W, H);
near('the rasterised square is a quarter of the pixels', countSet(squareMask) / (W * H), 0.25, 0.02);
check('a pixel inside is set', squareMask[50 * W + 50] === 255);
check('a pixel outside is clear', squareMask[10 * W + 10] === 0);
check('a pixel just outside the left edge is clear', squareMask[50 * W + 20] === 0);
eq('a degenerate polygon rasterises to nothing rather than throwing', countSet(rasterisePolygon(square.slice(0, 2), W, H)), 0);
eq('zero dimensions are handled', rasterisePolygon(square, 0, 0).length, 0);

// A concave shape is the real test of even-odd filling: a naive "fill between
// min and max x" would fill the notch that makes it concave.
const chevron: MaskPoint[] = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.5, y: 0.4 }, // the notch
  { x: 0.1, y: 0.9 },
];
const chevronMask = rasterisePolygon(chevron, W, H);
check('a concave shape fills its body', chevronMask[20 * W + 50] === 255);
check('…and leaves the notch empty', chevronMask[80 * W + 50] === 0);
check('…while filling either side of the notch', chevronMask[80 * W + 15] === 255 && chevronMask[80 * W + 85] === 255);

// ---------------------------------------------------------------------------
// Largest component — the model can return several regions
// ---------------------------------------------------------------------------

const twoBlobs = new Uint8Array(W * H);
for (let y = 10; y < 30; y += 1) for (let x = 10; x < 30; x += 1) twoBlobs[y * W + x] = 255; // 400 px
for (let y = 60; y < 90; y += 1) for (let x = 60; x < 90; x += 1) twoBlobs[y * W + x] = 255; // 900 px
const largest = largestComponent(twoBlobs, W, H);
eq('the larger of two regions is kept', largest.areaPx, 900);
check('…and the smaller one is dropped', largest.mask[20 * W + 20] === 0);
check('…while the larger survives', largest.mask[70 * W + 70] === 255);

const diagonalTouch = new Uint8Array(W * H);
diagonalTouch[10 * W + 10] = 255;
diagonalTouch[11 * W + 11] = 255;
eq('diagonal-only contact is two regions, not one (4-connectivity)', largestComponent(diagonalTouch, W, H).areaPx, 1);
eq('an empty mask has no component', largestComponent(new Uint8Array(W * H), W, H).areaPx, 0);

// ---------------------------------------------------------------------------
// Contour tracing
// ---------------------------------------------------------------------------

const traced = traceContourPixels(largest.mask, W, H);
check('the contour starts at the topmost-leftmost pixel', traced[0].x === 60 && traced[0].y === 60);
// A 30×30 block has 4×30 − 4 = 116 boundary pixels.
near('the contour length matches the perimeter of a 30×30 block', traced.length, 116, 6);
check('every contour pixel is inside the region', traced.every((p) => largest.mask[p.y * W + p.x] === 255));
eq('an empty mask traces to nothing', traceContourPixels(new Uint8Array(W * H), W, H), []);
eq('a single pixel traces to itself and terminates', traceContourPixels(diagonalTouch.slice(0, W * H).map((v, i) => (i === 10 * W + 10 ? 255 : 0)) as unknown as Uint8Array, W, H).length, 1);

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

const straightish: MaskPoint[] = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.001 },
  { x: 0.5, y: 0 },
  { x: 0.75, y: 0.001 },
  { x: 1, y: 0 },
];
eq('collinear-ish points collapse to the endpoints', simplifyPolyline(straightish, 0.01).length, 2);
eq('a real corner is kept', simplifyPolyline([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }], 0.01).length, 3);
eq('zero tolerance keeps everything', simplifyPolyline(straightish, 0).length, straightish.length);
eq('endpoints are always kept', simplifyPolyline(straightish, 10)[0], { x: 0, y: 0 });

// ---------------------------------------------------------------------------
// THE ROUND TRIP — the test that actually matters
// ---------------------------------------------------------------------------

function iou(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const inA = a[i] !== 0;
    const inB = b[i] !== 0;
    if (inA || inB) union += 1;
    if (inA && inB) intersection += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

for (const [name, polygon] of [
  ['square', square],
  ['concave chevron', chevron],
  [
    'blob',
    Array.from({ length: 24 }, (_, i) => {
      const t = (i / 24) * Math.PI * 2;
      return { x: 0.5 + 0.3 * Math.cos(t), y: 0.5 + 0.22 * Math.sin(t) };
    }),
  ],
] as [string, MaskPoint[]][]) {
  const size = 200;
  const original = rasterisePolygon(polygon, size, size);
  const outline = traceOutline(original, size, size);
  check(`${name}: an outline is recovered from the mask`, outline !== null && outline.length >= MIN_POLYGON_POINTS);
  if (!outline) continue;
  check(`${name}: the outline is editable (≤ ${MAX_POLYGON_POINTS} points)`, outline.length <= MAX_POLYGON_POINTS, outline.length);
  const reRasterised = rasterisePolygon(outline, size, size);
  const overlap = iou(original, reRasterised);
  // 0.98 (spec §3.4) is tight: the boundary a clinician edits is the boundary the
  // model drew, not an approximation that quietly moves the wound edge.
  check(`${name}: round-trip IoU ≥ 0.98 (spec §3.4)`, overlap >= 0.98, Number(overlap.toFixed(4)));
  check(`${name}: every outline point is in range`, outline.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
}

// Resolution independence: the polygon is fractional, so tracing at one size and
// rasterising at another must still land on the same shape. The review screen
// displays at one size and the measurement happens at another.
{
  const traceSize = 128;
  const measureSize = 512;
  const original = rasterisePolygon(square, traceSize, traceSize);
  const outline = traceOutline(original, traceSize, traceSize);
  check('a traced outline survives a 4× resolution change', outline !== null);
  if (outline) {
    const big = rasterisePolygon(outline, measureSize, measureSize);
    near('…covering the same fraction of the frame', countSet(big) / (measureSize * measureSize), 0.25, 0.02);
  }
}

eq('an empty mask yields no outline, so the UI offers "draw" instead', traceOutline(new Uint8Array(100), 10, 10), null);
eq('zero dimensions yield no outline', traceOutline(new Uint8Array(0), 0, 0), null);

// A mask of two blobs must trace the larger one only — a contour that jumped
// between blobs would enclose the healthy skin between them.
{
  const outline = traceOutline(twoBlobs, W, H);
  check('a two-region mask traces only the larger region', outline !== null);
  if (outline) {
    const re = rasterisePolygon(outline, W, H);
    check('…so the small blob is not enclosed', re[20 * W + 20] === 0);
    check('…and the large one is', re[75 * W + 75] === 255);
  }
}

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All mask-geometry checks passed.');
