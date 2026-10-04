/**
 * Image and mask I/O (spec §9.1–§9.2, §24 "EXIF orientation", "Palette masks").
 *
 * The app's own functions do the parts that must match the app byte for byte:
 * `imageSha256` and `normaliseImage` (api/_image.ts), `resampleMask` and
 * `toPngDataUri` (api/_maskIO.ts), `imageSize` (api/_segmentationParse.ts).
 * What is here is only what the app never needed: EXIF orientation, PNG input,
 * dHash and dataset mask decoding.
 *
 * Why PNG and EXIF are handled here: the app's server steps decode JPEG only
 * (`jpeg-js`), and the app's client always uploads an already-oriented JPEG. A
 * dataset image is therefore oriented and, if it is not a plain JPEG, re-encoded
 * as one before `normaliseImage` — the same shape of input the app receives.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { imageSha256, normaliseImage, type NormalisedImage } from '../../api/_image';
import { resampleMask, toPngDataUri, type MaskPixels } from '../../api/_maskIO';
import { imageSize } from '../../api/_segmentationParse';

export { imageSha256, normaliseImage, resampleMask, toPngDataUri, imageSize };
export type { NormalisedImage, MaskPixels };

export type Rgba = { data: Uint8Array; width: number; height: number };

export type ImageFormat = 'jpeg' | 'png' | 'other';

export function detectFormat(bytes: Uint8Array): ImageFormat {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return 'other';
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Filesystem-safe form of an item key (keys are relative paths). */
export function safeKey(key: string): string {
  return key.replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9._@-]/g, '_');
}

// ---------------------------------------------------------------------------
// EXIF orientation
// ---------------------------------------------------------------------------

/** The EXIF Orientation tag (1–8) of a JPEG, or 1 when absent or unreadable. */
export function exifOrientation(bytes: Uint8Array): number {
  if (detectFormat(bytes) !== 'jpeg') return 1;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker === 0xda || marker === 0xd9) return 1; // start of scan / end: no EXIF before the image data
    if (marker === 0xe1 && length >= 8) {
      const start = offset + 4;
      const header = String.fromCharCode(...bytes.subarray(start, start + 4));
      if (header === 'Exif') return readTiffOrientation(bytes, start + 6);
    }
    offset += 2 + length;
  }
  return 1;
}

function readTiffOrientation(bytes: Uint8Array, tiff: number): number {
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const u16 = (o: number) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
  const u32 = (o: number) =>
    little
      ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (tiff + 8 > bytes.length) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > bytes.length) return 1;
  const entries = u16(ifd);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > bytes.length) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** Apply an EXIF orientation to a pixel buffer with `channels` bytes per pixel. */
export function applyOrientation<T extends { data: Uint8Array; width: number; height: number }>(
  img: T,
  orientation: number,
  channels = 4,
): { data: Uint8Array; width: number; height: number } {
  if (orientation <= 1 || orientation > 8) return { data: img.data, width: img.width, height: img.height };
  const { width: w, height: h } = img;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8Array(ow * oh * channels);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2: dx = w - 1 - x; dy = y; break;
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;
        case 4: dx = x; dy = h - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = h - 1 - y; dy = x; break;
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;
        default: dx = y; dy = w - 1 - x; break; // 8
      }
      const s = (y * w + x) * channels;
      const d = (dy * ow + dx) * channels;
      for (let c = 0; c < channels; c += 1) out[d + c] = img.data[s + c];
    }
  }
  return { data: out, width: ow, height: oh };
}

// ---------------------------------------------------------------------------
// Decode / encode
// ---------------------------------------------------------------------------

export function decodeImage(bytes: Uint8Array): Rgba {
  const format = detectFormat(bytes);
  if (format === 'jpeg') {
    const d = jpeg.decode(Buffer.from(bytes), { useTArray: true, maxMemoryUsageInMB: 1024 });
    return { data: d.data, width: d.width, height: d.height };
  }
  if (format === 'png') {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { data: Uint8Array.from(png.data), width: png.width, height: png.height };
  }
  throw new Error('Unsupported image format (expected JPEG or PNG).');
}

export function encodeJpeg(img: Rgba, quality = 95): Uint8Array {
  return Uint8Array.from(jpeg.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, quality).data);
}

export type PreparedImage = {
  normalised: NormalisedImage;
  orientation: number;
  format: ImageFormat;
  rawSize: { width: number; height: number };
  orientedSize: { width: number; height: number };
  /** True when the harness re-encoded the image (PNG input or EXIF rotation). */
  reencoded: boolean;
  /** The oriented RGBA at its original resolution (for dHash). */
  oriented: Rgba;
};

/**
 * Original file bytes → the analysis image the app would see.
 * A plain, upright JPEG goes to `normaliseImage` untouched, exactly as an
 * upload would; anything else is oriented and re-encoded as JPEG first.
 */
export function prepareImage(bytes: Uint8Array): PreparedImage {
  const format = detectFormat(bytes);
  if (format === 'other') throw new Error('Unsupported image format (expected JPEG or PNG).');
  const orientation = exifOrientation(bytes);
  const raw = decodeImage(bytes);
  const oriented = orientation === 1 ? raw : { ...applyOrientation(raw, orientation, 4) };
  const reencoded = format !== 'jpeg' || orientation !== 1;
  const source = reencoded ? encodeJpeg(oriented, 95) : bytes;
  const normalised = normaliseImage(Buffer.from(source).toString('base64'));
  return {
    normalised,
    orientation,
    format,
    rawSize: { width: raw.width, height: raw.height },
    orientedSize: { width: oriented.width, height: oriented.height },
    reencoded,
    oriented,
  };
}

