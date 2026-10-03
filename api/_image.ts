import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';

import { imageSize } from './_segmentationParse';

/**
 * The photo, as every server step sees it.
 *
 * Segmentation models get the image downscaled to 1024 px on its LONGER edge
 * (segmentation spec §3.1), matching the 1024 analysis grid the tissue step
 * uses. The app sends 1024 px WIDE, so a portrait photo arrives 1024 × 1371 and
 * must be shrunk again here; a landscape one passes through untouched.
 *
 * `sha256` is over the bytes the CALLER sent, so an approval can be bound to
 * exactly the image a clinician reviewed (spec §6A.1), whatever happens to it
 * on the way to a model.
 */

export const MAX_EDGE = 1024;

export type NormalisedImage = {
  /** JPEG base64 (no prefix) within MAX_EDGE. */
  base64: string;
  dataUrl: string;
  width: number;
  height: number;
  bytes: Uint8Array;
  /** SHA-256 of the caller's original bytes. */
  sha256: string;
};

export function stripDataUri(value: string): string {
  return value.replace(/^data:[^;,]*;base64,/, '');
}

export function imageSha256(base64OrDataUrl: string): string {
  return createHash('sha256').update(Buffer.from(stripDataUri(base64OrDataUrl), 'base64')).digest('hex');
}

/** Bilinear RGBA resize — enough for a one-off downscale before a model call. */
function resizeRgba(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = Math.min(1, Math.max(0, fy - y0));
    for (let x = 0; x < dw; x += 1) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = Math.min(1, Math.max(0, fx - x0));
      for (let c = 0; c < 4; c += 1) {
        const a = src[(y0 * sw + x0) * 4 + c];
        const b = src[(y0 * sw + x1) * 4 + c];
        const d = src[(y1 * sw + x0) * 4 + c];
        const e = src[(y1 * sw + x1) * 4 + c];
        out[(y * dw + x) * 4 + c] = Math.round((a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy);
      }
    }
  }
  return out;
}

/**
 * Downscale to MAX_EDGE on the longer edge. Images already within bounds are
 * returned byte-for-byte (no re-encode). Throws on an undecodable image — the
 * request validation layer turns that into a 400.
 */
export function normaliseImage(base64OrDataUrl: string): NormalisedImage {
  const raw = stripDataUri(base64OrDataUrl);
  const original = Uint8Array.from(Buffer.from(raw, 'base64'));
  const sha256 = createHash('sha256').update(original).digest('hex');
  const size = imageSize(original);
  if (!size) throw new Error('The image could not be read (expected a JPEG or PNG).');

  if (Math.max(size.width, size.height) <= MAX_EDGE) {
    return { base64: raw, dataUrl: `data:image/jpeg;base64,${raw}`, ...size, bytes: original, sha256 };
  }

  const decoded = jpeg.decode(Buffer.from(original), { useTArray: true, maxMemoryUsageInMB: 512 });
  const scale = MAX_EDGE / Math.max(decoded.width, decoded.height);
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const resized = resizeRgba(decoded.data, decoded.width, decoded.height, width, height);
  const encoded = jpeg.encode({ data: Buffer.from(resized), width, height }, 90);
  const base64 = encoded.data.toString('base64');
  return {
    base64,
    dataUrl: `data:image/jpeg;base64,${base64}`,
    width,
    height,
    bytes: Uint8Array.from(encoded.data),
    sha256,
  };
}
