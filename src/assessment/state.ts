import type { EngineInputs, EngineResult, VlmFeatures } from '@/decision/engine.types';
import type { BodyZone, CvResult, QuestionnaireAnswers } from '@/decision/types';

/**
 * The record an assessment accumulates as it moves through the V2 pipeline.
 *
 * Shared by the Expo client and the Vercel functions. Every field is optional
 * except `id` and `createdAt`: a step that didn't run, or ran and degraded,
 * leaves its slot empty rather than filling it with a default that would later
 * read as a real measurement.
 *
 * De-identified by construction — there is nowhere here to put a name, a date
 * of birth or a record number, and there should never be.
 */

export type StepName = 'quality' | 'segment' | 'tissue' | 'vlm' | 'evaluate' | 'report';
export type StepStatus = 'ok' | 'degraded' | 'failed' | 'skipped';

export type StepOutcome = {
  step: StepName;
  status: StepStatus;
  ms: number;
  /** Short human-readable line — shown in the progress stream and the audit log. */
  summary: string;
};

/**
 * Which backend drew the wound boundary.
 *
 * Mirrors `SegmentationProvider` in `api/_segmentationParse.ts`. The two are
 * deliberately separate declarations: this file is shared with the Expo client,
 * and the api/ module must stay import-free so it runs under Node's type
 * stripping. They are types only, so there is no runtime coupling to break —
 * but they must be changed together.
 */
export type SegmentationProviderName = 'sam3' | 'fusegnet';

/** How the boundary was obtained — see `PromptMode` in `api/_segmentation.ts`. */
export type SegmentPromptMode = 'concept' | 'wound-specific';

/**
 * What the clinician did with the model's proposed boundary, on the review step.
 *
 * This is the most important field in the record for an assurance reviewer: it is
 * the difference between "a model decided where the wound was" and "a clinician
 * approved where the wound was". `drawn` means the model's boundary was rejected
 * outright and the outline is entirely human.
 *
 * Mirrors `BoundaryApproval` in `api/_maskGeometry.ts` (types only; see the note
 * on `SegmentationProviderName`).
 */
export type BoundaryApprovalName = 'approved' | 'adjusted' | 'drawn';

export type SegmentSummary = {
  /** `clinician` when the boundary is hand-drawn and no model produced it. */
  source: SegmentationProviderName | 'clinician' | 'unavailable';
  maskUrl: string | null;
  confidence: 'high' | 'medium' | 'low';
  model?: string;
  promptMode?: SegmentPromptMode;
  /** Present once the boundary has been through the review step. */
  approval?: BoundaryApprovalName;
  /** Points in the clinician's polygon, when they adjusted or drew one. */
  outlinePoints?: number;
  /** The approval (POST /approve) this boundary was signed off under. */
  approvalId?: string;
};

export type TissueSummary = {
  granulation: number;
  slough: number;
  necrotic: number;
  epithelial: number;
  other: number;
  /**
   * `model` = a segmentation model's mask; `hsv` = the on-device colour-threshold
   * mask. Which model is a separate field: the tissue step is handed a mask, not
   * a provider, and recording a provider it was not told would be a guess.
   */
  maskSource: 'model' | 'hsv';
  /** Which backend produced that mask, when the caller said. */
  maskProvider?: SegmentationProviderName | null;
  maskAreaPx: number;
  periwound: { rednessPct: number; macerationPct: number; maceration: boolean } | null;
};

/**
 * The size reference found in the photo — today only a 20c coin.
 *
 * Fractional coordinates (of the analysis frame) so the UI can circle it on the
 * photo: a scale nobody can see is a scale nobody can catch being wrong, and a
 * wrong scale is worse than none (it does not withhold the pathway).
 */
export type ScaleReference = {
  kind: 'coin';
  xPct: number;
  yPct: number;
  /** Radius as a fraction of the frame's width. */
  rPct: number;
  /** Share of the coin's rim on a real edge (0–1) — how coin-like the circle is. */
  support: number;
  pxPerCm: number;
};

/** Size of the approved outline. Every cm value is null without a scale. */
export type WoundGeometry = {
  areaPx: number;
  areaCm2: number | null;
  /** Long side of the minimum-area rotated rectangle around the wound. */
  lengthCm: number | null;
  /** Short side of that rectangle. */
  widthCm: number | null;
  perimeterCm: number | null;
};

/** White balance from a printed white reference patch (segmentation spec §5). */
export type WhiteBalance =
  | { applied: true; gains: { r: number; g: number; b: number }; patch: { xPct: number; yPct: number; wPct: number; hPct: number } }
  | { applied: false; reason: 'no_marker' };

/** Tissue % by both classifiers, for the side-by-side comparison (spec §5). */
export type TissuePercentages = {
  granulation: number;
  slough: number;
  necrotic: number;
  epithelial: number;
  other: number;
};

/** What `/api/v1/assessments/measure` adds on top of the tissue measurement. */
export type MeasurementResult = {
  /** The analysis frame the pixel values refer to. */
  frame: { width: number; height: number };
  scale: ScaleReference | null;
  /** Why there is no scale, when there is none. */
  scaleReason?: string;
  geometry: WoundGeometry;
  whiteBalance: WhiteBalance;
  /** `no_marker`: no white reference, so colours were not corrected and tissue confidence is capped. */
  flags: ('no_marker')[];
  /** Which classifier produced `tissue` — `relative` only when TISSUE_RELATIVE=1. */
  classifier: 'absolute' | 'relative';
  /** Both classifiers' results, so they can be compared on real photos. */
  comparison: { absolute: TissuePercentages; relative: TissuePercentages | null };
};

export type ReportPair = {
  clinicianReport: string;
  patientSummary: string;
  /** 'llm' when the report LLM wrote it, 'template' when the deterministic fallback did. */
  source: 'llm' | 'template';
  model?: string;
};

export type AssessmentState = {
  id: string;
  createdAt: string;
  /** Groups assessments of the same wound over time. Client-generated, not a person id. */
  woundId?: string | null;
  bodyZone?: BodyZone | null;
  answers?: QuestionnaireAnswers | null;
  cv?: CvResult | null;
  segment?: SegmentSummary | null;
  tissue?: TissueSummary | null;
  vlm?: VlmFeatures | null;
  /** Why the VLM pass produced nothing, when it produced nothing. */
  vlmUnavailableReason?: string | null;
  /** Which model produced `vlm`. Recorded so a result is reproducible from the audit log. */
  vlmModel?: string | null;
  engineInputs?: EngineInputs | null;
  result?: EngineResult | null;
  /** SHA-256 of the photo — the record's link to an image it does not store. */
  imageSha256?: string | null;
  report?: ReportPair | null;
  steps?: StepOutcome[];
};

/** A server-minted, unguessable id (docs/SECURITY_AUDIT.md MW-06). */
export function newAssessmentId(): string {
  return `asmt-${globalThis.crypto.randomUUID()}`;
}
