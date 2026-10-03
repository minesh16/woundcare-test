import { z } from 'zod';

/**
 * Every module endpoint's request contract, in Zod (segmentation build spec
 * §6A.2). Two jobs:
 *
 *  1. Validation at the door (docs/SECURITY_AUDIT.md MW-12). A body that does
 *     not match is a 400 with the reason — it never reaches a handler. This is
 *     what stops the live bug where the string 'no' was read as `true` and raised
 *     a referral the caller meant to clear.
 *  2. The OpenAPI 3.1 document (`api/_openapi.ts`) is generated from these, so
 *     the published reference cannot drift from what the server accepts.
 *
 * Field names are snake_case at the top level of a request; nested domain
 * objects (EngineInputs, tissue summaries) keep the engine's own camelCase.
 */

const pct = z.number().min(0).max(1);

export const base64Image = z
  .string()
  .min(100)
  .max(8_000_000)
  .describe('JPEG or PNG, base64 or a data URI. Send the SAME bytes to every call for one assessment: approvals bind to their hash.');

export const maskRef = z
  .string()
  .min(20)
  .max(6_000_000)
  .describe('Binary PNG mask (white = wound) as a data URI. https URLs are accepted only from fal.media.');

// Optional at the CONTRACT level on purpose: a missing approval is answered by
// the approval gate with 403 approval_required (spec §6A.3), not a 400.
export const approvalId = z.string().min(8).max(64).optional().describe('From POST /approve. Required by every image module (403 without it).');

const assessmentId = z.string().min(1).max(80);
const bodyZone = z.string().max(40).nullable().optional().describe('Body zone id, e.g. foot_left. Decides whether FUSegNet gives a second opinion.');

export const promptsSchema = z
  .object({
    text: z.string().max(60).optional().describe('Concept prompt; default "wound".'),
    points: z
      .array(z.object({ xPct: pct, yPct: pct, label: z.union([z.literal(0), z.literal(1)]).describe('1 = include, 0 = exclude') }))
      .max(24)
      .optional(),
    box: z.object({ x0Pct: pct, y0Pct: pct, x1Pct: pct, y1Pct: pct }).nullable().optional(),
  })
  .describe('Clinician prompts from the review screen. Fractional coordinates of the image.');

// ---------------------------------------------------------------------------
// Engine inputs — strict: an unknown or mistyped field is a 400, not a guess.
// ---------------------------------------------------------------------------
const tri = z.enum(['present', 'absent', 'uncertain']);
const yesNoUnsure = z.enum(['yes', 'no', 'unsure']);
const percent = z.number().min(0).max(100);

export const vlmFeaturesInput = z
  .object({
    infectionSigns: z
      .object({ erythema: tri, warmth: tri, purulent: tri, malodour: tri, friableGranulation: tri })
      .strict(),
    deepStructuresVisible: tri.optional(),
    edgeType: z.enum(['healthy', 'rolled_epibole', 'undermined', 'callused', 'macerated', 'uncertain']),
    visualExudate: z.enum(['none', 'low', 'moderate', 'high', 'very_high', 'uncertain']),
    tissueCorroboration: z.enum(['agrees', 'disagrees', 'uncertain']),
    imageFlags: z.array(z.enum(['low_light', 'blur', 'no_marker'])),
  })
  .strict();

