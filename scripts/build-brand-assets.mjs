/**
 * Renders the app's icon, splash, favicon and Android adaptive-icon layers from
 * the MendWise sutured-seam mark (assets/brand/logo-mark-*.svg).
 * Run: node scripts/build-brand-assets.mjs
 *
 * One-off, re-runnable. `sharp` is borrowed from docs-site/node_modules so the
 * app does not take on a native image dependency just to build its icons.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharp = createRequire(join(root, 'docs-site', 'package.json'))('sharp');

const GALAXY = '#081F5C';
const WHITE = '#FFFFFF';

/** The mark's paths in its own 48×48 box (from the design system's logo-mark SVGs). */
const markPaths = (ink) => `
  <g transform="rotate(-40 24 24)">
    <path d="M4 24H44" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M12 19V29M20 15V33M28 15V33M36 19V29" stroke="${ink}" stroke-width="3.25" stroke-linecap="round"/>
  </g>`;

const markSvg = (ink, size = null) =>
  `<svg ${size ? `width="${size}" height="${size}" ` : ''}viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" fill="none">${markPaths(ink)}\n</svg>\n`;

/**
 * A square canvas with the mark centred at `scale` of its width, on an optional
 * background (rounded by `radius`, as a fraction of the size).
 */
function canvasSvg({ size, ink, scale, background = null, radius = 0 }) {
  const markSize = size * scale;
  const offset = (size - markSize) / 2;
  const bg = background
    ? `<rect width="${size}" height="${size}" rx="${size * radius}" fill="${background}"/>`
    : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" fill="none">
  ${bg}
  <g transform="translate(${offset} ${offset}) scale(${markSize / 48})">${markPaths(ink)}</g>
</svg>`;
}

async function png(file, svg) {
  const out = join(root, file);
  mkdirSync(dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log('wrote', file);
}

// Source marks, without the provenance metadata blob the design export carries.
mkdirSync(join(root, 'assets/brand'), { recursive: true });
writeFileSync(join(root, 'assets/brand/logo-mark-dark.svg'), markSvg(GALAXY));
writeFileSync(join(root, 'assets/brand/logo-mark-light.svg'), markSvg(WHITE));
console.log('wrote assets/brand/logo-mark-{dark,light}.svg');

// iOS masks the corners itself, so the icon is full-bleed.
await png('assets/images/icon.png', canvasSvg({ size: 1024, ink: WHITE, scale: 0.62, background: GALAXY }));
// The splash supplies the navy background; the image is the mark alone.
await png('assets/images/splash-icon.png', canvasSvg({ size: 512, ink: WHITE, scale: 1 }));
await png('assets/images/favicon.png', canvasSvg({ size: 48, ink: WHITE, scale: 0.72, background: GALAXY, radius: 0.18 }));
// Android adaptive icon: the mark stays inside the central 66% safe zone.
await png('assets/images/android-icon-foreground.png', canvasSvg({ size: 512, ink: WHITE, scale: 0.46 }));
await png('assets/images/android-icon-background.png', canvasSvg({ size: 512, ink: WHITE, scale: 0, background: GALAXY }));
await png('assets/images/android-icon-monochrome.png', canvasSvg({ size: 432, ink: WHITE, scale: 0.46 }));
// iOS Icon Composer layer: the white mark, centred on the solid Galaxy fill.
// Composer sizes a layer by the SVG's own width/height in points on a 1024pt
// canvas, so the mark is given an explicit size (about 62%, as icon.png).
writeFileSync(join(root, 'assets/expo.icon/Assets/mendwise-mark.svg'), markSvg(WHITE, 640));
console.log('wrote assets/expo.icon/Assets/mendwise-mark.svg');
