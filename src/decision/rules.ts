import {
  AssessmentResult,
  Classification,
  ScanSession,
  UrgencyLevel,
} from '@/decision/types';

import { measuredView } from '@/assessment/measured';
import { BODY_ZONE_LABELS } from '@/constants/bodyZones';
import { evaluate } from './engine';
import type { EngineInputs, EngineResult, PerfusionStatus } from './engine.types';
import type { AbpiBand, PerfusionAnswer } from '@/decision/types';

/** Map the perfusion questionnaire answer to the engine's perfusion status. */
function toPerfusionStatus(answer: PerfusionAnswer | null): PerfusionStatus {
  if (answer === 'normal') return 'non_ischaemic';
  if (answer === 'reduced') return 'ischaemic';
  return 'unknown';
}

/**
 * Map an ABPI band to a representative numeric value so the Mölnlycke Step-3
 * vascular triggers (ABPI < 0.5 → urgent; > 1.4 → TBPI) fire deterministically.
 * Returns undefined when unknown/not provided so no false trigger occurs.
 */
function toAbpiValue(band: AbpiBand | null): number | undefined {
  switch (band) {
    case 'lt_0_5':
      return 0.4;
    case '0_5_to_0_8':
      return 0.65;
    case '0_8_to_1_3':
      return 1.0;
    case 'gt_1_4':
      return 1.5;
    default:
      return undefined;
  }
}

/**
 * Adapt the current demo capture/questionnaire into the deterministic CWCS/
 * Mölnlycke engine inputs. Mappings marked "provisional" are placeholders that
 * the Phase 2 caged-VLM + structured Q&A pipeline will replace with real signals
 * (perfusion/ABPI, explicit infection, epithelial tissue, etc.).
 */
export function toEngineInputs(session: ScanSession): EngineInputs {
  const { answers } = session;
  // The approved outline's measurement when there is one; HSV only in the
  // legacy flow. See `measuredView` for why this must be a single source.
  const measured = measuredView(session);

  const tissue = {
    necrosis: measured?.necrosisPercent ?? 0,
    slough: measured?.sloughPercent ?? 0,
    granulation: measured?.granulationPercent ?? 0,
    epithelial: measured?.epithelialPercent ?? 0,
    other: measured?.otherPercent ?? 0,
  };

  const exudate =
    answers.exudate === 'heavy'
      ? 'high'
      : answers.exudate === 'moderate'
        ? 'moderate'
        : answers.exudate === 'none'
          ? 'low'
          : undefined;

  // Infection axis: prefer the explicit infection-signs answer; otherwise fall
  // back to the provisional proxy from the remaining demo signals.
  const infection =
    answers.infectionSigns === 'yes'
      ? 'yes'
      : answers.infectionSigns === 'no'
        ? 'no'
        : answers.warmth === 'yes' || answers.exudate === 'heavy'
          ? 'yes'
          : answers.warmth === 'no'
            ? 'no'
            : undefined;

  const abpi = toAbpiValue(answers.abpiBand);

  return {
    tissue,
    perfusion: toPerfusionStatus(answers.perfusion),
    exudate,
    infection,
    cvConfidence: measured?.confidence,
    markerFound: measured ? measured.markerFound : undefined,
    periwound: measured?.periwound ?? undefined,
    // The clinician's confirmed dominant tissue (spec §4.3), when given.
    tissueOverride: session.tissueConfirmation?.final,
    clinical: toClinicalInputs(answers),
    molnlycke: {
      diabetes: answers.diabetes === 'yes',
      abpi,
      spreadingErythemaOver2cm: answers.spreadingRedness === 'yes',
    },
  };
}

