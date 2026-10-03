/**
 * Offline tests for measurement: which circle is the coin, and how two masks
 * compare (the correction log's IoU).
 * Run: npm run test:measure
 *
 * The coin tests reproduce the failure that motivated them: on the demo leg
 * ulcer, the first Hough circle was a phantom centred on the wound at twice the
 * coin's radius (84.5 px/cm vs a true 42.1), and the area came out ~4× too big
 * at "high" confidence. Every filter in `_coin.ts` is exercised against that
 * shape of scene: a real coin rim, phantoms around a round wound, and texture.
 *
 * No network, no OpenCV — `_coin.ts` and `_maskGeometry.ts` are import-free.
 */
import {
  chooseCoin,
  COIN_MIN_EDGE_SUPPORT,
  coinRadiusBounds,
  edgeSupport,
  overlapsMask,
  parseCircles,
  type Circle,
} from '../api/_coin.ts';
import { BOUNDARY_CHANGED_IOU, compareMasks, rasterisePolygon } from '../api/_maskGeometry.ts';
import { applyGains, gainsFromPatch, looksLikePatch } from '../api/_whiteBalance.ts';
import {
  breakdownFromBuffer,
  breakdownFromBufferRelative,
  classifyPixel,
  classifyPixelRelative,
  deltaE,
  medianLab,
  rgbToLab,
  type TissueBreakdown,
} from '../src/cv/tissueClassifier.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}
function near(name: string, actual: number | null, expected: number, tolerance: number) {
  check(name, actual !== null && Math.abs(actual - expected) <= tolerance, { actual, expected, tolerance });
}

// ---------------------------------------------------------------------------
// A synthetic scene on the analysis grid: 300 × 400, like a portrait photo.
// ---------------------------------------------------------------------------
const W = 300;
const H = 400;

/** Draw a circle's rim into an edge map (one pixel wide). */
function drawRim(edges: Uint8Array, c: Circle, fraction = 1) {
  const steps = 720;
  for (let k = 0; k < steps * fraction; k += 1) {
    const a = (2 * Math.PI * k) / steps;
    const x = Math.round(c.x + c.r * Math.cos(a));
    const y = Math.round(c.y + c.r * Math.sin(a));
    if (x >= 0 && y >= 0 && x < W && y < H) edges[y * W + x] = 255;
  }
}

/** Fill a disc into a mask. */
function fillDisc(mask: Uint8Array, c: Circle) {
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if ((x - c.x) ** 2 + (y - c.y) ** 2 <= c.r * c.r) mask[y * W + x] = 255;
    }
  }
}

const coin: Circle = { x: 70, y: 200, r: 24 };
const wound: Circle = { x: 200, y: 190, r: 40 };

const edges = new Uint8Array(W * H);
drawRim(edges, coin);
// The wound's own edge, which is what phantom circles are assembled from.
drawRim(edges, wound, 0.55);
const woundMask = new Uint8Array(W * H);
fillDisc(woundMask, wound);

// Hough's order on the demo photo: phantoms around the wound came FIRST.
const phantomOnWound: Circle = { x: 205, y: 185, r: 48 };
const phantomBig: Circle = { x: 150, y: 200, r: 70 };
const textureBlob: Circle = { x: 120, y: 330, r: 30 }; // nothing under its rim
const houghOrder = [phantomOnWound, phantomBig, textureBlob, coin];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
const bounds = coinRadiusBounds(W, H);
check('radius bounds are relative to the longer edge', bounds.minRadius === 6 && bounds.maxRadius === 80, bounds);

check(
  'parseCircles reads OpenCV [x,y,r]* packing and drops junk',
  JSON.stringify(parseCircles([1, 2, 3, 4, 5, 0, 7, 8, NaN, 9, 10, 11], 4)) === JSON.stringify([{ x: 1, y: 2, r: 3 }, { x: 9, y: 10, r: 11 }]),
);

near('a complete rim has full edge support', edgeSupport(coin, edges, W, H), 1, 0.02);
check('a circle over empty texture has ~no support', edgeSupport(textureBlob, edges, W, H) < 0.1);
check(
  'a phantom on the wound edge is well below the threshold',
  edgeSupport(phantomOnWound, edges, W, H) < COIN_MIN_EDGE_SUPPORT,
  edgeSupport(phantomOnWound, edges, W, H),
);

check('the coin does not touch the wound', overlapsMask(coin, woundMask, W, H) === false);
check('a phantom centred on the wound touches it', overlapsMask(phantomOnWound, woundMask, W, H) === true);
check(
  'the margin counts: a circle 3 px from the wound overlaps with a 5 px margin',
  overlapsMask({ x: wound.x - wound.r - 3 - 10, y: wound.y, r: 10 }, woundMask, W, H, 5) === true,
);

