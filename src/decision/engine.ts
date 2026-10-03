/**
 * MendWise deterministic wound-assessment engine (Phase 0).
 *
 * ONE engine, TWO rule modules over a shared state:
 *  - CWCS module  (OUTPUT): tissue × exudate × infection → 1 of 26 dressing pathways.
 *  - Mölnlycke module (FRAME + SAFETY): referral / escalation triggers.
 * A reconciliation step BRIDGES them by collapsing a tissue breakdown into a
 * single CWCS tissue type using the guide's own precedence.
 *
 * Design rule (the cage): this module is pure, deterministic and unit-tested.
 * AI (segmentation / HSI / VLM / LLM) only produces the *inputs* to this engine and
 * narrates its *outputs* — it never makes the dressing decision here.
 *
 * Runtime-only imports are avoided so the file runs under `node
 * --experimental-strip-types` for tests (see scripts/test-rules.mts).
 */

import type {
  Confidence,
  ClinicalInputs,
  ClinicianTissueChoice,
  CwcsPathway,
  EngineInputs,
  EngineResult,
  ExudateLevel,
  Infection,
  MolnlyckeInputs,
  PerfusionStatus,
  ReferralFlag,
  TissueBreakdown,
  TissueType,
  VisualExudate,
  VlmFeatures,
} from './engine.types';

// recon.2 (3 Oct 2026): clinician-confirmed dominant tissue (`tissueOverride`).
// recon.3 (3 Oct 2026): clinician-only inputs (palpated warmth, induration,
// undermining), visible deep structures, and the dark-skin erythema rule.
export const CWCS_RULES_VERSION = 'cwcs-2024.1+recon.3';

/** A tissue class must occupy at least this % of the wound bed to count as "present". */
export const TISSUE_PRESENCE_THRESHOLD = 10;