/** Clinician-only answers (spec §4.4) → engine inputs. Unanswered fields are left out. */
function toClinicalInputs(answers: ScanSession['answers']): EngineInputs['clinical'] {
  const clinical: NonNullable<EngineInputs['clinical']> = {};
  if (answers.palpatedWarmth) clinical.palpatedWarmth = answers.palpatedWarmth;
  if (answers.induration) clinical.induration = answers.induration;
  if (answers.oedema) clinical.oedema = answers.oedema;
  if (answers.underminingTunnelling) clinical.underminingTunnelling = answers.underminingTunnelling;
  if (answers.underminingClock != null) clinical.underminingClock = answers.underminingClock;
  if (answers.depthMm != null) clinical.depthMm = answers.depthMm;
  if (answers.monkTone != null) clinical.monkTone = answers.monkTone;
  return Object.keys(clinical).length > 0 ? clinical : undefined;
}

function classifyWound(session: ScanSession): Classification {
  const { answers } = session;
  const cv = measuredView(session);

  if (answers.durationOver30Days === 'yes') {
    return 'likely_chronic';
  }

  if (answers.durationOver30Days === 'no') {
    return 'likely_acute';
  }

  if (cv && cv.sloughPercent + cv.necrosisPercent > 50) {
    return 'likely_chronic';
  }

  return 'indeterminate';
}

function assessUrgency(session: ScanSession): UrgencyLevel {
  const { answers } = session;

  if (
    answers.exudate === 'heavy' ||
    answers.pain >= 8 ||
    (answers.warmth === 'yes' && answers.pain >= 5)
  ) {
    return 'immediate';
  }

  if (
    answers.warmth === 'yes' ||
    answers.pain >= 7 ||
    answers.exudate === 'moderate' ||
    answers.diabetes === 'yes' ||
    answers.immunocompromised === 'yes'
  ) {
    return 'within_48h';
  }

  return 'routine';
}

function dressingCategory(session: ScanSession, urgency: UrgencyLevel): string {
  if (urgency === 'immediate') {
    return 'Seek clinical review before selecting any dressing.';
  }

  if (session.answers.exudate === 'heavy') {
    return 'Demo: super-absorbent category — clinical review recommended.';
  }

  if (session.answers.exudate === 'moderate') {
    return 'Demo: absorbent foam or alginate category.';
  }

  return 'Demo: low-adherence, moisture-retentive category.';
}

function buildRationale(session: ScanSession, classification: Classification, urgency: UrgencyLevel): string[] {
  const rationale: string[] = [];
  const { answers, bodyZone } = session;
  const cv = measuredView(session);

  if (answers.durationOver30Days === 'yes') {
    rationale.push('Wound reported present for more than 30 days → likely chronic.');
  } else if (answers.durationOver30Days === 'no') {
    rationale.push('Wound reported present for 30 days or less → likely acute.');
  }

  if (cv) {
    rationale.push(
      cv.source === 'approved_outline'
        ? `Tissue measured inside the approved outline: ${cv.granulationPercent}% granulation, ${cv.sloughPercent}% slough, ${cv.necrosisPercent}% necrosis.`
        : `Image analysis (on-device colour estimate, outline not reviewed): ${cv.granulationPercent}% granulation, ${cv.sloughPercent}% slough, ${cv.necrosisPercent}% necrosis.`,
    );
    if (cv.sloughPercent + cv.necrosisPercent > 50) {
      rationale.push('High slough/necrosis proportion in image → supports chronic/healing-delay pattern.');
    }
    if (cv.areaCm2) {
      rationale.push(
        `Estimated wound area: ${cv.areaCm2.toFixed(1)} cm²` +
          (cv.lengthCm && cv.widthCm ? `, ${cv.lengthCm.toFixed(1)} × ${cv.widthCm.toFixed(1)} cm` : '') +
          ' (coin reference used).',
      );
    } else {
      rationale.push('Wound area shown as relative measurement (no scale reference).');
    }
    rationale.push('Depth: not assessed in this demo (2D photo limitation).');
  }

  if (bodyZone) {
    rationale.push(`Location: ${BODY_ZONE_LABELS[bodyZone]}.`);
  }

  if (answers.exudate === 'heavy') {
    rationale.push('Heavy exudate or pus reported → elevated infection concern.');
  }

  if (answers.warmth === 'yes') {
    rationale.push('Warmth around wound reported → possible infection sign.');
  }

  if (answers.pain >= 7) {
    rationale.push(`Pain level ${answers.pain}/10 → supports urgent review.`);
  }

  if (answers.diabetes === 'yes') {
    rationale.push('Diabetes reported → higher complication risk if infection present.');
  }

  if (classification === 'indeterminate') {
    rationale.push('Duration uncertain and image alone inconclusive → classification indeterminate.');
  }

  if (urgency === 'routine') {
    rationale.push('No high-risk combination triggered → routine wound care review suggested.');
  }

  return rationale;
}