export const engineInputsSchema = z
  .object({
    tissue: z.object({ necrosis: percent, slough: percent, granulation: percent, epithelial: percent, other: percent }).strict(),
    perfusion: z.enum(['ischaemic', 'non_ischaemic', 'unknown']).optional(),
    exudate: z.enum(['low', 'moderate', 'high']).optional(),
    infection: z.enum(['yes', 'no']).optional(),
    molnlycke: z
      .object({
        hardToHeal: z.boolean().optional(),
        diabeticFootUlcer: z.boolean().optional(),
        probeToBone: z.boolean().optional(),
        abpi: z.number().min(0).max(3).nullable().optional(),
        diabetes: z.boolean().optional(),
        lossOfProtectiveSensation: z.boolean().optional(),
        systemicInfection: z.boolean().optional(),
        spreadingErythemaOver2cm: z.boolean().optional(),
      })
      .strict()
      .optional(),
    cvConfidence: z.enum(['high', 'medium', 'low']).optional(),
    markerFound: z.boolean().optional(),
    vlm: vlmFeaturesInput.optional(),
    periwound: z.object({ rednessPct: z.number().min(0).max(100).nullable(), maceration: z.boolean().nullable() }).strict().optional(),
    manualSizeProvided: z.boolean().optional(),
    tissueOverride: z.enum(['necrotic', 'slough', 'granulating', 'epithelialising']).optional(),
    clinical: z
      .object({
        palpatedWarmth: z.enum(['cooler', 'same', 'warmer', 'hot']).optional(),
        induration: yesNoUnsure.optional(),
        oedema: yesNoUnsure.optional(),
        underminingTunnelling: yesNoUnsure.optional(),
        underminingClock: z.number().int().min(1).max(12).optional(),
        depthMm: z.number().min(0).max(200).optional(),
        monkTone: z.number().int().min(1).max(10).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe('Deterministic engine inputs. See src/decision/engine.types.ts.');

// ---------------------------------------------------------------------------
// Endpoint contracts
// ---------------------------------------------------------------------------

export const segmentInput = z
  .object({
    base64: base64Image,
    prompts: promptsSchema.optional(),
    body_zone: bodyZone,
    assessment_id: assessmentId.optional(),
  })
  .describe('POST /segment — draft wound outline (SAM 3; FUSegNet second opinion on foot wounds; HSV fallback).');

export const maskInput = z
  .object({
    polygon: z.array(z.object({ x: pct, y: pct })).min(3).max(400),
    width: z.number().int().min(16).max(2048).optional(),
    height: z.number().int().min(16).max(2048).optional(),
    approval: z.enum(['adjusted', 'drawn']).optional(),
    assessment_id: assessmentId.optional(),
  })
  .describe('POST /mask — rasterise a clinician polygon (fractional) to a PNG mask.');

export const approveInput = z
  .object({
    base64: base64Image,
    assessment_id: assessmentId,
    approval: z.enum(['approved', 'adjusted', 'drawn']),
    final_mask: maskRef,
    ai_mask: maskRef.nullable().optional().describe('The model draft, to compute the correction IoU. Null when drawn from scratch.'),
    clinician_id: z.string().max(80).nullable().optional().describe("The caller's own opaque clinician identifier."),
    provider: z.enum(['sam3', 'fusegnet', 'hsv']).nullable().optional(),
    model: z.string().max(80).nullable().optional(),
    confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
    score: z.number().min(0).max(1).nullable().optional(),
    edits: z.number().int().min(0).max(10_000).optional(),
    taps: z.number().int().min(0).max(10_000).optional(),
    box_used: z.boolean().optional(),
    ms_to_approve: z.number().int().min(0).max(86_400_000).optional(),
    image_source: z.enum(['public_dataset', 'synthetic', 'consented_demo']).optional(),
    body_zone: bodyZone,
    monk_tone: z.number().int().min(1).max(10).nullable().optional(),
    second_opinion: z
      .object({
        status: z.enum(['ok', 'unavailable']),
        agreement_iou: z.number().min(0).max(1).nullable().optional(),
        regions: z.record(z.string(), z.union([z.number(), z.boolean()])).nullable().optional(),
        mean_prob: z.number().nullable().optional(),
        latency_ms: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .describe('POST /approve — clinician sign-off of the final mask. Returns approval_id; writes the correction log.');

export const measureInput = z
  .object({
    base64: base64Image,
    mask: maskRef,
    approval_id: approvalId,
    include_coin_reference: z.boolean().optional().describe('False when there is no coin in the photo. Default true.'),
  })
  .describe('POST /measure — area, length, width, perimeter, px/cm, white balance and tissue inside the approved mask.');

export const tissueInput = z
  .object({ base64: base64Image, mask: maskRef, approval_id: approvalId })
  .describe('POST /tissue — tissue percentages inside the approved mask.');

export const vlmInput = z
  .object({
    base64: base64Image,
    mask: maskRef,
    approval_id: approvalId,
    tissue_summary: z.record(z.string(), z.unknown()).optional(),
  })
  .describe('POST /vlm-features — caged enum observations from the photo and crops of the approved mask.');

export const evaluateInput = z
  .object({ inputs: engineInputsSchema, assessment_id: assessmentId.optional() })
  .describe('POST /evaluate — the deterministic engine. No image.');

export const reportInput = z
  .object({
    result: z.record(z.string(), z.unknown()).describe('An EngineResult from /evaluate or /run.'),
    area_cm2: z.number().min(0).max(10_000).nullable().optional(),
    body_zone_label: z.string().max(60).nullable().optional(),
    tissue_pct: z
      .object({ granulation: percent, slough: percent, necrosis: percent, epithelial: percent })
      .nullable()
      .optional(),
  })
  .describe('POST /report — narrative from already-decided facts, cage-checked.');

export const runInput = z
  .object({
    base64: base64Image,
    mask: maskRef,
    approval_id: approvalId,
    inputs: engineInputsSchema,
    px_per_cm: z.number().min(0).max(10_000).nullable().optional(),
    area_cm2: z.number().min(0).max(10_000).nullable().optional(),
    body_zone_label: z.string().max(60).nullable().optional(),
    wound_id: z.string().max(80).nullable().optional(),
  })
  .describe('POST /run — tissue → image review → engine → report, streamed. Requires an approval: no auto-approval.');

export const correctionInput = z
  .object({
    correction_id: z.string().min(8).max(64),
    tissue_auto: z.enum(['necrotic', 'slough', 'granulating', 'epithelialising']).nullable(),
    tissue_final: z.enum(['necrotic', 'slough', 'granulating', 'epithelialising']),
    wound_location: z.string().max(60).nullable().optional(),
    monk_tone: z.number().int().min(1).max(10).nullable().optional().describe('Only for stratifying accuracy across skin tones.'),
  })
  .describe('POST /correction — record the tissue confirmation against an approval\'s correction row.');

export const baselineInput = z.object({ base64: base64Image }).describe('POST /baseline — the deliberately ungrounded comparison arm.');

export const createInput = z
  .object({ wound_id: z.string().max(80).nullable().optional() })
  .describe('POST /create — start an assessment record.');

export const analyzeInput = z
  .object({ base64: base64Image, includeCoinReference: z.boolean().optional() })
  .describe('POST /api/analyze — legacy on-device-equivalent HSV pass (capture quality gate).');

/** Registry for the OpenAPI document: path → (summary, input schema, auth notes). */
export const CONTRACTS = [
  { path: '/api/v1/assessments/segment', scope: 'segment', schema: segmentInput, approval: false },
  { path: '/api/v1/assessments/mask', scope: 'segment', schema: maskInput, approval: false },
  { path: '/api/v1/assessments/approve', scope: 'approve', schema: approveInput, approval: false },
  { path: '/api/v1/assessments/measure', scope: 'measure', schema: measureInput, approval: true },
  { path: '/api/v1/assessments/tissue', scope: 'tissue', schema: tissueInput, approval: true },
  { path: '/api/v1/assessments/vlm-features', scope: 'vlm', schema: vlmInput, approval: true },
  { path: '/api/v1/assessments/evaluate', scope: 'evaluate', schema: evaluateInput, approval: false },
  { path: '/api/v1/assessments/report', scope: 'report', schema: reportInput, approval: false },
  { path: '/api/v1/assessments/run', scope: 'run', schema: runInput, approval: true },
  { path: '/api/v1/assessments/correction', scope: 'approve', schema: correctionInput, approval: false },
  { path: '/api/v1/assessments/create', scope: 'run', schema: createInput, approval: false },
  { path: '/api/v1/assessments/baseline', scope: 'baseline', schema: baselineInput, approval: false },
] as const;
