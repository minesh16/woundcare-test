import type { EngineResult } from './engine.types';

/**
 * The check that keeps the report LLM honest.
 *
 * A narration that invents a pathway or a dressing is worse than no narration,
 * because it reads exactly like the grounded output next to it. So anything
 * that fails here is discarded in favour of the deterministic template rather
 * than being patched up.
 *
 * No path aliases and no runtime imports, so the test harness can load this
 * directly under `node --experimental-strip-types`.
 */
export function violatesCage(text: string, result: EngineResult): string | null {
  const pathwayMentions = text.match(/pathway\s+(\d{1,2})/gi) ?? [];
  for (const mention of pathwayMentions) {
    const id = Number(mention.replace(/\D/g, ''));
    if (result.cwcsPathwayId === null || id !== result.cwcsPathwayId) {
      return `Report names pathway ${id}, which the engine did not decide.`;
    }
  }

  // With no pathway decided there is nothing to recommend, so any dressing talk
  // must be an explanation of the absence rather than a suggestion.
  if (result.cwcsPathwayId === null && /\b(dressing|hydrocolloid|alginate|foam|hydrogel)\b/i.test(text)) {
    const explainsAbsence = /(withheld|not (?:enough|reliable|able)|could not|cannot|no dressing)/i.test(text);
    if (!explainsAbsence) {
      return 'Report discusses dressings although no pathway was decided.';
    }
  }

  return null;
}
