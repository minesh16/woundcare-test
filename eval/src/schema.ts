/**
 * The canonical schema (spec §5.2). Every dataset maps INTO `GroundTruth`;
 * every pipeline run maps INTO `Prediction`. They share field names and enums.
 */
import { z } from 'zod';

import { DOMINANT_TISSUE, EXUDATE, PROVENANCE, SKIN_TONE_SCALE, TISSUE_CLASSES, WOUND_TYPES, YES_NO } from './vocab';

const pct = z.number().min(0).max(100);
export const tissuePct = z.object({ granulation: pct, slough: pct, necrotic: pct, epithelial: pct, other: pct });

export const GroundTruth = z.object({
  woundPresent: z.boolean().optional(),
  woundType: z.enum(WOUND_TYPES).optional(),
  pressureStage: z.enum(['1', '2', '3', '4', 'unstageable', 'dti']).optional(),
  bodyZone: z.string().optional(), // an id from src/constants/bodyZones.ts, e.g. foot_left
  woundMaskPath: z.string().optional(), // relative to EVAL_DATA_DIR/cache/<dataset>/ (binary PNG, image frame)
  // zod 4: a record keyed by an enum is exhaustive; partialRecord lets a dataset label only some classes.
  tissueMaskPaths: z.partialRecord(z.enum(TISSUE_CLASSES), z.string()).optional(),
  tissuePct: tissuePct.optional(), // derived from tissue masks if not given
  tissueClassesLabelled: z.array(z.enum(TISSUE_CLASSES)).optional(),
  dominantTissue: z.enum(DOMINANT_TISSUE).optional(),
  exudate: z.enum(EXUDATE).optional(),
  infection: z.enum(YES_NO).optional(),
  ischaemia: z.enum(YES_NO).optional(),
  markerPresent: z.boolean().optional(),
  lengthCm: z.number().positive().optional(),
  widthCm: z.number().positive().optional(),
  areaCm2: z.number().positive().optional(),
  expectedPathwayId: z.number().int().min(1).max(26).optional(),
  expectedReferralCodes: z.array(z.string()).optional(),
  skinTone: z.object({ scale: z.enum(SKIN_TONE_SCALE), value: z.number() }).optional(),
  provenance: z.record(z.string(), z.enum(PROVENANCE)).optional(), // per field
  rawLabels: z.record(z.string(), z.unknown()).default({}),
});
export type GroundTruth = z.infer<typeof GroundTruth>;

export const Prediction = z.object({
  woundPresent: z.boolean(), // false when no plausible mask
  maskPath: z.string().nullable(), // EVAL_OUT_DIR/<run>/masks/<item>__<arm>.png
  segmentation: z.object({
    source: z.enum(['sam3', 'fusegnet', 'hsv']).nullable(),
    model: z.string().nullable(),
    score: z.number().nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    plausibility: z.string(),
    multipleRegions: z.boolean().nullable(),
    candidates: z.number(),
    latencyMs: z.number(),
    attempts: z.array(z.object({ provider: z.string(), status: z.string(), ms: z.number(), reason: z.string().optional() })),
    secondOpinion: z
      .object({
        status: z.string(),
        agreementIoU: z.number().nullable(),
        // Beyond the spec's two fields: FUSegNet's own latency (feeds the costs.yaml reminder) and its region report.
        latencyMs: z.number().nullable().optional(),
        multipleRegions: z.boolean().nullable().optional(),
        reason: z.string().optional(),
      })
      .nullable(),
    areaPx: z.number().nullable(),
    frame: z.object({ width: z.number(), height: z.number() }),
    promptConflict: z.boolean().optional(),
  }),
  measurement: z
    .object({
      markerFound: z.boolean(),
      pxPerCm: z.number().nullable(),
      coinSupport: z.number().nullable(),
      areaCm2: z.number().nullable(),
      lengthCm: z.number().nullable(),
      widthCm: z.number().nullable(),
      perimeterCm: z.number().nullable(),
      whiteBalanced: z.boolean(),
      classifier: z.enum(['absolute', 'relative']).nullable(),
    })
    .nullable(),
  tissuePct: tissuePct.nullable(),
  tissuePctRelative: tissuePct.nullable(), // measurement.comparison.relative
  tissueSentinel: z.boolean(), // the 20/20/20/20/20 "nothing considered" fallback (§24)
  periwound: z.object({ rednessPct: z.number(), maceration: z.boolean() }).nullable(),
  dominantTissue: z.enum(DOMINANT_TISSUE).nullable(), // engine axes.tissue (necrotic_ischaemic → necrotic)
  exudate: z.enum(EXUDATE).nullable(), // engine axes.exudate
  infection: z.enum(YES_NO).nullable(), // engine axes.infection
  engine: z.object({
    status: z.enum(['complete', 'incomplete']),
    pathwayWithheld: z.boolean(),
    gateCodes: z.array(z.string()),
    cwcsPathwayId: z.number().nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    referrals: z.array(z.object({ urgency: z.string(), code: z.string() })),
    incompleteReasons: z.array(z.string()),
    rulesVersion: z.string(),
  }),
  vlm: z
    .object({
      source: z.string(),
      model: z.string().nullable(),
      features: z.unknown().nullable(),
      latencyMs: z.number(),
      schemaValid: z.boolean().optional(),
    })
    .nullable(),
  report: z
    .object({ source: z.string(), cageViolation: z.boolean(), cageReason: z.string().nullable().optional(), model: z.string().nullable() })
    .nullable(),
  baseline: z.object({ text: z.string().nullable(), model: z.string().nullable() }).nullable(),
  skinToneProxy: z.object({ itaDeg: z.number(), band: z.string() }).nullable(), // §14.8
  timings: z.record(z.string(), z.number()), // ms per stage
  errors: z.array(z.object({ stage: z.string(), message: z.string() })),
});
export type Prediction = z.infer<typeof Prediction>;

/** One ingested item (spec §9; mirrors `eval_items`). */
export type EvalItem = {
  id: string; // '<dataset>:<key>'
  datasetId: string;
  key: string;
  split: string | null;
  imageSha256: string; // over the ORIGINAL file's bytes (api/_image.ts imageSha256)
  dhash: string;
  relPath: string; // original image, relative to EVAL_DATA_DIR
  normPath: string; // the normalised analysis JPEG, relative to EVAL_DATA_DIR/cache/<dataset>/
  width: number; // analysis grid
  height: number;
  gt: GroundTruth;
  strata: Record<string, string>;
  duplicateOf: string | null;
};

export const RESULT_STATUS = ['ok', 'failed', 'skipped'] as const;

/** One row of `eval_results` / `results.jsonl`. */
export type ResultRow = {
  runId: string;
  itemId: string;
  arm: string; // '<seg>|<boundary>|<policy>'
  status: (typeof RESULT_STATUS)[number];
  prediction: Prediction | null;
  itemMetrics?: Record<string, unknown> | null;
  timings?: Record<string, number> | null;
  error?: string | null;
  at: string;
};

/** One aggregate (`eval_metrics`). */
export type MetricRow = {
  runId: string;
  arm: string;
  area: string; // seg | meas | tissue | engine | vlm | ops | fairness | coverage
  metric: string;
  scope: string; // 'overall' | 'dataset=…' | …
  value: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  n: number;
  naRate: number | null;
  inDistribution: boolean;
};

export const FINDINGS_SCHEMA = 'mendwise-eval-findings/1';