// ===========================================================================
// CWCS 26-pathway table
// Source: Australian Government (Dept of Health & Aged Care) — CWCS Consumable
// Choice Guide "Wound Assessment" ("CWCS Choice Guide_6524.pdf", 2 pages).
// ADVISORY ONLY; health professionals apply clinical judgement. Dressing strings
// are transcribed from the source table — VERIFY against the PDF before graded/
// external use.
// ===========================================================================
export const CWCS_PATHWAYS: CwcsPathway[] = [
  // --- Necrotic (ischaemic) — rows 1–6 ---
  { id: 1, tissue: 'necrotic_ischaemic', exudate: 'low', infection: 'yes',
    primary: ['Povidone iodine solution', 'Chlorhexidine topical application', 'Antimicrobial (Iodophors) (Inadine only)'],
    secondary: ['Low absorbent'] },
  { id: 2, tissue: 'necrotic_ischaemic', exudate: 'low', infection: 'no',
    primary: ['Povidone iodine solution', 'Chlorhexidine topical application', 'Antimicrobial (Iodophors) (Inadine only)'],
    secondary: ['Low absorbent'] },
  { id: 3, tissue: 'necrotic_ischaemic', exudate: 'moderate', infection: 'yes',
    primary: ['Antimicrobial (Iodophors)', 'Antimicrobial (Silver Alginates)', 'Antimicrobial (Silver gelling fibres)', 'Antimicrobial (Silver Foam)', 'Antimicrobial (Silver wound contact layer)', 'Antimicrobial (Silver Silicone)', 'Antimicrobial (Silver Charcoal)', 'Antimicrobial (Sucrose-octasulfate)', 'Antimicrobial (DACC-coated)'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 4, tissue: 'necrotic_ischaemic', exudate: 'moderate', infection: 'no',
    primary: ['Antimicrobial (Iodophors) (Inadine only)', 'Gelling Fibers'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 5, tissue: 'necrotic_ischaemic', exudate: 'high', infection: 'yes',
    primary: ['Antimicrobial (Iodophors)', 'Antimicrobial (Silver Alginates)', 'Antimicrobial (Silver gelling fibres)', 'Antimicrobial (Silver wound contact layer)', 'Antimicrobial (Silver Charcoal)', 'Antimicrobial (DACC-coated)'],
    secondary: ['Super-absorbent dressing'] },
  { id: 6, tissue: 'necrotic_ischaemic', exudate: 'high', infection: 'no',
    primary: ['Antimicrobial (Iodophors) (Inadine only)', 'Gelling Fibers'],
    secondary: ['Super-absorbent dressing'] },

  // --- Necrotic (non-ischaemic) — rows 7–12 ---
  { id: 7, tissue: 'necrotic', exudate: 'low', infection: 'yes',
    primary: ['Antimicrobial (Alginogels)', 'Antimicrobial (Medical Grade Honey)', 'Antimicrobial (Wound Gels)'],
    secondary: ['Low absorbent, foam or absorbent dressing'] },
  { id: 8, tissue: 'necrotic', exudate: 'low', infection: 'no',
    primary: ['Hydroactive dressing', 'Antimicrobial (Wound Gel)', 'Antimicrobial (Alginogels)', 'Antimicrobial (DACC-coated)', 'Antimicrobial (Sucrose-octasulfate)', 'Low absorbent (consider contact layer)'],
    secondary: ['Low absorbent, foam or absorbent dressing'] },
  { id: 9, tissue: 'necrotic', exudate: 'moderate', infection: 'yes',
    primary: ['Antimicrobial (Alginogels)', 'Antimicrobial (Iodophors)', 'Antimicrobial (Silver Alginates)', 'Antimicrobial (Silver Foam)', 'Antimicrobial (Silver wound contact layer)', 'Antimicrobial (Silver Silicone)', 'Antimicrobial (Silver Charcoal)', 'Antimicrobial (Sucrose-octasulfate)', 'Antimicrobial (Wound Gels)', 'Antimicrobial (DACC-coated)', 'Hydroactive (in conjunction with systemic antimicrobial therapy)', 'Gelling Fibers (in conjunction with systemic antimicrobial therapy)', 'Hypertonic Saline (in conjunction with systemic antimicrobial therapy)'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 10, tissue: 'necrotic', exudate: 'moderate', infection: 'no',
    primary: ['Foam dressing or absorbent dressing', 'Alginates', 'Hydroactive', 'Gelling Fibers', 'Hypertonic Saline'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 11, tissue: 'necrotic', exudate: 'high', infection: 'yes',
    primary: ['Antimicrobial (Iodophors)', 'Antimicrobial (Silver Alginates)', 'Antimicrobial (Silver gelling fibres)', 'Antimicrobial (Silver wound contact layer)', 'Antimicrobial (Silver Charcoal)', 'Antimicrobial (DACC-coated)', 'Hydroactive (in conjunction with systemic antimicrobial therapy)', 'Gelling Fibers (in conjunction with systemic antimicrobial therapy)', 'Hypertonic Saline (in conjunction with systemic antimicrobial therapy)'],
    secondary: ['Super-absorbent dressing'] },
  { id: 12, tissue: 'necrotic', exudate: 'high', infection: 'no',
    primary: ['Absorbent or Super-absorbent dressing', 'Alginates', 'Hydroactive', 'Gelling Fibers', 'Hypertonic Saline'],
    secondary: ['Super-absorbent dressing'] },

  // --- Slough — rows 13–18 ---
  { id: 13, tissue: 'slough', exudate: 'low', infection: 'yes',
    primary: ['Antimicrobial (Alginogels)', 'Antimicrobial (Medical Grade Honey)', 'Antimicrobial (Silver Foam)', 'Antimicrobial (Wound Gels)'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 14, tissue: 'slough', exudate: 'low', infection: 'no',
    primary: ['Antimicrobial (Wound Gel)', 'Antimicrobial (Alginogel)', 'Hydroactive dressing'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 15, tissue: 'slough', exudate: 'moderate', infection: 'yes',
    primary: ['Antimicrobial (Alginogels)', 'Antimicrobial (Iodophors)', 'Antimicrobial (Silver Alginates)', 'Antimicrobial (Silver Foam)', 'Antimicrobial (Silver wound contact layer)', 'Antimicrobial (Silver Silicone)', 'Antimicrobial (Silver Charcoal)', 'Antimicrobial (Sucrose-octasulfate)', 'Antimicrobial (DACC-coated)', 'Antimicrobial (Collagen-based)', 'Hydroactive (in conjunction with systemic antimicrobial therapy)', 'Gelling Fibers (in conjunction with systemic antimicrobial therapy)', 'Hypertonic Saline (in conjunction with systemic antimicrobial therapy)'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 16, tissue: 'slough', exudate: 'moderate', infection: 'no',
    primary: ['Alginates', 'Hydroactive', 'Gelling Fibers', 'Hypertonic Saline', 'Antimicrobial (Sucrose-octasulfate)'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 17, tissue: 'slough', exudate: 'high', infection: 'yes',
    primary: ['Antimicrobial (Iodophors)', 'Antimicrobial (Silver Alginates)', 'Antimicrobial (Silver gelling fibres)', 'Antimicrobial (Silver wound contact layer)', 'Antimicrobial (Silver Charcoal)', 'Antimicrobial (Sucrose-octasulfate)', 'Antimicrobial (DACC-coated)', 'Antimicrobial (Collagen-based)', 'Hydroactive (in conjunction with systemic antimicrobial therapy)', 'Gelling Fibers (in conjunction with systemic antimicrobial therapy)', 'Hypertonic Saline (in conjunction with systemic antimicrobial therapy)'],
    secondary: ['Super-absorbent dressing'] },
  { id: 18, tissue: 'slough', exudate: 'high', infection: 'no',
    primary: ['Alginates', 'Gelling Fibers', 'Hypertonic Saline'],
    secondary: ['Super-absorbent dressing'] },

  // --- Granulation — rows 19–24 ---
  { id: 19, tissue: 'granulating', exudate: 'low', infection: 'yes',
    primary: ['Antimicrobial (Alginogels)', 'Antimicrobial (Medical Grade Honey)', 'Antimicrobial (Wound Gels)', 'Antimicrobial (Sucrose-octasulfate)'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 20, tissue: 'granulating', exudate: 'low', infection: 'no',
    primary: ['Low absorbent', 'Foam or absorbent dressing (consider contact layer)'],
    secondary: ['Low absorbent, foam or absorbent dressing (consider contact layer)'] },
  { id: 21, tissue: 'granulating', exudate: 'moderate', infection: 'yes',
    primary: ['Antimicrobial (Alginogels)', 'Antimicrobial (Iodophors)', 'Antimicrobial (Silver Alginates)', 'Antimicrobial (Silver Foam)', 'Antimicrobial (Silver wound contact layer)', 'Antimicrobial (Silver Silicone)', 'Antimicrobial (Silver Charcoal)', 'Antimicrobial (Sucrose-octasulfate)', 'Antimicrobial (DACC-coated)', 'Antimicrobial (Collagen-based)', 'Hydroactive (in conjunction with systemic antimicrobial therapy)', 'Gelling Fibers (in conjunction with systemic antimicrobial therapy)'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 22, tissue: 'granulating', exudate: 'moderate', infection: 'no',
    primary: ['Foam dressing or absorbent dressing', 'Alginates', 'Hydroactive', 'Gelling Fibers'],
    secondary: ['Foam or absorbent dressing'] },
  { id: 23, tissue: 'granulating', exudate: 'high', infection: 'yes',
    primary: ['Antimicrobial (Iodophors)', 'Antimicrobial (Silver Alginates)', 'Antimicrobial (Silver wound contact layer)', 'Antimicrobial (Silver Charcoal)', 'Antimicrobial (Silver gelling fibres)', 'Antimicrobial (DACC-coated)', 'Antimicrobial (Collagen-based)', 'Hydroactive (in conjunction with systemic antimicrobial therapy)', 'Gelling Fibers (in conjunction with systemic antimicrobial therapy)'],
    secondary: ['Super-absorbent dressing'] },
  { id: 24, tissue: 'granulating', exudate: 'high', infection: 'no',
    primary: ['Super-absorbent dressing', 'Alginates', 'Hydroactive', 'Gelling Fibers'],
    secondary: ['Super-absorbent dressing'] },

  // --- Epithelialising — rows 25–26 (low exudate only) ---
  { id: 25, tissue: 'epithelialising', exudate: 'low', infection: 'no',
    primary: ['Low absorbent or foam'],
    secondary: [] },
  { id: 26, tissue: 'epithelialising', exudate: 'low', infection: 'yes',
    primary: ['Low absorbent or foam'],
    secondary: [],
    note: 'Consider escalation of care / review for possible soft-tissue infection.' },
];

// ===========================================================================
// CWCS module — dressing selection (OUTPUT)
// ===========================================================================
function pathwayKey(t: TissueType, e: ExudateLevel, i: Infection): string {
  return `${t}|${e}|${i}`;
}

const PATHWAY_INDEX = new Map<string, CwcsPathway>(
  CWCS_PATHWAYS.map((p) => [pathwayKey(p.tissue, p.exudate, p.infection), p]),
);

export function lookupPathway(
  tissue: TissueType,
  exudate: ExudateLevel,
  infection: Infection,
): CwcsPathway | null {
  return PATHWAY_INDEX.get(pathwayKey(tissue, exudate, infection)) ?? null;
}

export function getPathwayById(id: number): CwcsPathway | null {
  return CWCS_PATHWAYS.find((p) => p.id === id) ?? null;
}

// ===========================================================================
// Reconciliation — BRIDGE (tissue breakdown → single CWCS tissue type)
// Guide precedence: necrotic > slough > granulating > epithelialising
// ("if the wound has both slough and granulation, follow the slough guide").
// Necrotic is split into ischaemic vs non-ischaemic by perfusion (Step 3).
// ===========================================================================
export function reconcileTissue(
  tissue: TissueBreakdown,
  perfusion: PerfusionStatus = 'unknown',
): { tissueType: TissueType | null; notes: string[] } {
  const notes: string[] = [];
  const thr = TISSUE_PRESENCE_THRESHOLD;

  let base: 'necrotic' | 'slough' | 'granulating' | 'epithelialising' | null = null;
  if (tissue.necrosis >= thr) base = 'necrotic';
  else if (tissue.slough >= thr) base = 'slough';
  else if (tissue.granulation >= thr) base = 'granulating';
  else if (tissue.epithelial >= thr) base = 'epithelialising';
  else {
    // Nothing clears the threshold — fall back to the largest class present.
    const ranked: { name: 'necrotic' | 'slough' | 'granulating' | 'epithelialising'; pct: number }[] = [
      { name: 'necrotic', pct: tissue.necrosis },
      { name: 'slough', pct: tissue.slough },
      { name: 'granulating', pct: tissue.granulation },
      { name: 'epithelialising', pct: tissue.epithelial },
    ];
    ranked.sort((a, b) => b.pct - a.pct);
    if (ranked[0].pct > 0) {
      base = ranked[0].name;
      notes.push(`No tissue class reached ${thr}% — using the largest present (${base}).`);
    }
  }

  if (base === null) {
    notes.push('No wound-bed tissue detected — tissue type could not be determined.');
    return { tissueType: null, notes };
  }

  if (base !== 'necrotic') {
    return { tissueType: base, notes };
  }

  return { tissueType: splitNecrotic(perfusion, notes), notes };
}

/** Necrotic → ischaemic / non-ischaemic by perfusion (Mölnlycke Step 3). */
function splitNecrotic(perfusion: PerfusionStatus, notes: string[]): TissueType {
  if (perfusion === 'ischaemic') return 'necrotic_ischaemic';
  if (perfusion === 'non_ischaemic') return 'necrotic';
  notes.push(
    'Necrotic tissue with perfusion not assessed — defaulting to non-ischaemic. Assess ABPI (Mölnlycke Step 3) to confirm.',
  );
  return 'necrotic';
}

/**
 * Apply the clinician's confirmed dominant tissue (segmentation spec §4.3).
 *
 * The percentages are a measurement; the dominant tissue is a judgement, and on
 * this step a clinician has looked at the wound and made it. Their choice wins,
 * and the note records whether it agreed with the measurement — that is the
 * `tissue_override` signal the correction log tracks.
 */
export function applyTissueOverride(
  measured: TissueType | null,
  override: ClinicianTissueChoice,
  perfusion: PerfusionStatus = 'unknown',
): { tissueType: TissueType; changed: boolean; notes: string[] } {
  const notes: string[] = [];
  const tissueType = override === 'necrotic' ? splitNecrotic(perfusion, notes) : override;
  const measuredBase = measured === 'necrotic_ischaemic' ? 'necrotic' : measured;
  const changed = measuredBase !== override;
  notes.unshift(
    changed
      ? `Dominant tissue changed by the clinician from ${measured ?? 'undetermined'} to ${tissueType}.`
      : `Dominant tissue confirmed by the clinician (${tissueType}).`,
  );
  return { tissueType, changed, notes };
}

// ===========================================================================
// Reconciliation — VLM corroboration (Phase 2)
//
// The cage in one sentence: the VLM can lower our confidence, raise an
// infection suspicion, and fill an exudate gap — it can never change the tissue
// type, never overturn a clinician answer, and never clear a concern.
// ===========================================================================

/** Ordered exudate bands, used to measure how far the VLM is from the answer. */
const EXUDATE_ORDER: ExudateLevel[] = ['low', 'moderate', 'high'];

/** Collapse the VLM's five-band visual estimate onto the CWCS three-band axis. */
function visualExudateToLevel(v: VisualExudate): ExudateLevel | null {
  if (v === 'none' || v === 'low') return 'low';
  if (v === 'moderate') return 'moderate';
  if (v === 'high' || v === 'very_high') return 'high';
  return null; // 'uncertain' carries no information
}

export type ExudateReconciliation = {
  exudate: ExudateLevel | null;
  /** Cap applied to overall confidence when the VLM had to stand in for the answer. */
  confidenceCap: Confidence | null;
  downgrade: boolean;
  notes: string[];
};

/**
 * Exudate axis. The clinician/patient answer is authoritative; the VLM's visual
 * estimate is only consulted when that answer is missing, and then confidence is
 * capped at medium. A disagreement of more than one band downgrades confidence.
 */
export function reconcileExudate(
  answered: ExudateLevel | undefined,
  vlm: VlmFeatures | undefined,
): ExudateReconciliation {
  const notes: string[] = [];
  const visual = vlm ? visualExudateToLevel(vlm.visualExudate) : null;

  if (answered) {
    if (visual) {
      const distance = Math.abs(EXUDATE_ORDER.indexOf(answered) - EXUDATE_ORDER.indexOf(visual));
      if (distance > 1) {
        notes.push(
          `Reported exudate (${answered}) and the image estimate (${visual}) disagree by more than one level — using the reported value, confidence reduced.`,
        );
        return { exudate: answered, confidenceCap: null, downgrade: true, notes };
      }
    }
    return { exudate: answered, confidenceCap: null, downgrade: false, notes };
  }

  if (visual) {
    notes.push(`Exudate level not reported — using the image estimate (${visual}). Confirm with the person being assessed.`);
    return { exudate: visual, confidenceCap: 'medium', downgrade: false, notes };
  }

  return { exudate: null, confidenceCap: null, downgrade: false, notes };
}

/** Classic infection signs the VLM reports. Purulence alone is sufficient. */
const CLASSIC_SIGNS: (keyof VlmFeatures['infectionSigns'])[] = [
  'erythema',
  'warmth',
  'purulent',
  'malodour',
];

export type InfectionReconciliation = {
  infection: Infection | null;
  notes: string[];
};

/**
 * Infection axis — a conservative OR, not a vote.
 *
 * `yes` if the answer says yes, OR purulent discharge is seen, OR two or more
 * classic signs are seen. `no` only when the answer says no AND the VLM saw no
 * sign at all. Anything else is null → incomplete. The VLM can never establish
 * `no` on its own: absence of visible signs is not absence of infection.
 */
export function reconcileInfection(
  answered: Infection | undefined,
  vlm: VlmFeatures | undefined,
  /** Clinician-found signs that are not in the image (e.g. induration), named for the notes. */
  clinicalSigns: readonly string[] = [],
): InfectionReconciliation {
  const notes: string[] = [];

  const signs = vlm?.infectionSigns;
  const present: string[] = [...(signs ? CLASSIC_SIGNS.filter((k) => signs[k] === 'present') : []), ...clinicalSigns];
  const anyPresent = present.length > 0 || signs?.friableGranulation === 'present';
  const purulent = signs?.purulent === 'present';

  if (answered === 'yes') {
    return { infection: 'yes', notes };
  }

  if (purulent || present.length >= 2) {
    if (answered === 'no') {
      notes.push(
        `Infection was reported as absent, but ${purulent ? 'the image shows purulent discharge' : present.length + ' infection signs were found (' + present.join(', ') + ')'} — treated as possible infection.`,
      );
    } else {
      notes.push(
        `${purulent ? 'Image shows purulent discharge' : present.length + ' infection signs found (' + present.join(', ') + ')'} — treated as possible infection.`,
      );
    }
    return { infection: 'yes', notes };
  }

  if (answered === 'no') {
    if (anyPresent) {
      notes.push('Infection reported as absent but a possible sign was found — confirm before proceeding.');
      return { infection: null, notes };
    }
    return { infection: 'no', notes };
  }

  return { infection: null, notes };
}

// ===========================================================================
// Clinician-only inputs (segmentation spec §4.4, §4.5)
// ===========================================================================

const NEUTRAL_VLM: VlmFeatures = {
  infectionSigns: { erythema: 'uncertain', warmth: 'uncertain', purulent: 'uncertain', malodour: 'uncertain', friableGranulation: 'uncertain' },
  edgeType: 'uncertain',
  visualExudate: 'uncertain',
  tissueCorroboration: 'uncertain',
  imageFlags: [],
};

/** Monk Skin Tone at or above this: redness is hard to see, so "none seen" is not evidence. */
export const DARK_SKIN_MONK_TONE = 7;

/**
 * Fold the clinician's hands-on findings into the image's observations, BEFORE
 * the infection axis is reconciled. Two rules, both conservative:
 *
 *  1. Dark-skin rule: at Monk tone ≥ 7, an image reporting erythema `absent` is
 *     treated as `uncertain`. Absence of visible redness on darker skin is not
 *     evidence of no infection.
 *  2. Palpated warmth OVERRIDES the image's warmth — a hand on the skin beats a
 *     guess from pixels. warmer/hot → present; cooler/same → absent.
 *
 * Induration is returned as a clinician-found sign: it is counted alongside the
 * image's signs by `reconcileInfection`.
 */
export function applyClinicalFindings(
  vlm: VlmFeatures | undefined,
  clinical: ClinicalInputs | undefined,
): { vlm: VlmFeatures | undefined; clinicalSigns: string[]; notes: string[] } {
  const notes: string[] = [];
  const clinicalSigns: string[] = [];
  if (!clinical) return { vlm, clinicalSigns, notes };

  let out = vlm;
  const tone = clinical.monkTone;
  if (out && typeof tone === 'number' && tone >= DARK_SKIN_MONK_TONE && out.infectionSigns.erythema === 'absent') {
    out = { ...out, infectionSigns: { ...out.infectionSigns, erythema: 'uncertain' } };
    notes.push('On darker skin, no visible redness is not evidence of no infection — treated as uncertain.');
  }

  const palpated = clinical.palpatedWarmth;
  if (palpated) {
    const warmth = palpated === 'warmer' || palpated === 'hot' ? 'present' : 'absent';
    out = { ...(out ?? NEUTRAL_VLM), infectionSigns: { ...(out ?? NEUTRAL_VLM).infectionSigns, warmth } };
    notes.push(`Warmth by touch (${palpated}) used instead of the image's estimate.`);
  }

  if (clinical.induration === 'yes') {
    clinicalSigns.push('induration');
    notes.push('Induration found on examination — counted as an infection sign.');
  }

  return { vlm: out, clinicalSigns, notes };
}

/** Referrals from clinician-only inputs and the image's deep-structures finding. */
export function clinicalFlags(clinical: ClinicalInputs | undefined, vlm: VlmFeatures | undefined): ReferralFlag[] {
  const flags: ReferralFlag[] = [];
  if (vlm?.deepStructuresVisible === 'present') {
    flags.push({
      urgency: 'urgent',
      code: 'deep_structures_visible',
      message: 'Bone, tendon or a deep cavity visible → urgent referral (probe-to-bone pathway; possible osteomyelitis).',
    });
  }
  if (clinical?.underminingTunnelling === 'yes') {
    flags.push({
      urgency: 'mdt',
      code: 'undermining_tunnelling',
      message: `Undermining or tunnelling${typeof clinical.underminingClock === 'number' ? ` at ${clinical.underminingClock} o'clock` : ''} → consider multidisciplinary team review.`,
    });
  }
  return flags;
}

// ===========================================================================
// Mölnlycke module — FRAME + SAFETY (referral / escalation triggers)
// Returns flags ordered by urgency (urgent > mdt > review).
// ===========================================================================
const URGENCY_ORDER: Record<string, number> = { urgent: 0, mdt: 1, review: 2 };

export function molnlyckeFlags(
  m: MolnlyckeInputs = {},
  tissueType: TissueType | null = null,
): ReferralFlag[] {
  const flags: ReferralFlag[] = [];

  // Step 2 — probe to bone
  if (m.probeToBone) {
    flags.push({ urgency: 'urgent', code: 'probe_to_bone', message: 'Probe-to-bone positive → urgent referral (possible osteomyelitis).' });
  }
  // Steps 9–10 — systemic / spreading infection
  if (m.systemicInfection) {
    flags.push({ urgency: 'urgent', code: 'systemic_infection', message: 'Signs of systemic infection → urgent referral.' });
  }
  if (m.spreadingErythemaOver2cm) {
    flags.push({ urgency: 'urgent', code: 'spreading_infection', message: 'Erythema >2 cm from the wound edge → spreading infection; urgent review.' });
  }
  // Step 3 — tissue perfusion (ABPI)
  if (typeof m.abpi === 'number') {
    if (m.abpi < 0.5) {
      flags.push({ urgency: 'urgent', code: 'critical_ischaemia', message: 'ABPI < 0.5 → urgent vascular referral (critical ischaemia).' });
    } else if (m.abpi > 1.4) {
      flags.push({ urgency: 'review', code: 'incompressible_arteries', message: 'ABPI > 1.4 → measure Toe-Brachial Pressure Index (TBPI).' });
    }
  } else if (m.diabetes) {
    flags.push({ urgency: 'review', code: 'diabetes_tbpi', message: 'Diabetes → consider Toe-Brachial Pressure Index (TBPI) as ABPI may be unreliable.' });
  }
  // Step 6 — black necrotic tissue → debridement MDT
  if (tissueType === 'necrotic' || tissueType === 'necrotic_ischaemic') {
    flags.push({ urgency: 'mdt', code: 'necrotic_tissue', message: 'Black necrotic tissue → refer to multidisciplinary team (debridement).' });
  }
  // Step 1 — hard-to-heal / DFU
  if (m.hardToHeal || m.diabeticFootUlcer) {
    flags.push({ urgency: 'mdt', code: 'hard_to_heal', message: 'DFU or <40% healing in 4 weeks → multidisciplinary team review.' });
  }
  // Step 8 — loss of protective sensation
  if (m.lossOfProtectiveSensation) {
    flags.push({ urgency: 'mdt', code: 'lops', message: 'Loss of protective sensation → MDT (offloading / foot protection).' });
  }

  return flags.sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
}

// ===========================================================================
// Engine — gather → reconcile → flags → lookup → merge
// ===========================================================================
function downgrade(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

export function evaluate(inputs: EngineInputs): EngineResult {
  const notes: string[] = [];
  const incompleteReasons: string[] = [];
  const gateCodes: string[] = [];

  // --- Tissue axis: HSI inside the wound mask is authoritative. ------------
  const reconciled = reconcileTissue(inputs.tissue, inputs.perfusion ?? 'unknown');
  let tissueType = reconciled.tissueType;
  const tissueNotes = reconciled.notes;
  notes.push(...tissueNotes);

  const noClassReachedThreshold = tissueNotes.some((n) => n.startsWith('No tissue class'));

  // A clinician-confirmed dominant tissue replaces the reconciled one. It also
  // resolves the tissue_conflict gate below: that gate exists because two
  // automated signals disagreed and nobody had looked — now somebody has.
  const clinicianConfirmed = inputs.tissueOverride !== undefined;
  if (inputs.tissueOverride) {
    const override = applyTissueOverride(tissueType, inputs.tissueOverride, inputs.perfusion ?? 'unknown');
    tissueType = override.tissueType;
    notes.push(...override.notes);
  }

  // The VLM may disagree with the measured tissue composition. It does NOT get
  // to change the class — it costs us confidence, and where the measurement was
  // already weak, the two doubts together make the result unsafe to act on.
  let tissueConflict = false;
  if (inputs.vlm?.tissueCorroboration === 'disagrees') {
    tissueConflict = true;
    notes.push('The image review disagrees with the measured tissue composition — confidence reduced.');
    if (noClassReachedThreshold && !clinicianConfirmed) {
      gateCodes.push('tissue_conflict');
      incompleteReasons.push('The tissue in the wound bed could not be identified reliably.');
    }
  }

  // --- Exudate + infection axes: reconcile answers with caged VLM features.
  const exudateRecon = reconcileExudate(inputs.exudate, inputs.vlm);
  notes.push(...exudateRecon.notes);
  const exudate = exudateRecon.exudate;

  // Hands-on findings refine the image's infection signs before they count.
  const clinicalView = applyClinicalFindings(inputs.vlm, inputs.clinical);
  notes.push(...clinicalView.notes);
  const infectionRecon = reconcileInfection(inputs.infection, clinicalView.vlm, clinicalView.clinicalSigns);
  notes.push(...infectionRecon.notes);
  const infection = infectionRecon.infection;

  if (tissueType === null) incompleteReasons.push('Tissue type could not be determined.');
  if (exudate === null) incompleteReasons.push('Exudate level not provided.');
  if (infection === null) incompleteReasons.push('Infection status not provided.');

  // Periwound erythema corroborates the spreading-infection trigger but never
  // fires it alone — the >2 cm judgement belongs to the assessor.
  if (inputs.periwound?.maceration) {
    notes.push('The skin around the wound looks waterlogged — consider protecting the surrounding skin.');
  }

  const referrals = [...molnlyckeFlags(inputs.molnlycke ?? {}, tissueType), ...clinicalFlags(inputs.clinical, inputs.vlm)].sort(
    (a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency],
  );
  if (typeof inputs.clinical?.depthMm === 'number' && inputs.clinical.depthMm > 0) {
    notes.push(
      `Depth ${inputs.clinical.depthMm} mm recorded${inputs.vlm?.deepStructuresVisible === 'present' ? ' with a visible cavity — full-thickness wound' : ''}.`,
    );
  }
  if (inputs.clinical?.oedema === 'yes') {
    notes.push('Oedema recorded.');
  }

  let cwcsPathwayId: number | null = null;
  let primary: string[] = [];
  let secondary: string[] = [];

  if (tissueType && exudate && infection) {
    const pathway = lookupPathway(tissueType, exudate, infection);
    if (pathway) {
      cwcsPathwayId = pathway.id;
      primary = pathway.primary;
      secondary = pathway.secondary;
      if (pathway.note) notes.push(pathway.note);
    } else if (tissueType === 'epithelialising' && exudate !== 'low') {
      notes.push('No CWCS pathway: epithelialising wounds are catered for at low exudate only — reassess exudate or tissue.');
    } else {
      notes.push(`No CWCS pathway for (${tissueType}, ${exudate} exudate, infection: ${infection}).`);
    }
  }

  // --- Confidence gate — conservative by default. --------------------------
  let confidence: Confidence = inputs.cvConfidence ?? 'medium';
  const hasScale = inputs.markerFound !== false || inputs.manualSizeProvided === true;

  if (inputs.markerFound === false) {
    if (inputs.manualSizeProvided) {
      notes.push('No size-reference marker detected — using the size entered by hand.');
    } else {
      confidence = downgrade(confidence);
      notes.push('No size-reference marker detected — measurements are relative only.');
    }
  }
  if (noClassReachedThreshold) {
    confidence = downgrade(confidence);
  }
  if (tissueConflict) {
    confidence = downgrade(confidence);
  }
  if (exudateRecon.downgrade) {
    confidence = downgrade(confidence);
  }
  if (exudateRecon.confidenceCap === 'medium' && confidence === 'high') {
    confidence = 'medium';
  }

  const imageFlags = inputs.vlm?.imageFlags ?? [];
  if (imageFlags.includes('low_light')) {
    confidence = downgrade(confidence);
    notes.push('The photo is underexposed — a brighter, well-lit photo would give a more reliable result.');
  }

  // --- Safety gate: withhold the pathway rather than state it weakly. ------
  // A pathway we cannot stand behind is worse than no pathway, because it will
  // be acted on. These three conditions withhold it even when the axes resolved.
  if (imageFlags.includes('blur')) {
    gateCodes.push('blurred_image');
    incompleteReasons.push('The photo is too blurred to assess — please retake it.');
    confidence = 'low';
  }
  if (!hasScale) {
    gateCodes.push('no_scale');
    incompleteReasons.push('No size reference in the photo — add a marker or enter the wound size by hand.');
  }

  const pathwayWithheld = cwcsPathwayId !== null && gateCodes.length > 0;
  if (pathwayWithheld) {
    notes.push('A dressing suggestion was withheld because the assessment is not reliable enough to act on.');
    cwcsPathwayId = null;
    primary = [];
    secondary = [];
  }

  const status: 'complete' | 'incomplete' =
    incompleteReasons.length === 0 && cwcsPathwayId !== null ? 'complete' : 'incomplete';

  if (referrals.some((f) => f.urgency === 'urgent')) {
    notes.unshift('Urgent referral flag present — clinical review takes priority over dressing selection.');
  }

  return {
    status,
    incompleteReasons,
    pathwayWithheld,
    gateCodes,
    axes: { tissue: tissueType, exudate, infection },
    cwcsPathwayId,
    primary,
    secondary,
    referrals,
    confidence,
    notes,
    rulesVersion: CWCS_RULES_VERSION,
  };
}
