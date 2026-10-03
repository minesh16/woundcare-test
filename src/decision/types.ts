export type DurationAnswer = 'yes' | 'no' | 'unsure';
export type ExudateLevel = 'none' | 'moderate' | 'heavy';
export type YesNo = 'yes' | 'no';

/** Tissue perfusion / circulation status (Mölnlycke Step 3). */
export type PerfusionAnswer = 'normal' | 'reduced' | 'unknown';

/** Optional ankle–brachial pressure index band (Mölnlycke Step 3 vascular trigger). */
export type AbpiBand = 'lt_0_5' | '0_5_to_0_8' | '0_8_to_1_3' | 'gt_1_4' | 'unknown';

export type BodyZone =
  | 'head'
  | 'neck'
  | 'chest'
  | 'abdomen'
  | 'upper_back'
  | 'lower_back'
  | 'sacrum'
  | 'shoulder_left'
  | 'shoulder_right'
  | 'upper_arm_left'
  | 'upper_arm_right'
  | 'forearm_left'
  | 'forearm_right'
  | 'hand_left'
  | 'hand_right'
  | 'elbow_left'
  | 'elbow_right'
  | 'hip_left'
  | 'hip_right'
  | 'buttock_left'
  | 'buttock_right'
  | 'thigh_left'
  | 'thigh_right'
  | 'knee_left'
  | 'knee_right'
  | 'lower_leg_left'
  | 'lower_leg_right'
  | 'ankle_left'
  | 'ankle_right'
  | 'heel_left'
  | 'heel_right'
  | 'foot_left'
  | 'foot_right'
  | 'toes_left'
  | 'toes_right';

/**
 * Wound-bed centroid in fractional image coordinates (0–1).
 *
 * Fractional, not pixels, so it survives every resize between capture and the
 * segmentation backend. It seeds SAM 3's pixel point prompt (converted there,
 * from the image's real dimensions) and selects the wound mask from the backends
 * that return more than one. FUSegNet needs it for neither.
 */
export type ImagePoint = { xPct: number; yPct: number };

/**
 * Skin in the 4 cm band around the wound edge (Mölnlycke step 5).
 * `null` on a CvResult means "not measured" — usually because no size
 * reference was found, so 4 cm could not be converted to pixels.
 */
export type Periwound = {
  /** Share of the band (0–100) reading as erythema. */
  rednessPct: number;
  /** Share of the band (0–100) reading as waterlogged skin. */
  macerationPct: number;
  /** macerationPct over the reporting threshold. */
  maceration: boolean;
  /** Pixels actually sampled in the band. */
  bandPx: number;
  /** Band width in cm (always 4; recorded so the audit trail is self-describing). */
  bandCm: number;
};

export type CvResult = {
  granulationPercent: number;
  sloughPercent: number;
  necrosisPercent: number;
  epithelialPercent: number;
  otherPercent: number;
  areaPx2: number;
  areaCm2: number | null;
  /** Pixels per cm from the reference marker (coin/ArUco); null when no marker found. */
  pxPerCm: number | null;
  depthAssessed: false;
  confidence: 'high' | 'medium' | 'low';
  overlayBase64: string | null;
  analysisEngine: 'opencv' | 'fallback';
  coinDetected: boolean;
  /** HSV wound centroid (segmentation prompt/selection seed); null when no wound contour found. */
  hsvCentroid: ImagePoint | null;
  /** Which mask the tissue percentages were measured inside — a model's, or the on-device HSV one. */
  maskSource?: 'hsv' | 'model';
  /** Pixel count of that mask (the denominator behind the tissue percentages). */
  maskAreaPx?: number;
  /** Periwound band metrics; null when no scale was available to size the band. */
  periwound?: Periwound | null;
};

export type QuestionnaireAnswers = {
  durationOver30Days: DurationAnswer | null;
  exudate: ExudateLevel | null;
  pain: number;
  warmth: YesNo | null;
  diabetes: YesNo | null;
  immunocompromised: YesNo | null;
  // Phase 1 — perfusion + explicit infection signs feeding the CWCS/Mölnlycke engine.
  perfusion: PerfusionAnswer | null;
  abpiBand: AbpiBand | null;
  infectionSigns: YesNo | null;
  spreadingRedness: YesNo | null;
};

