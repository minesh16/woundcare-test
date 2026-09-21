import type { ReferralFlag, ReferralUrgency } from '@/decision/engine.types';

/**
 * Referral copy, keyed by the engine's stable `code`.
 *
 * The engine emits e.g. `{ urgency: 'urgent', code: 'probe_to_bone', message:
 * 'Probe-to-bone positive → urgent referral (possible osteomyelitis).' }`.
 * That message is the clinical record. This is what the person reads instead.
 *
 * Every entry answers two questions in order: what does this mean, and what do
 * I do now. An unrecognised code falls back to the engine's own message, so a
 * new trigger is never silently dropped from the screen.
 *
 * ⚠️ Pending clinical review — see the note in `plainLanguage.ts`.
 */

export type ReferralCopy = {
  title: string;
  whatThisMeans: string;
  whatToDo: string;
};

export const REFERRAL_COPY: Record<string, ReferralCopy> = {
  probe_to_bone: {
    title: 'This wound may reach the bone',
    whatThisMeans: 'A wound deep enough to touch bone can lead to a bone infection.',
    whatToDo: 'Get medical help today. Do not wait to see if it improves.',
  },
  systemic_infection: {
    title: 'The infection may be spreading through your body',
    whatThisMeans: 'Feeling unwell, feverish or shivery alongside a wound can mean the infection is no longer just in the skin.',
    whatToDo: 'Get medical help now.',
  },
  spreading_infection: {
    title: 'Redness is spreading away from the wound',
    whatThisMeans: 'Redness reaching more than 2 cm beyond the wound edge suggests the infection is spreading into the surrounding skin.',
    whatToDo: 'Get medical help now.',
  },
  critical_ischaemia: {
    title: 'Blood flow to this area looks very poor',
    whatThisMeans: 'Without enough blood supply a wound cannot heal, and the tissue is at risk.',
    whatToDo: 'You need an urgent review by a vascular specialist. Ask your doctor to arrange this today.',
  },
  incompressible_arteries: {
    title: 'The circulation reading may not be reliable',
    whatThisMeans: 'In some people — often with diabetes — the usual circulation test reads higher than the true value.',
    whatToDo: 'Ask your clinician for a toe-pressure test instead.',
  },
  diabetes_tbpi: {
    title: 'Circulation should be checked',
    whatThisMeans: 'Diabetes can make the standard circulation test read higher than the true value.',
    whatToDo: 'Ask your clinician for a toe-pressure test.',
  },
  necrotic_tissue: {
    title: 'There is dead tissue in the wound',
    whatThisMeans: 'Dead tissue stops a wound healing and needs to be removed by a clinician — not at home.',
    whatToDo: 'Ask to be referred to a specialist wound care team.',
  },
  hard_to_heal: {
    title: 'This wound needs specialist care',
    whatThisMeans: 'Foot wounds in people with diabetes, and wounds that have not improved much in four weeks, do better under a specialist team.',
    whatToDo: 'Ask your doctor to refer you to a wound care team.',
  },
  lops: {
    title: 'Reduced feeling in the area',
    whatThisMeans: 'When you cannot feel pressure or injury properly, wounds can get worse without you noticing.',
    whatToDo: 'Ask about footwear and pressure protection from a specialist wound care team.',
  },
};

export const URGENCY_PLAIN: Record<ReferralUrgency, string> = {
  urgent: 'Get help now',
  mdt: 'Ask for a specialist referral',
  review: 'Worth checking',
};

/** Copy for a flag, falling back to the engine's own message for unknown codes. */
export function referralCopy(flag: ReferralFlag): ReferralCopy {
  return (
    REFERRAL_COPY[flag.code] ?? {
      title: URGENCY_PLAIN[flag.urgency],
      whatThisMeans: flag.message,
      whatToDo: 'Discuss this with a clinician.',
    }
  );
}
