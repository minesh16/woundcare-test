/**
 * Deterministic wound-assessment engine — shared types.
 *
 * Grounded in two clinical guides (see docs/MendWise_Assessment_Build_Spec.md):
 *  - Australian Government (Dept of Health & Aged Care) CWCS "Wound Assessment":
 *    26 dressing pathways keyed by (tissue type × exudate level × infection).
 *  - Mölnlycke "10-step local wound assessment": referral / escalation triggers.
 *
 * These types are erased at runtime, so any file may import them with
 * `import type { ... } from './engine.types'` and stay Node-runnable.
 */

export type TissueType =
  | 'necrotic_ischaemic'
  | 'necrotic'
  | 'slough'
  | 'granulating'
  | 'epithelialising';

export type ExudateLevel = 'low' | 'moderate' | 'high';
export type Infection = 'yes' | 'no';
export type Confidence = 'high' | 'medium' | 'low';
export type PerfusionStatus = 'ischaemic' | 'non_ischaemic' | 'unknown';

/** Proportion (0–100) of the wound bed occupied by each tissue class. */
export type TissueBreakdown = {
  necrosis: number;
  slough: number;
  granulation: number;
  epithelial: number;
  other: number;
};

/** Inputs to the Mölnlycke referral/escalation triggers (all optional; absent = not assessed). */
export type MolnlyckeInputs = {
  // Step 1 — Duration
  hardToHeal?: boolean; // wound present with <40% healing in 4 weeks
  diabeticFootUlcer?: boolean;
  // Step 2 — Size & depth
  probeToBone?: boolean;
  // Step 3 — Tissue perfusion
  abpi?: number | null; // ankle–brachial pressure index (ratio)
  diabetes?: boolean;
  // Step 8 — Pain & sensation
  lossOfProtectiveSensation?: boolean;
  // Steps 9–10 — Infection & biofilm
  systemicInfection?: boolean;
  spreadingErythemaOver2cm?: boolean;
};


// ===========================================================================
// Caged VLM features (Phase 2)
//
// Every field is an enum: the vision model is a feature EXTRACTOR, never a
// decision-maker. `uncertain` is always available so the model is never forced
// into a guess, and the deterministic reconciliation below treats `uncertain`
// as "no information" rather than as evidence either way.
// The runtime Zod mirror of these types lives in `vlm.schema.ts` — this file
// stays type-only so `engine.ts` remains Node-runnable with no build step.
// ===========================================================================

/** Three-state observation: the model saw it, didn't see it, or couldn't tell. */
export type Tri = 'present' | 'absent' | 'uncertain';

export type EdgeType =
  | 'healthy'
  | 'rolled_epibole'
  | 'undermined'
  | 'callused'
  | 'macerated'
  | 'uncertain';

export type VisualExudate = 'none' | 'low' | 'moderate' | 'high' | 'very_high' | 'uncertain';

export type TissueCorroboration = 'agrees' | 'disagrees' | 'uncertain';

export type ImageFlag = 'low_light' | 'blur' | 'no_marker';

/** The five infection signs the VLM is asked to report (classic + subtle). */
export type VlmInfectionSigns = {
  erythema: Tri;
  warmth: Tri;
  purulent: Tri;
  malodour: Tri;
  friableGranulation: Tri;
};

export type VlmFeatures = {
  infectionSigns: VlmInfectionSigns;
  edgeType: EdgeType;
  visualExudate: VisualExudate;
  tissueCorroboration: TissueCorroboration;
  imageFlags: ImageFlag[];
};

/** Periwound band measurements (HSI, Mölnlycke step 5). */
export type PeriwoundInputs = {
  rednessPct: number | null;
  maceration: boolean | null;
};

export type EngineInputs = {
  tissue: TissueBreakdown;
  perfusion?: PerfusionStatus;
  exudate?: ExudateLevel;
  infection?: Infection;
  molnlycke?: MolnlyckeInputs;
  cvConfidence?: Confidence;
  markerFound?: boolean;
  /** Caged VLM features. Advisory only — see the reconciliation rules in engine.ts. */
  vlm?: VlmFeatures;
  /** Periwound band metrics from HSI. */
  periwound?: PeriwoundInputs;
  /** True when the user entered a wound size by hand, standing in for a marker. */
  manualSizeProvided?: boolean;
};

export type ReferralUrgency = 'urgent' | 'mdt' | 'review';

export type ReferralFlag = {
  urgency: ReferralUrgency;
  code: string;
  message: string;
};

export type CwcsPathway = {
  id: number; // 1..26
  tissue: TissueType;
  exudate: ExudateLevel;
  infection: Infection;
  primary: string[];
  secondary: string[];
  note?: string;
};

export type DerivedAxes = {
  tissue: TissueType | null;
  exudate: ExudateLevel | null;
  infection: Infection | null;
};

export type EngineResult = {
  status: 'complete' | 'incomplete';
  incompleteReasons: string[];
  /**
   * True when the axes resolved to a pathway but a safety gate withheld it
   * (blur, no usable scale, or an unresolved tissue conflict). Distinguishes
   * "we couldn't decide" from "we decided not to say" in the audit trail.
   */
  pathwayWithheld: boolean;
  /** Stable codes for the gates that fired — the UI copy layer keys off these. */
  gateCodes: string[];
  axes: DerivedAxes;
  cwcsPathwayId: number | null;
  primary: string[];
  secondary: string[];
  referrals: ReferralFlag[];
  confidence: Confidence;
  notes: string[];
  rulesVersion: string;
};
