import {
  AssessmentResult,
  Classification,
  ScanSession,
  UrgencyLevel,
} from '@/decision/types';

import { BODY_ZONE_LABELS } from '@/constants/bodyZones';
import { evaluate } from './engine';
import type { EngineInputs } from './engine.types';

/**
 * Adapt the current demo capture/questionnaire into the deterministic CWCS/
 * Mölnlycke engine inputs. Mappings marked "provisional" are placeholders that
 * the Phase 2 caged-VLM + structured Q&A pipeline will replace with real signals
 * (perfusion/ABPI, explicit infection, epithelial tissue, etc.).
 */
function toEngineInputs(session: ScanSession): EngineInputs {
  const { cv, answers } = session;

  const tissue = {
    necrosis: cv?.necrosisPercent ?? 0,
    slough: cv?.sloughPercent ?? 0,
    granulation: cv?.granulationPercent ?? 0,
    epithelial: 0, // Phase 1: add epithelial detection to the CV layer.
    other: cv?.otherPercent ?? 0,
  };

  const exudate =
    answers.exudate === 'heavy'
      ? 'high'
      : answers.exudate === 'moderate'
        ? 'moderate'
        : answers.exudate === 'none'
          ? 'low'
          : undefined;

  // Provisional infection proxy from available demo signals.
  const infection =
    answers.warmth === 'yes' || answers.exudate === 'heavy'
      ? 'yes'
      : answers.warmth === 'no'
        ? 'no'
        : undefined;

  return {
    tissue,
    perfusion: 'unknown', // Phase 2: derive from ABPI/perfusion Q&A.
    exudate,
    infection,
    cvConfidence: cv?.confidence,
    markerFound: cv?.coinDetected,
    molnlycke: {
      diabetes: answers.diabetes === 'yes',
    },
  };
}

function classifyWound(session: ScanSession): Classification {
  const { answers, cv } = session;

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
  const { answers, cv, bodyZone } = session;

  if (answers.durationOver30Days === 'yes') {
    rationale.push('Wound reported present for more than 30 days → likely chronic.');
  } else if (answers.durationOver30Days === 'no') {
    rationale.push('Wound reported present for 30 days or less → likely acute.');
  }

  if (cv) {
    rationale.push(
      `Image analysis (demo): ${cv.granulationPercent}% granulation, ${cv.sloughPercent}% slough, ${cv.necrosisPercent}% necrosis.`,
    );
    if (cv.sloughPercent + cv.necrosisPercent > 50) {
      rationale.push('High slough/necrosis proportion in image → supports chronic/healing-delay pattern.');
    }
    if (cv.areaCm2) {
      rationale.push(`Estimated wound area: ${cv.areaCm2.toFixed(1)} cm² (coin reference used).`);
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

export function assess(session: ScanSession): AssessmentResult {
  const classification = classifyWound(session);
  let urgency = assessUrgency(session);
  const rationale = buildRationale(session, classification, urgency);

  // Deterministic guideline engine (CWCS dressing + Mölnlycke referrals).
  const engine = evaluate(toEngineInputs(session));

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
