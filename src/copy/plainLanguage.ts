import type { Confidence, ExudateLevel, Infection, TissueType } from '@/decision/engine.types';

/**
 * Plain-language layer.
 *
 * The engine's own strings are the clinical record: they are asserted on in
 * `scripts/test-rules.mts`, they go into the audit log, and they are what a
 * clinician needs to see. They are NOT what a person with a wound should be
 * reading on their phone.
 *
 * So nothing here rewrites the engine. This maps the engine's stable outputs —
 * enum values and `code` fields — onto wording a non-clinician can act on, and
 * the clinician view shows the original terms untouched, one tap away.
 *
 * ⚠️ This wording is pending review by the clinical contact. Plain language
 * that is subtly wrong is worse than jargon, because it will be believed.
 */

/** How each tissue type is described to the person being assessed. */
export const TISSUE_PLAIN: Record<TissueType, string> = {
  necrotic_ischaemic: 'dark, dead tissue, with reduced blood flow to the area',
  necrotic: 'dark, dead tissue',
  slough: 'soft yellow or cream-coloured tissue',
  granulating: 'new healing tissue (red or pink)',
  epithelialising: 'new skin forming across the wound',
};

/** The exact clinical term, for the clinician view. clinician-copy */
export const TISSUE_CLINICAL: Record<TissueType, string> = {
  necrotic_ischaemic: 'Necrotic — ischaemic',
  necrotic: 'Necrotic — non-ischaemic',
  slough: 'Slough',
  granulating: 'Granulating',
  epithelialising: 'Epithelialising',
};

/** Tissue-composition bar labels on the analysis screen. */
export const TISSUE_CLASS_PLAIN = {
  granulation: 'New healing tissue',
  slough: 'Soft yellow tissue',
  necrosis: 'Dark, dead tissue',
  epithelial: 'New skin forming',
  other: 'Other',
} as const;

/** clinician-copy */
export const TISSUE_CLASS_CLINICAL = {
  granulation: 'Granulation',
  slough: 'Slough',
  necrosis: 'Necrosis',
  epithelial: 'Epithelialising',
  other: 'Other',
} as const;

export const EXUDATE_PLAIN: Record<ExudateLevel, string> = {
  low: 'a small amount of fluid',
  moderate: 'a moderate amount of fluid',
  high: 'a lot of fluid',
};

export const INFECTION_PLAIN: Record<Infection, string> = {
  yes: 'signs that suggest infection',
  no: 'no clear signs of infection',
};

export const CONFIDENCE_PLAIN: Record<Confidence, string> = {
  high: 'We are reasonably confident in this result.',
  medium: 'Treat this as a guide — some details were unclear.',
  low: 'This result is uncertain. Please have someone look at the wound.',
};

/**
 * Safety-gate codes → why we are not showing a dressing suggestion, and what
 * to do about it. Phrased as a fixable next step, never as a bare refusal.
 */
export const GATE_PLAIN: Record<string, { title: string; whatToDo: string }> = {
  blurred_image: {
    title: 'The photo is too blurred to assess',
    whatToDo: 'Take another photo, holding the camera steady and about 20 cm from the wound.',
  },
  no_scale: {
    title: 'We could not measure the wound size',
    whatToDo: 'Take another photo with a coin next to the wound, or enter the size by hand.',
  },
  tissue_conflict: {
    title: 'We could not tell what the wound bed is made of',
    whatToDo: 'Take another photo in good, even light with the whole wound in frame.',
  },
};

/**
 * Terms the report LLM must use, passed into its prompt so app and report match.
 * The keys are the clinical terms being translated. clinician-copy
 */
export const REPORT_TERM_MAP: Record<string, string> = {
  granulation: 'new healing tissue',
  slough: 'soft yellow tissue',
  necrosis: 'dark, dead tissue',
  necrotic: 'dark, dead tissue',
  epithelialising: 'new skin forming',
  exudate: 'fluid from the wound',
  'tissue perfusion': 'blood flow to the area',
  ABPI: 'a circulation test a clinician can do',
  erythema: 'redness of the skin',
  maceration: 'soggy, waterlogged skin',
  osteomyelitis: 'a possible bone infection',
  debridement: 'having the dead tissue removed by a clinician',
  'multidisciplinary team': 'a specialist wound care team',
};
