import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

/**
 * Reading and writing masks — the one place a mask reference becomes pixels.
 *
 * Masks arrive as data URIs (SAM 3 with `sync_mode`, FUSegNet, the polygon
 * rasteriser) or, with `SAM3_SYNC_MODE=false`, as fal CDN URLs. Anything else is
 * refused: fetching an arbitrary caller-supplied URL from the server is SSRF
 * (docs/SECURITY_AUDIT.md MW-04), and every caller already treats "could not
 * read the mask" as a normal, degradable outcome.
 */

/** Hosts a mask may be fetched from, over https only. */
const MASK_HOST_SUFFIXES = ['.fal.media'];
const MASK_HOSTS = new Set(['fal.media']);

export function isAllowedMaskUrl(source: string): boolean {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return MASK_HOSTS.has(host) || MASK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Decode a mask PNG from a data URI or an allow-listed https URL. Null on any failure. */
export async function decodeMaskPng(source: string): Promise<PNG | null> {
  try {
    let buffer: Buffer;
    if (source.startsWith('data:')) {
      buffer = Buffer.from(source.replace(/^data:[^;,]*;base64,/, ''), 'base64');
    } else {
      if (!isAllowedMaskUrl(source)) {
        console.warn('Refusing to fetch a mask from an unapproved host.');
        return null;
      }
      const response = await fetch(source, { redirect: 'error' });
      if (!response.ok) return null;
      buffer = Buffer.from(await response.arrayBuffer());
    }
    return PNG.sync.read(buffer);
  } catch {
    return null;
  }
}

function isSet(data: Buffer, idx: number): boolean {
  // pngjs normalises to RGBA. A binary mask is white-on-black (opaque) or an
  // alpha cutout; a pixel is "in the mask" when it is opaque and bright.
  if (data[idx + 3] <= 127) return false;
  return (data[idx] + data[idx + 1] + data[idx + 2]) / 3 > 127;
}

export type MaskPixels = {
  /** One byte per pixel, 0 or 255. */
  data: Uint8Array;
  width: number;
  height: number;
  areaPx: number;
  totalPx: number;
};

/** Decode a mask to flat 0/255 pixels plus its area. */
export async function loadMaskPixels(source: string): Promise<MaskPixels | null> {
  const png = await decodeMaskPng(source);
  if (!png) return null;
  const totalPx = png.width * png.height;
  const data = new Uint8Array(totalPx);
  let areaPx = 0;
  for (let i = 0; i < totalPx; i += 1) {
    if (isSet(png.data, i * 4)) {
      data[i] = 255;
      areaPx += 1;
    }
  }
  return { data, width: png.width, height: png.height, areaPx, totalPx };
}

/** Nearest-neighbour resample of a mask onto another grid, by fractional position. */
export function resampleMask(mask: MaskPixels, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(mask.height - 1, Math.floor((y / height) * mask.height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(mask.width - 1, Math.floor((x / width) * mask.width));
      out[y * width + x] = mask.data[sy * mask.width + sx] ? 255 : 0;
    }
  }
  return out;
}

/** Encode a 0/255 single-channel mask as a white-on-black PNG data URI. */
export function toPngDataUri(mask: Uint8Array, width: number, height: number): string {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const on = mask[i] !== 0 ? 255 : 0;
    const o = i * 4;
    png.data[o] = on;
    png.data[o + 1] = on;
    png.data[o + 2] = on;
    // Opaque everywhere: consumers test brightness AND alpha, and a transparent
    // "outside" would read as outside twice rather than once.
    png.data[o + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

/**
 * SHA-256 of a mask's PIXELS (dimensions + 0/1 per pixel), not of its encoding.
 * The same boundary as a fal URL, a data URI or a re-encoded PNG hashes the
 * same — which is what an approval binding needs (spec §6A.1).
 */
export function maskSha256(mask: MaskPixels): string {
  const hash = createHash('sha256');
  hash.update(`${mask.width}x${mask.height}:`);
  const bits = new Uint8Array(mask.data.length);
  for (let i = 0; i < mask.data.length; i += 1) bits[i] = mask.data[i] ? 1 : 0;
  hash.update(bits);
  return hash.digest('hex');
}