// ---------------------------------------------------------------------------
// The choice
// ---------------------------------------------------------------------------
const choice = chooseCoin(houghOrder, { edges, mask: woundMask, width: W, height: H });
check(
  'the coin is chosen even though Hough ranked three circles above it',
  choice !== null && choice.circle.x === coin.x && choice.circle.r === coin.r,
  choice?.circle,
);

const firstCircleWins = houghOrder[0];
check('regression: the old rule (first circle) would have picked the phantom', firstCircleWins === phantomOnWound);

// Without an outline (the legacy analyze pass), edge support alone still holds.
const noMask = chooseCoin(houghOrder, { edges, mask: null, width: W, height: H });
check('without a wound mask, edge support alone still finds the coin', noMask?.circle.x === coin.x);

// A coin-shaped rim INSIDE the wound outline is never the scale.
const edgesInside = new Uint8Array(edges);
const ringInWound: Circle = { x: 200, y: 190, r: 15 };
drawRim(edgesInside, ringInWound);
const inside = chooseCoin([ringInWound], { edges: edgesInside, mask: woundMask, width: W, height: H });
check('a perfect circle inside the wound is rejected', inside === null);

// No coin in the photo → null, never a guess.
const noCoinEdges = new Uint8Array(W * H);
drawRim(noCoinEdges, wound, 0.55);
check(
  'no coin in the scene → no scale',
  chooseCoin([phantomOnWound, phantomBig, textureBlob], { edges: noCoinEdges, mask: woundMask, width: W, height: H }) === null,
);

// Size bounds: a full rim that is far too big or too small is not a coin.
const edgesHuge = new Uint8Array(W * H);
const huge: Circle = { x: 150, y: 200, r: 120 };
drawRim(edgesHuge, huge);
check('a perfect but frame-sized circle is outside the radius bounds', chooseCoin([huge], { edges: edgesHuge, mask: null, width: W, height: H }) === null);

// A coin cut off by the frame edge loses support and is not trusted.
const clipped: Circle = { x: 5, y: 200, r: 24 };
const edgesClipped = new Uint8Array(W * H);
drawRim(edgesClipped, clipped);
check('a coin half out of frame is not a reliable scale', chooseCoin([clipped], { edges: edgesClipped, mask: null, width: W, height: H }) === null);

// ---------------------------------------------------------------------------
// Mask comparison (correction log IoU, spec §4.1)
// ---------------------------------------------------------------------------
const square = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
];
const aMask = { data: rasterisePolygon(square, 200, 300), width: 200, height: 300 };

const same = compareMasks(aMask, aMask, 200, 300);
near('identical masks: IoU 1', same.iou, 1, 1e-9);
near('identical masks: no area change', same.areaDeltaPct, 0, 1e-9);

// The same polygon rasterised on a different, square grid (as the mask endpoint
// does by default) must still compare as the same shape.
const bSquareGrid = { data: rasterisePolygon(square, 256, 256), width: 256, height: 256 };
near('same shape on a different grid: IoU ≈ 1', compareMasks(aMask, bSquareGrid, 200, 300).iou, 1, 0.02);

const shifted = [
  { x: 0.5, y: 0.25 },
  { x: 1, y: 0.25 },
  { x: 1, y: 0.75 },
  { x: 0.5, y: 0.75 },
];
const half = compareMasks(aMask, { data: rasterisePolygon(shifted, 200, 300), width: 200, height: 300 }, 200, 300);
near('half-overlapping squares: IoU 1/3', half.iou, 1 / 3, 0.02);
check('half-overlap is a changed boundary', (half.iou ?? 1) < BOUNDARY_CHANGED_IOU);

const grown = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.2, y: 0.8 },
];
const growth = compareMasks(aMask, { data: rasterisePolygon(grown, 200, 300), width: 200, height: 300 }, 200, 300);
near('growing the square from 0.5 to 0.6 a side: +44% area', growth.areaDeltaPct, 44, 2);

const empty = { data: new Uint8Array(200 * 300), width: 200, height: 300 };
check('two empty masks: IoU is null, not 0 or 1', compareMasks(empty, empty, 200, 300).iou === null);
check('empty draft: area delta is null', compareMasks(empty, aMask, 200, 300).areaDeltaPct === null);

// ---------------------------------------------------------------------------
// White balance (spec §5) — the acceptance test on a fixture image
// ---------------------------------------------------------------------------
// A 100 × 60 RGB fixture: a white reference patch on the left, a wound bed on
// the right made of borderline-orange granulation, slough and deep-red
// granulation. Then a warm light cast (R × 1.12, B × 0.75), as under a
// tungsten lamp.
const FW = 100;
const FH = 60;
const fixture = new Uint8Array(FW * FH * 3);
const woundBed = new Uint8Array(FW * FH);
const patch = new Uint8Array(FW * FH);
function paint(x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number], mark?: Uint8Array) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      fixture.set(rgb, (y * FW + x) * 3);
      if (mark) mark[y * FW + x] = 255;
    }
  }
}
paint(0, 0, FW, FH, [120, 120, 120]); // grey background
paint(5, 20, 25, 40, [220, 220, 220], patch); // white card
paint(40, 10, 70, 50, [200, 90, 60], woundBed); // orange-red granulation (hue ≈ 13°)
paint(70, 10, 85, 50, [200, 170, 90], woundBed); // slough
paint(85, 10, 95, 50, [170, 30, 40], woundBed); // deep-red granulation

