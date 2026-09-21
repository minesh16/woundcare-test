import type { EngineResult } from '../decision/engine.types';
import {
  CONFIDENCE_PLAIN,
  EXUDATE_PLAIN,
  GATE_PLAIN,
  INFECTION_PLAIN,
  TISSUE_CLINICAL,
  TISSUE_PLAIN,
} from '../copy/plainLanguage';
import { referralCopy, URGENCY_PLAIN } from '../copy/referrals';

/**
 * Deterministic report writer.
 *
 * Imports are RELATIVE, not `@/`-aliased, and must stay that way: this module is
 * reachable from `api/`, and Vercel's function bundler does not read tsconfig
 * `paths`. Metro resolves the alias fine, so an aliased value import here builds
 * clean, typechecks clean, works in the app — and throws at module load in the
 * deployed function. `scripts/test-rules.mts` guards against the regression.
 *
 * This ships before the report LLM and stays available forever: it is the
 * fallback whenever the gateway is unconfigured, slow, or returns something
 * that fails the cage check in `report.ts`. The pitch has to survive an AI
 * outage, and so does anyone relying on the app.
 *
 * Pure function of an already-decided `EngineResult`. It cannot introduce a
 * recommendation, because it has no source of one.
 */

export type ReportFacts = {
  result: EngineResult;
  areaCm2?: number | null;
  bodyZoneLabel?: string | null;
  tissuePct?: { granulation: number; slough: number; necrosis: number; epithelial: number } | null;
};

function sizeLine(areaCm2?: number | null): string {
  return areaCm2
    ? `Measured wound area: ${areaCm2.toFixed(1)} cm².`
    : 'Wound size was not measured — no size reference was available in the photo.';
}

export function clinicianReport(facts: ReportFacts): string {
  const { result } = facts;
  const lines: string[] = [];

  lines.push('WOUND ASSESSMENT — DECISION SUPPORT SUMMARY');
  lines.push(`Rules version: ${result.rulesVersion}`);
  lines.push(`Assessment status: ${result.status}${result.pathwayWithheld ? ' (pathway withheld by safety gate)' : ''}`);
  lines.push(`Confidence: ${result.confidence}`);
  lines.push('');

  lines.push('FINDINGS');
  if (facts.bodyZoneLabel) lines.push(`Location: ${facts.bodyZoneLabel}.`);
  lines.push(sizeLine(facts.areaCm2));
  if (facts.tissuePct) {
    lines.push(
      `Tissue composition inside the wound boundary: ${facts.tissuePct.granulation}% granulation, ` +
        `${facts.tissuePct.slough}% slough, ${facts.tissuePct.necrosis}% necrosis, ` +
        `${facts.tissuePct.epithelial}% epithelialising.`,
    );
  }
  lines.push(
    `Derived axes — tissue: ${result.axes.tissue ? TISSUE_CLINICAL[result.axes.tissue] : 'not determined'}; ` +
      `exudate: ${result.axes.exudate ?? 'not determined'}; infection: ${result.axes.infection ?? 'not determined'}.`,
  );
  lines.push('');

  lines.push('DRESSING SELECTION');
  if (result.cwcsPathwayId !== null) {
    lines.push(`Australian Government CWCS pathway ${result.cwcsPathwayId}.`);
    lines.push(`Primary: ${result.primary.join('; ')}.`);
    if (result.secondary.length) lines.push(`Secondary: ${result.secondary.join('; ')}.`);
  } else if (result.pathwayWithheld) {
    lines.push('Withheld. The axes resolved but a safety gate fired; see gates below.');
  } else {
    lines.push('Not determined — insufficient inputs.');
  }
  lines.push('');

  if (result.referrals.length) {
    lines.push('REFERRAL / ESCALATION FLAGS');
    for (const flag of result.referrals) {
      lines.push(`[${flag.urgency.toUpperCase()}] ${flag.code}: ${flag.message}`);
    }
    lines.push('');
  }

  if (result.gateCodes.length) {
    lines.push('SAFETY GATES');
    for (const code of result.gateCodes) lines.push(`- ${code}`);
    lines.push('');
  }

  if (result.incompleteReasons.length) {
    lines.push('INCOMPLETE');
    for (const reason of result.incompleteReasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  if (result.notes.length) {
    lines.push('NOTES');
    for (const note of result.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('Guideline-based decision support / research prototype — not a medical device.');
  lines.push('Confirm with a clinician before acting on this summary.');
  return lines.join('\n');
}

export function patientSummary(facts: ReportFacts): string {
  const { result } = facts;
  const lines: string[] = [];

  const urgent = result.referrals.find((f) => f.urgency === 'urgent');
  if (urgent) {
    const copy = referralCopy(urgent);
    lines.push(`What to do: ${copy.whatToDo}`);
    lines.push('');
    lines.push(`${copy.title}. ${copy.whatThisMeans}`);
  } else if (result.referrals.length) {
    const first = result.referrals[0];
    const copy = referralCopy(first);
    lines.push(`What to do: ${copy.whatToDo}`);
    lines.push('');
    lines.push(`${copy.title}. ${copy.whatThisMeans}`);
  } else {
    lines.push('What to do: Keep caring for the wound and have it reviewed if it is not improving.');
  }
  lines.push('');

  lines.push('What we saw');
  if (facts.bodyZoneLabel) lines.push(`- Location: ${facts.bodyZoneLabel}.`);
  lines.push(
    facts.areaCm2
      ? `- The wound measures about ${facts.areaCm2.toFixed(1)} square centimetres.`
      : '- We could not measure the size of the wound from this photo.',
  );
  if (result.axes.tissue) lines.push(`- The wound bed is mostly ${TISSUE_PLAIN[result.axes.tissue]}.`);
  if (result.axes.exudate) lines.push(`- There is ${EXUDATE_PLAIN[result.axes.exudate]} coming from the wound.`);
  if (result.axes.infection) lines.push(`- We found ${INFECTION_PLAIN[result.axes.infection]}.`);
  lines.push('');

  if (result.cwcsPathwayId !== null) {
    lines.push('Suggested dressing type');
    for (const item of result.primary) lines.push(`- ${item}`);
    lines.push(`Based on the Australian Government wound care guide (pathway ${result.cwcsPathwayId}).`);
    lines.push('');
  } else if (result.gateCodes.length) {
    lines.push('Why there is no dressing suggestion');
    for (const code of result.gateCodes) {
      const gate = GATE_PLAIN[code];
      if (gate) lines.push(`- ${gate.title}. ${gate.whatToDo}`);
    }
    lines.push('');
  }

  lines.push(CONFIDENCE_PLAIN[result.confidence]);
  lines.push('');
  lines.push('This is a research prototype, not a medical device. It does not replace advice from a clinician.');
  return lines.join('\n');
}

export function renderTemplateReport(facts: ReportFacts): { clinicianReport: string; patientSummary: string } {
  return { clinicianReport: clinicianReport(facts), patientSummary: patientSummary(facts) };
}

/** Urgency wording used by the result screen's headline action. */
export { URGENCY_PLAIN };
