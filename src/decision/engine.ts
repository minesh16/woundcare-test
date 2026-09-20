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
 * AI (SAM 2 / HSI / VLM / LLM) only produces the *inputs* to this engine and
 * narrates its *outputs* — it never makes the dressing decision here.
 *
 * Runtime-only imports are avoided so the file runs under `node
 * --experimental-strip-types` for tests (see scripts/test-rules.mts).
 */

import type {
  Confidence,
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
} from './engine.types';

export const CWCS_RULES_VERSION = 'cwcs-2024.1';

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

  if (perfusion === 'ischaemic') return { tissueType: 'necrotic_ischaemic', notes };
  if (perfusion === 'non_ischaemic') return { tissueType: 'necrotic', notes };
  notes.push(
    'Necrotic tissue with perfusion not assessed — defaulting to non-ischaemic. Assess ABPI (Mölnlycke Step 3) to confirm.',
  );
  return { tissueType: 'necrotic', notes };
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

  const { tissueType, notes: tissueNotes } = reconcileTissue(
    inputs.tissue,
    inputs.perfusion ?? 'unknown',
  );
  notes.push(...tissueNotes);

  const exudate: ExudateLevel | null = inputs.exudate ?? null;
  const infection: Infection | null = inputs.infection ?? null;

  if (tissueType === null) incompleteReasons.push('Tissue type could not be determined.');
  if (exudate === null) incompleteReasons.push('Exudate level not provided.');
  if (infection === null) incompleteReasons.push('Infection status not provided.');

  const referrals = molnlyckeFlags(inputs.molnlycke ?? {}, tissueType);

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

  // Confidence gate — conservative by default.
  let confidence: Confidence = inputs.cvConfidence ?? 'medium';
  if (inputs.markerFound === false) {
    confidence = downgrade(confidence);
    notes.push('No size-reference marker detected — measurements are relative only.');
  }
  if (tissueNotes.some((n) => n.startsWith('No tissue class'))) {
    confidence = downgrade(confidence);
  }

  const status: 'complete' | 'incomplete' =
    incompleteReasons.length === 0 && cwcsPathwayId !== null ? 'complete' : 'incomplete';

  if (referrals.some((f) => f.urgency === 'urgent')) {
    notes.unshift('Urgent referral flag present — clinical review takes priority over dressing selection.');
  }

  return {
    status,
    incompleteReasons,
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