/**
 * The result the screen shows.
 *
 * `engineResult` is the server pipeline's decision, when it has one: the same
 * deterministic engine over the same inputs, plus the caged image review. When
 * supplied it is rendered as-is, so the screen cannot show one decision while
 * the audit log records another. Without it, the engine runs here.
 */
export function assess(session: ScanSession, engineResult?: EngineResult | null): AssessmentResult {
  const classification = classifyWound(session);
  let urgency = assessUrgency(session);
  const rationale = buildRationale(session, classification, urgency);

  // Deterministic guideline engine (CWCS dressing + Mölnlycke referrals).
  const engine = engineResult ?? evaluate(toEngineInputs(session));

  // An urgent guideline referral can raise the overall urgency.
  const hasUrgentReferral = engine.referrals.some((r) => r.urgency === 'urgent');
  if (hasUrgentReferral) {
    urgency = 'immediate';
  }

  // Dressing category now comes from the CWCS pathway when the axes are known.
  const dressing =
    engine.cwcsPathwayId !== null
      ? `CWCS pathway ${engine.cwcsPathwayId} — ${engine.axes.tissue}, ${engine.axes.exudate} exudate, infection: ${engine.axes.infection}. ` +
        `Primary: ${engine.primary.join('; ')}.` +
        (engine.secondary.length ? ` Secondary: ${engine.secondary.join('; ')}.` : '')
      : dressingCategory(session, urgency);

  for (const flag of engine.referrals) {
    rationale.push(`Referral (${flag.urgency}): ${flag.message}`);
  }
  for (const note of engine.notes) {
    rationale.push(note);
  }
  if (engine.status === 'incomplete' && engine.incompleteReasons.length > 0) {
    rationale.push(`Assessment incomplete: ${engine.incompleteReasons.join(' ')}`);
  }

  return {
    classification,
    urgency,
    dressingCategory: dressing,
    seekMedicalAttention: urgency !== 'routine' || hasUrgentReferral,
    rationale,
    cwcsPathwayId: engine.cwcsPathwayId,
    tissueType: engine.axes.tissue,
    primaryDressings: engine.primary,
    secondaryDressings: engine.secondary,
    referrals: engine.referrals,
    engineStatus: engine.status,
    rulesVersion: engine.rulesVersion,
    exudateLevel: engine.axes.exudate,
    infection: engine.axes.infection,
    confidence: engine.confidence,
    gateCodes: engine.gateCodes,
    pathwayWithheld: engine.pathwayWithheld,
    areaCm2: measuredView(session)?.areaCm2 ?? null,
  };
}

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  likely_acute: 'Likely acute (demo)',
  likely_chronic: 'Likely chronic (demo)',
  indeterminate: 'Indeterminate (demo)',
};

export const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  immediate: 'Seek medical attention now',
  within_48h: 'Seek review within 48 hours',
  routine: 'Routine wound care review',
};

/**
 * The same three levels phrased as an instruction rather than a label — this is
 * the headline on the result screen, and a label ("Immediate") tells someone
 * what category they are in, not what to do about it.
 */
export const URGENCY_ACTIONS: Record<UrgencyLevel, string> = {
  immediate: 'Get medical help now',
  within_48h: 'See a clinician within 48 hours',
  routine: 'Keep caring for the wound at home',
};
