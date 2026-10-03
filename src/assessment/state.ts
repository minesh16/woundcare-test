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
export type SegmentationProviderName = 'fusegnet' | 'sam3' | 'sam2';

/** How the boundary was obtained — see `PromptMode` in `api/_segmentation.ts`. */
export type SegmentPromptMode = 'wound-specific' | 'concept' | 'automatic';

export type SegmentSummary = {
  source: SegmentationProviderName | 'unavailable';
  maskUrl: string | null;
  confidence: 'high' | 'medium' | 'low';
  model?: string;
  promptMode?: SegmentPromptMode;
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
  report?: ReportPair | null;
  steps?: StepOutcome[];
};

export function newAssessmentId(): string {
  return `asmt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
