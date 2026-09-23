/**
 * Renders every body figure to an HTML page on stdout, so the silhouette and
 * region seams can be eyeballed without starting Metro.
 *
 *   node --experimental-strip-types scripts/preview-body.mts > /tmp/body.html
 *
 * Each region gets its own hue and a caption, so gaps, overlaps and
 * mislabelled sides are obvious at a glance. Writes nothing to the repo.
 */
import {
  FIGURE_VIEWBOX,
  LR_GLYPHS,
  regionsFor,
  silhouettePath,
  type BodySex,
} from '../src/constants/bodyFigure.ts';

type Side = 'front' | 'back';

const hue = (i: number, total: number) => `hsl(${Math.round((i / total) * 330)} 62% 72%)`;

function figure(side: Side, sex: BodySex): string {
  const regions = regionsFor(side);
  const outline = silhouettePath(side, sex);
  const clipId = `clip-${side}-${sex}`;
  const glyphs = LR_GLYPHS[side];

  const paths = regions
    .map(
      (r, i) =>
        `<path d="${r.d}" fill="${hue(i, regions.length)}" stroke="#ffffff" stroke-width="0.8"><title>${r.id}</title></path>`,
    )
    .join('\n      ');

  // Label each region at the centroid of its path bounding box, computed crudely
  // from the numbers in the d string -- good enough to spot a misplaced region.
  const labels = regions
    .map((r) => {
      const nums = (r.d.match(/-?\d+\.?\d*/g) ?? []).map(Number);
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      return `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="7" text-anchor="middle" fill="#0B2545">${r.id}</text>`;
    })
    .join('\n      ');

  return `
  <figure>
    <figcaption>${side} / ${sex}</figcaption>
    <svg viewBox="0 0 ${FIGURE_VIEWBOX.width} ${FIGURE_VIEWBOX.height}" width="300">
      <defs><clipPath id="${clipId}"><path d="${outline}"/></clipPath></defs>
      <g clip-path="url(#${clipId})">
      ${paths}
      </g>
      <path d="${outline}" fill="none" stroke="#0B2545" stroke-width="1.5"/>
      ${labels}
      <text x="${glyphs.left[0]}" y="${glyphs.left[1]}" font-size="16" font-weight="700" text-anchor="middle" fill="#627D98">L</text>
      <text x="${glyphs.right[0]}" y="${glyphs.right[1]}" font-size="16" font-weight="700" text-anchor="middle" fill="#627D98">R</text>
    </svg>
  </figure>`;
}

const sides: Side[] = ['front', 'back'];
const sexes: BodySex[] = ['male', 'female'];
const figures = sides.flatMap((side) => sexes.map((sex) => figure(side, sex))).join('\n');

process.stdout.write(`<!doctype html>
<meta charset="utf-8">
<title>Body figure preview</title>
<style>
  body { margin: 0; padding: 16px; background: #F7F9FC; font: 13px system-ui, sans-serif; }
  .row { display: flex; gap: 12px; align-items: flex-start; }
  figure { margin: 0; background: #fff; border: 1px solid #D8E0EA; border-radius: 12px; padding: 8px; }
  figcaption { font-weight: 700; color: #0B2545; text-align: center; padding-bottom: 4px; }
  svg { display: block; }
</style>
<div class="row">
${figures}
</div>
`);
