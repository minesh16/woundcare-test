/**
 * Canonical vocabulary (spec §5.1, §5.3). Every dataset maps INTO these enums;
 * every prediction is expressed in them, so scorers never need dataset code.
 */
import { reconcileTissue, TISSUE_PRESENCE_THRESHOLD } from '../../src/decision/engine';
import type { TissueType } from '../../src/decision/engine.types';

export const WOUND_TYPES = ['diabetic_foot', 'venous', 'arterial', 'pressure', 'surgical', 'traumatic', 'burn', 'other'] as const;
export const TISSUE_CLASSES = ['granulation', 'slough', 'necrotic', 'epithelial', 'other'] as const; // % classes
export const DOMINANT_TISSUE = ['necrotic', 'slough', 'granulating', 'epithelialising'] as const; // = ClinicianTissueChoice
export const EXUDATE = ['low', 'moderate', 'high'] as const; // engine ExudateLevel
export const YES_NO = ['yes', 'no'] as const;
export const SKIN_TONE_SCALE = ['monk', 'fitzpatrick', 'ita_proxy'] as const;
export const PROVENANCE = ['expert', 'crowd', 'derived', 'synthetic'] as const;

export type WoundType = (typeof WOUND_TYPES)[number];
export type TissueClass = (typeof TISSUE_CLASSES)[number];
export type DominantTissue = (typeof DOMINANT_TISSUE)[number];
export type TissuePct = Record<TissueClass, number>;

export { TISSUE_PRESENCE_THRESHOLD };

/**
 * Tissue-class synonyms the label maps need (spec §5.1). Applied after a
 * dataset's own labelMap, so a manifest can still say otherwise.
 */
export const TISSUE_SYNONYMS: Record<string, TissueClass> = {
  granulation: 'granulation',
  granulating: 'granulation',
  slough: 'slough',
  fibrin: 'slough',
  yellow: 'slough',
  necrotic: 'necrotic',
  necrosis: 'necrotic',
  eschar: 'necrotic',
  black: 'necrotic',
  epithelial: 'epithelial',
  epithelialising: 'epithelial',
  epithelialization: 'epithelial',
  callus: 'other',
  hyperkeratosis: 'other',
  bone: 'other',
  tendon: 'other',
  other: 'other',
};

export type Mapped<T> = { value: T } | { unmapped: unknown };

const norm = (v: unknown) => String(v).trim().toLowerCase();

/**
 * Map one raw label onto a canonical value (spec §5.3). Case-insensitive,
 * whitespace-trimmed. A value with no mapping comes back as `{ unmapped }` —
 * it is counted and reported, never coerced.
 *
 * `allowed` is the canonical enum for the field, when it has one: a raw value
 * that already IS a canonical value maps to itself.
 */
export function mapLabel<T extends string>(
  field: string,
  raw: unknown,
  labelMap: Record<string, Record<string, unknown>> | undefined,
  allowed?: readonly T[],
): Mapped<T> {
  if (raw === null || raw === undefined || norm(raw) === '') return { unmapped: raw };
  const table = labelMap?.[field];
  if (table) {
    const hit = Object.entries(table).find(([k]) => norm(k) === norm(raw));
    if (hit) return { value: hit[1] as T };
  }
  if (allowed) {
    const self = allowed.find((a) => a === norm(raw));
    if (self) return { value: self };
  }
  return { unmapped: raw };
}

/** True when `labelMap._ignore` lists this raw value for this field, with a reason. */
export function isIgnored(field: string, raw: unknown, labelMap: Record<string, Record<string, unknown>> | undefined): boolean {
  const ignore = labelMap?._ignore as Record<string, unknown> | undefined;
  const list = ignore?.[field];
  if (!list || typeof list !== 'object') return false;
  return Object.keys(list as Record<string, unknown>).some((k) => norm(k) === norm(raw));
}

/** Engine tissue axis → the four-way dominant-tissue vocabulary. */
export function dominantFromAxis(tissue: TissueType | null | undefined): DominantTissue | null {
  if (!tissue) return null;
  return tissue === 'necrotic_ischaemic' ? 'necrotic' : tissue;
}

/**
 * Dominant tissue from percentages, by THE ENGINE'S OWN precedence (spec §5.3),
 * so ground truth and prediction share one definition. Not re-implemented:
 * this calls `reconcileTissue` directly.
 */
export function dominantFromPct(pct: TissuePct): DominantTissue | null {
  const { tissueType } = reconcileTissue({
    necrosis: pct.necrotic,
    slough: pct.slough,
    granulation: pct.granulation,
    epithelial: pct.epithelial,
    other: pct.other,
  });
  return dominantFromAxis(tissueType);
}
