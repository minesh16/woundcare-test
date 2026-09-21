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
