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
  | 'hip_left'
  | 'hip_right'
  | 'thigh_left'
  | 'thigh_right'
  | 'lower_leg_left'
  | 'lower_leg_right'
  | 'foot_left'
  | 'foot_right';

/** Wound-bed centroid in fractional image coordinates (0–1), used to seed SAM 2. */
export type ImagePoint = { xPct: number; yPct: number };

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
  /** HSV wound centroid (SAM 2 point-prompt seed); null when no wound contour found. */
  hsvCentroid: ImagePoint | null;
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
  // Phase 0 — CWCS/Mölnlycke deterministic engine output (optional; UI-safe).
  cwcsPathwayId?: number | null;
  tissueType?: string | null;
  primaryDressings?: string[];
  secondaryDressings?: string[];
  referrals?: { urgency: string; code: string; message: string }[];
  engineStatus?: 'complete' | 'incomplete';
  rulesVersion?: string;
};

export type ScanSession = {
  id: string;
  createdAt: string;
  consentGiven: boolean;
  imageUri: string | null;
  includeCoinReference: boolean;
  cv: CvResult | null;
  bodyZone: BodyZone | null;
  answers: QuestionnaireAnswers;
  result: AssessmentResult | null;
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
  bodyZone: null,
  answers: defaultAnswers(),
  result: null,
});
