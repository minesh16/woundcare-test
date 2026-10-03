type Rgb = { r: number; g: number; b: number };

function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) {
      h = ((gn - bn) / delta) % 6;
    } else if (max === gn) {
      h = (bn - rn) / delta + 2;
    } else {
      h = (rn - gn) / delta + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }

  const s = max === 0 ? 0 : delta / max;
  return { h, s: s * 255, v: max * 255 };
}

export type TissueBreakdown = {
  granulation: number;
  slough: number;
  necrosis: number;
  epithelial: number;
  other: number;
};

export function classifyPixel(r: number, g: number, b: number): keyof TissueBreakdown {
  const { h, s, v } = rgbToHsv({ r, g, b });

  if (v < 45 && s < 80) {
    return 'necrosis';
  }

  // Epithelialising tissue: pale-pink new skin — high brightness, low/moderate
  // saturation, red/pink hue. Checked before slough/granulation so brighter,
  // washed-out pink edges aren't miscounted as (more-saturated) granulation.
  if (v > 170 && s > 20 && s < 95 && (h <= 25 || h >= 330)) {
    return 'epithelial';
  }

  if (h >= 15 && h <= 45 && s > 35 && v > 40) {
    return 'slough';
  }

  if ((h <= 15 || h >= 165) && s > 25 && v > 35) {
    return 'granulation';
  }

  if (h >= 0 && h <= 20 && s > 40 && v > 30) {
    return 'granulation';
  }

  return 'other';
}

export function breakdownFromBuffer(
  buffer: Uint8Array,
  channels: number,
  woundMask?: Uint8Array,
): TissueBreakdown {
  const counts: TissueBreakdown = { granulation: 0, slough: 0, necrosis: 0, epithelial: 0, other: 0 };
  const pixelCount = buffer.length / channels;
  let considered = 0;

  for (let i = 0; i < pixelCount; i += 1) {
    if (woundMask && woundMask[i] === 0) {
      continue;
    }

    const offset = i * channels;
    const label = classifyPixel(buffer[offset], buffer[offset + 1], buffer[offset + 2]);
    counts[label] += 1;
    considered += 1;
  }

  if (considered === 0) {
    return { granulation: 20, slough: 20, necrosis: 20, epithelial: 20, other: 20 };
  }

  return {
    granulation: Math.round((counts.granulation / considered) * 100),
    slough: Math.round((counts.slough / considered) * 100),
    necrosis: Math.round((counts.necrosis / considered) * 100),
    epithelial: Math.round((counts.epithelial / considered) * 100),
    other: Math.round((counts.other / considered) * 100),
  };
}

export function toPercentages(breakdown: TissueBreakdown) {
  const total =
    breakdown.granulation +
      breakdown.slough +
      breakdown.necrosis +
      breakdown.epithelial +
      breakdown.other || 1;

  return {
    granulationPercent: Math.round((breakdown.granulation / total) * 100),
    sloughPercent: Math.round((breakdown.slough / total) * 100),
    necrosisPercent: Math.round((breakdown.necrosis / total) * 100),
    epithelialPercent: Math.round((breakdown.epithelial / total) * 100),
    otherPercent: Math.round((breakdown.other / total) * 100),
  };
}

/**
 * Periwound skin classes (Mölnlycke step 5 — the 4 cm band around the edge).
 *
 * Deliberately coarse: the deterministic engine only consumes "how much of the
 * ring reads as red" and "is the ring waterlogged", and a caged VLM pass
 * corroborates both. Anything finer would be over-claiming from HSV.
 */
export type PeriwoundClass = 'red' | 'macerated' | 'normal';

export function classifyPeriwoundPixel(r: number, g: number, b: number): PeriwoundClass {
  const { h, s, v } = rgbToHsv({ r, g, b });

  // Erythema: saturated red/pink hue at normal-to-bright value.
  if ((h <= 20 || h >= 340) && s > 70 && v > 60) {
    return 'red';
  }

  // Maceration: soggy skin goes pale and desaturated but stays bright.
  if (v > 180 && s < 40) {
    return 'macerated';
  }

  return 'normal';
}

// ===========================================================================
// Periwound-relative classification (segmentation spec §5, behind TISSUE_RELATIVE)
//
// The absolute HSV thresholds read tanned or pigmented skin as slough — the
// demo leg's own skin did exactly that inside the HSV mask. Comparing each
// wound-bed pixel with THIS patient's surrounding skin removes that failure
// mode: a pixel indistinguishable from the periwound skin is not tissue, it is
// skin the outline happened to include. Everything else is classified by the
// absolute thresholds as before.
// ===========================================================================

export type Lab = { L: number; a: number; b: number };

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0–255) → CIELAB (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 colour difference. */
export function deltaE(p: Lab, q: Lab): number {
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

/** Median Lab of the masked pixels — the patient's own skin colour. Null when empty. */
export function medianLab(buffer: Uint8Array, channels: number, mask: Uint8Array): Lab | null {
  const Ls: number[] = [];
  const as: number[] = [];
  const bs: number[] = [];
  const pixels = buffer.length / channels;
  // Every 4th pixel is plenty for a median and keeps this cheap.
  for (let i = 0; i < pixels; i += 4) {
    if (!mask[i]) continue;
    const o = i * channels;
    const lab = rgbToLab(buffer[o], buffer[o + 1], buffer[o + 2]);
    Ls.push(lab.L);
    as.push(lab.a);
    bs.push(lab.b);
  }
  if (Ls.length === 0) return null;
  const median = (v: number[]) => {
    v.sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  };
  return { L: median(Ls), a: median(as), b: median(bs) };
}

/** ΔE below which a pixel is treated as the surrounding skin, not tissue. */
export const SKIN_DELTA_E = 12;

export function classifyPixelRelative(r: number, g: number, b: number, skin: Lab): keyof TissueBreakdown {
  if (deltaE(rgbToLab(r, g, b), skin) < SKIN_DELTA_E) return 'other';
  return classifyPixel(r, g, b);
}

export function breakdownFromBufferRelative(
  buffer: Uint8Array,
  channels: number,
  woundMask: Uint8Array,
  skin: Lab,
): TissueBreakdown {
  const counts: TissueBreakdown = { granulation: 0, slough: 0, necrosis: 0, epithelial: 0, other: 0 };
  const pixelCount = buffer.length / channels;
  let considered = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    if (woundMask[i] === 0) continue;
    const o = i * channels;
    counts[classifyPixelRelative(buffer[o], buffer[o + 1], buffer[o + 2], skin)] += 1;
    considered += 1;
  }
  if (considered === 0) return { granulation: 20, slough: 20, necrosis: 20, epithelial: 20, other: 20 };
  const pct = (n: number) => Math.round((n / considered) * 100);
  return {
    granulation: pct(counts.granulation),
    slough: pct(counts.slough),
    necrosis: pct(counts.necrosis),
    epithelial: pct(counts.epithelial),
    other: pct(counts.other),
  };
}