const castBuffer = new Uint8Array(fixture.length);
for (let o = 0; o < fixture.length; o += 3) {
  castBuffer[o] = Math.min(255, Math.round(fixture[o] * 1.12));
  castBuffer[o + 1] = fixture[o + 1];
  castBuffer[o + 2] = Math.round(fixture[o + 2] * 0.75);
}

const l1 = (p: TissueBreakdown, q: TissueBreakdown) =>
  Math.abs(p.granulation - q.granulation) + Math.abs(p.slough - q.slough) + Math.abs(p.necrosis - q.necrosis) + Math.abs(p.epithelial - q.epithelial);

const truth = breakdownFromBuffer(fixture, 3, woundBed);
const castNoWb = breakdownFromBuffer(castBuffer, 3, woundBed);
const gains = gainsFromPatch(castBuffer, 3, patch);
check('a white patch under a warm cast yields gains', gains !== null, gains);
const castWb = gains ? breakdownFromBuffer(applyGains(castBuffer, 3, gains), 3, woundBed) : castNoWb;
check(
  'ACCEPTANCE: the warm cast moves the tissue mix less with white balance on than off',
  l1(truth, castWb) < l1(truth, castNoWb),
  { truth, castNoWb, castWb },
);
check('without white balance the cast turns granulation into slough', castNoWb.slough > truth.slough);
check('with white balance the dominant split is restored', Math.abs(castWb.granulation - truth.granulation) <= 2, { truth, castWb });
near('gains neutralise the patch: red is pulled down', gains?.r ?? 1, 0.855, 0.02);
near('…and blue pushed up', gains?.b ?? 1, 1.275, 0.02);

const blownOut = new Uint8Array(FW * FH * 3).fill(255);
check('a clipped (blown-out) patch gives no gains', gainsFromPatch(blownOut, 3, patch) === null);
const tiny = new Uint8Array(FW * FH);
tiny[0] = 255;
check('a patch below the minimum size gives no gains', gainsFromPatch(fixture, 3, tiny) === null);
check('a dark region is not a white patch', gainsFromPatch(fixture, 3, woundBed.map((v, i) => (i % FW < 40 ? 0 : v))) === null);

check('a card-sized rectangle looks like a patch', looksLikePatch({ areaFraction: 0.01, rectangularity: 0.95, aspect: 1.4 }));
check('a white sheet filling the background does not', !looksLikePatch({ areaFraction: 0.4, rectangularity: 0.9, aspect: 1.3 }));
check('a ragged highlight does not', !looksLikePatch({ areaFraction: 0.01, rectangularity: 0.5, aspect: 1.2 }));
check('a thin bandage edge does not', !looksLikePatch({ areaFraction: 0.01, rectangularity: 0.9, aspect: 6 }));

// ---------------------------------------------------------------------------
// Periwound-relative classification (spec §5, TISSUE_RELATIVE)
// ---------------------------------------------------------------------------
const tan: [number, number, number] = [196, 150, 120];
check('absolutely, tanned skin reads as slough (the demo-photo failure)', classifyPixel(...tan) === 'slough');
const skinLab = rgbToLab(...tan);
check('relative to the patient\'s own skin, it reads as skin ("other")', classifyPixelRelative(...tan, skinLab) === 'other');
check('real slough is still slough relative to tanned skin', classifyPixelRelative(200, 170, 90, skinLab) === 'slough');
check('granulation is still granulation', classifyPixelRelative(170, 30, 40, skinLab) === 'granulation');
near('Lab of white is L≈100, a≈0, b≈0', deltaE(rgbToLab(255, 255, 255), { L: 100, a: 0, b: 0 }), 0, 0.5);

const skinBuffer = new Uint8Array(40 * 3);
for (let i = 0; i < 40; i += 1) skinBuffer.set(i < 30 ? tan : [200, 170, 90], i * 3);
const all = new Uint8Array(40).fill(255);
const median = medianLab(skinBuffer, 3, all);
check('median skin colour ignores a minority of slough pixels', median !== null && deltaE(median, skinLab) < 1);
const rel = breakdownFromBufferRelative(skinBuffer, 3, all, skinLab);
check('relative breakdown drops the skin-coloured pixels from slough', rel.slough === 25 && rel.other === 75, rel);

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All measurement checks passed.');
