import jpeg from 'jpeg-js';

import { stripDataUri } from './_image';
import type { MaskPixels } from './_maskIO';

/**
 * The two crops the caged VLM sees besides the full photo (segmentation spec
 * §4.2): the wound bed, and the skin around it — both cut from the APPROVED
 * mask, so editing the outline changes what the model is shown.
 */

const MAX_CROP_EDGE = 768;

export type Crops = { wound: string; periwound: string };

function cropJpeg(
  rgba: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): string {
  const cw = x1 - x0;
  const ch = y1 - y0;
  // Nearest-neighbour downscale inside the crop if it is larger than needed.
  const scale = Math.min(1, MAX_CROP_EDGE / Math.max(cw, ch));
  const ow = Math.max(1, Math.round(cw * scale));
  const oh = Math.max(1, Math.round(ch * scale));
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y += 1) {
    const sy = y0 + Math.min(ch - 1, Math.floor(y / scale));
    for (let x = 0; x < ow; x += 1) {
      const sx = x0 + Math.min(cw - 1, Math.floor(x / scale));
      const s = (sy * width + sx) * 4;
      const d = (y * ow + x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = 255;
    }
  }
  return jpeg.encode({ data: out, width: ow, height: oh }, 88).data.toString('base64');
}

/**
 * Wound crop: the mask's bounding box plus 10%. Periwound crop: the box grown
 * by 75% of its own size each side — roughly the band a clinician inspects.
 * Null when the mask is empty.
 */
export function cropsFromMask(base64: string, mask: MaskPixels): Crops | null {
  const decoded = jpeg.decode(Buffer.from(stripDataUri(base64), 'base64'), { useTArray: true, maxMemoryUsageInMB: 512 });
  const { width, height, data } = decoded;

  let mx0 = mask.width;
  let my0 = mask.height;
  let mx1 = -1;
  let my1 = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.data[y * mask.width + x]) continue;
      if (x < mx0) mx0 = x;
      if (x > mx1) mx1 = x;
      if (y < my0) my0 = y;
      if (y > my1) my1 = y;
    }
  }
  if (mx1 < 0) return null;

  // Mask → image pixels (the mask may be on a different grid).
  const bx0 = (mx0 / mask.width) * width;
  const bx1 = ((mx1 + 1) / mask.width) * width;
  const by0 = (my0 / mask.height) * height;
  const by1 = ((my1 + 1) / mask.height) * height;
  const box = (grow: number) => {
    const gw = (bx1 - bx0) * grow;
    const gh = (by1 - by0) * grow;
    return [
      Math.max(0, Math.floor(bx0 - gw)),
      Math.max(0, Math.floor(by0 - gh)),
      Math.min(width, Math.ceil(bx1 + gw)),
      Math.min(height, Math.ceil(by1 + gh)),
    ] as const;
  };
  const [wx0, wy0, wx1, wy1] = box(0.1);
  const [px0, py0, px1, py1] = box(0.75);
  return {
    wound: cropJpeg(data, width, wx0, wy0, wx1, wy1),
    periwound: cropJpeg(data, width, px0, py0, px1, py1),
  };
}
