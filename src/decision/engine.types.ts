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

export type EngineInputs = {
  tissue: TissueBreakdown;
  perfusion?: PerfusionStatus;
  exudate?: ExudateLevel;
  infection?: Infection;
  molnlycke?: MolnlyckeInputs;
  cvConfidence?: Confidence;
  markerFound?: boolean;
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
  axes: DerivedAxes;
  cwcsPathwayId: number | null;
  primary: string[];
  secondary: string[];
  referrals: ReferralFlag[];
  confidence: Confidence;
  notes: string[];
  rulesVersion: string;
};