export type UrgencyLevel = 'immediate' | 'within_48h' | 'routine';
export type Classification = 'likely_acute' | 'likely_chronic' | 'indeterminate';

export type AssessmentResult = {
  classification: Classification;
  urgency: UrgencyLevel;
  dressingCategory: string;
  rationale: string[];
  seekMedicalAttention: boolean;
  // Phase 0 — deterministic guideline-engine output (optional; UI-safe).
  cwcsPathwayId?: number | null;
  tissueType?: string | null;
  primaryDressings?: string[];
  secondaryDressings?: string[];
  referrals?: { urgency: string; code: string; message: string }[];
  engineStatus?: 'complete' | 'incomplete';
  rulesVersion?: string;
  // Phase 2 — the axes and gates the result screen renders in plain language.
  exudateLevel?: string | null;
  infection?: string | null;
  confidence?: 'high' | 'medium' | 'low';
  gateCodes?: string[];
  pathwayWithheld?: boolean;
  areaCm2?: number | null;
};

/** The ungrounded comparison arm's output. Kept for the report, never for the decision. */
export type BaselineComparison = {
  text: string;
  model?: string;
  latencyMs?: number;
};

/**
 * The boundary a clinician signed off on the review step.
 *
 * This is the record of a human decision, not a measurement, which is why it
 * lives on the session alongside `cv` rather than inside it: the mask the tissue
 * percentages are measured inside must be the one that was approved, and the
 * record has to say which of approve / adjust / draw happened.
 */
export type ReviewedBoundary = {
  /** The mask actually approved — the model's, or one rasterised from the clinician's polygon. */
  maskUrl: string;
  approval: 'approved' | 'adjusted' | 'drawn';
  /** The model that proposed it; null when the clinician drew it from scratch. */
  provider: 'sam3' | 'fusegnet' | null;
  model: string | null;
  /** The polygon, kept so the editor can be reopened without re-tracing. */
  outline: { x: number; y: number }[] | null;
  areaPx: number | null;
  areaPct: number | null;
  reviewedAt: string;
};

/**
 * The model's proposed boundary, carried from analyze to review.
 *
 * Held on the session rather than in the analyze screen's local state because the
 * review screen is a different screen: a proposal that only existed in a
 * component's `useState` could not be reviewed after navigating.
 */
export type BoundaryProposal = {
  maskUrl: string | null;
  provider: 'sam3' | 'fusegnet' | null;
  model: string | null;
  /** Editable outline traced from the mask; null when it could not be traced. */
  outline: { x: number; y: number }[] | null;
  areaPx: number | null;
  areaPct: number | null;
  multipleRegions: boolean | null;
  confidence: 'high' | 'medium' | 'low';
};

export type ScanSession = {
  id: string;
  createdAt: string;
  consentGiven: boolean;
  imageUri: string | null;
  includeCoinReference: boolean;
  cv: CvResult | null;
  /** What segmentation proposed, pending review. */
  boundaryProposal: BoundaryProposal | null;
  /** Null until the review step; see `ReviewedBoundary`. */
  boundary: ReviewedBoundary | null;
  bodyZone: BodyZone | null;
  answers: QuestionnaireAnswers;
  result: AssessmentResult | null;
  /**
   * The assessmentV2 pipeline run (segmentation, tissue, caged VLM, engine
   * result and the AI-composed report). Held on the session so it survives
   * navigation and reaches the exported report — it used to live only in the
   * compare screen's local state and was lost the moment you navigated away.
   * Typed loosely here to keep this module free of a runtime import.
   */
  v2: Record<string, unknown> | null;
  baseline: BaselineComparison | null;
};

export const defaultAnswers = (): QuestionnaireAnswers => ({
  durationOver30Days: null,
  exudate: null,
  pain: 0,
  warmth: null,
  diabetes: null,
  immunocompromised: null,
  perfusion: null,
  abpiBand: null,
  infectionSigns: null,
  spreadingRedness: null,
});

function createSessionId(): string {
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const defaultSession = (): ScanSession => ({
  id: createSessionId(),
  createdAt: new Date().toISOString(),
  consentGiven: false,
  imageUri: null,
  includeCoinReference: false,
  cv: null,
  boundaryProposal: null,
  boundary: null,
  bodyZone: null,
  answers: defaultAnswers(),
  result: null,
  v2: null,
  baseline: null,
});
