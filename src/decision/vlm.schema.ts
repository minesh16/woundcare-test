import { z } from 'zod';

/**
 * The cage, expressed as a schema.
 *
 * This is the ONLY shape the vision model is allowed to return. Every field is
 * an enum, so there is no channel through which free text — let alone a
 * dressing, a pathway or a treatment — can reach the decision path. The model
 * is a feature extractor; `src/decision/engine.ts` makes the decision.
 *
 * `uncertain` exists on every observation so the model is never forced into a
 * guess. The engine treats `uncertain` as "no information", never as evidence.
 *
 * This is the runtime mirror of the `VlmFeatures` types in `engine.types.ts`.
 * They are kept in separate files on purpose: `engine.ts` must stay free of
 * runtime imports so it runs under `node --experimental-strip-types`.
 */

export const triSchema = z.enum(['present', 'absent', 'uncertain']);

export const vlmFeaturesSchema = z.object({
  infectionSigns: z.object({
    erythema: triSchema.describe('Redness of the skin around the wound.'),
    warmth: triSchema.describe('Visual signs suggesting local heat (shiny, taut, inflamed skin).'),
    purulent: triSchema.describe('Pus or purulent discharge in or on the wound bed.'),
    malodour: triSchema.describe('Visual correlates of odour, e.g. heavy biofilm or sloughy debris.'),
    friableGranulation: triSchema.describe('Granulation tissue that looks fragile or bleeds easily — a subtle infection sign.'),
  }),
  edgeType: z.enum(['healthy', 'rolled_epibole', 'undermined', 'callused', 'macerated', 'uncertain'])
    .describe('The appearance of the wound edge.'),
  visualExudate: z.enum(['none', 'low', 'moderate', 'high', 'very_high', 'uncertain'])
    .describe('How much fluid the wound appears to be producing, judged visually.'),
  tissueCorroboration: z.enum(['agrees', 'disagrees', 'uncertain'])
    .describe('Whether the measured tissue composition matches what you see.'),
  imageFlags: z.array(z.enum(['low_light', 'blur', 'no_marker']))
    .describe('Problems with the photograph itself.'),
});

export type VlmFeaturesParsed = z.infer<typeof vlmFeaturesSchema>;

/**
 * Prompt for the caged extraction pass.
 *
 * The schema already makes a cage violation structurally impossible; this text
 * only improves the yield of useful, honest enum values.
 */
export const VLM_SYSTEM_PROMPT = [
  'You are a wound-image feature extractor for a clinical decision-support tool.',
  '',
  'Your ONLY job is to report what is visible in the images, as structured observations.',
  'You must NOT suggest, name or imply any dressing, treatment, product or care pathway.',
  'You must NOT diagnose. You are describing an image, not deciding anything.',
  'A separate deterministic rules engine makes every clinical decision from your observations.',
  '',
  'If you cannot see something clearly, answer "uncertain". An honest "uncertain" is more',
  'useful than a confident guess — a guess will reduce the reliability of the assessment.',
  'Only report a sign as "present" if you can actually see it in the image.',
  '',
  'You will be shown: the full photograph, a crop of the wound bed (inside the detected',
  'boundary), and a crop of the skin immediately surrounding the wound.',
].join('\n');