// ---------------------------------------------------------------------------
// dHash (near-duplicate detection, spec §7.8, §9.6)
// ---------------------------------------------------------------------------

/** 64-bit difference hash as 16 hex chars: 9×8 area-averaged grey, adjacent comparisons. */
export function dHash(img: Rgba): string {
  const W = 9;
  const H = 8;
  const grey = new Float64Array(W * H);
  const counts = new Float64Array(W * H);
  for (let y = 0; y < img.height; y += 1) {
    const gy = Math.min(H - 1, Math.floor((y * H) / img.height));
    for (let x = 0; x < img.width; x += 1) {
      const gx = Math.min(W - 1, Math.floor((x * W) / img.width));
      const o = (y * img.width + x) * 4;
      grey[gy * W + gx] += 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
      counts[gy * W + gx] += 1;
    }
  }
  for (let i = 0; i < grey.length; i += 1) grey[i] /= counts[i] || 1;
  let hex = '';
  for (let y = 0; y < H; y += 1) {
    let byte = 0;
    for (let x = 0; x < 8; x += 1) byte = (byte << 1) | (grey[y * W + x] > grey[y * W + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

export function maskPixelsFrom(data: Uint8Array, width: number, height: number): MaskPixels {
  let areaPx = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i]) areaPx += 1;
  return { data, width, height, areaPx, totalPx: width * height };
}

/**
 * Decode a dataset's binary mask: a pixel is set when its brightest channel
 * exceeds `threshold` (and it is not transparent). `threshold` comes from the
 * manifest, because some datasets store 0/1 rather than 0/255.
 */
export function decodeBinaryMask(bytes: Uint8Array, threshold = 127): MaskPixels {
  const img = decodeImage(bytes);
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i += 1) {
    const o = i * 4;
    const v = Math.max(img.data[o], img.data[o + 1], img.data[o + 2]);
    data[i] = img.data[o + 3] > 0 && v > threshold ? 255 : 0;
  }
  return maskPixelsFrom(data, img.width, img.height);
}

/** Parse a palette key: a pixel value ("3", grey) or an RGB hex ("#ff0000"). */
export function parsePaletteKey(key: string | number): [number, number, number] {
  const s = String(key).trim();
  if (s.startsWith('#') && s.length === 7) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Bad palette key "${s}" (expected a pixel value or #rrggbb).`);
  return [n, n, n];
}

export type PaletteDecode = {
  width: number;
  height: number;
  /** Per-class 0/255 masks, keyed by the palette's class names. */
  classes: Record<string, Uint8Array>;
  /** Share of pixels that matched no palette entry exactly and were snapped (spec §24). */
  snappedRate: number;
};

/**
 * Decode a palette tissue mask: snap every pixel to the nearest palette entry
 * (a JPEG-compressed mask has stray values) and report how many needed it.
 * Entries mapped to `background` (or `_background`) are not classes.
 */
export function decodePaletteMask(bytes: Uint8Array, palette: Record<string, string>): PaletteDecode {
  const img = decodeImage(bytes);
  const entries = Object.entries(palette).map(([key, cls]) => ({ rgb: parsePaletteKey(key), cls }));
  if (entries.length === 0) throw new Error('Empty tissueMaskMap.');
  const classes: Record<string, Uint8Array> = {};
  for (const e of entries) if (!/^_?background$/i.test(e.cls)) classes[e.cls] ??= new Uint8Array(img.width * img.height);
  let snapped = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const o = i * 4;
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < entries.length; k += 1) {
      const [pr, pg, pb] = entries[k].rgb;
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (bestD > 0) snapped += 1;
    const target = classes[entries[best].cls];
    if (target) target[i] = 255;
  }
  return { width: img.width, height: img.height, classes, snappedRate: snapped / (img.width * img.height) };
}

/** Unique colours in an image with their pixel share, most common first (profiler). */
export function colourHistogram(bytes: Uint8Array, limit = 32): { value: string; share: number }[] {
  const img = decodeImage(bytes);
  const counts = new Map<string, number>();
  const n = img.width * img.height;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    const key = r === g && g === b ? String(r) : `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.size > 4096) break; // a photograph, not a mask
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, c]) => ({ value, share: c / n }));
}

/** Resample a mask onto the analysis grid with the APP's nearest-neighbour resampler. */
export function toGrid(mask: MaskPixels, width: number, height: number): Uint8Array {
  if (mask.width === width && mask.height === height) return mask.data;
  return resampleMask(mask, width, height);
}

/** Write a 0/255 mask as an 8-bit greyscale PNG. */
export function writeMaskPng(path: string, data: Uint8Array, width: number, height: number): void {
  const png = new PNG({ width, height, colorType: 0, inputColorType: 0, bitDepth: 8, inputHasAlpha: false });
  png.data = Buffer.from(data.map((v) => (v ? 255 : 0)));
  writeFileSync(path, PNG.sync.write(png, { colorType: 0, inputColorType: 0, bitDepth: 8, inputHasAlpha: false }));
}

/** Read a mask PNG written by `writeMaskPng` (or any binary PNG) back to 0/255 pixels. */
export function readMaskPng(path: string): MaskPixels {
  return decodeBinaryMask(readFileSync(path), 127);
}

/** A 0/255 mask as the PNG data URI the app's steps accept. */
export function maskDataUri(data: Uint8Array, width: number, height: number): string {
  return toPngDataUri(data, width, height);
}
