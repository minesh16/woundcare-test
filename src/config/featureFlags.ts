/**
 * Feature flags for the additive MendWise "assessment V2" pipeline.
 *
 * Per the cage (docs/HANDOFF.md): new work (SAM 2 segmentation, caged VLM, etc.)
 * sits behind `assessmentV2` and defaults OFF so the existing capture → analyze →
 * questions → result demo flow is never affected until explicitly enabled.
 *
 * Enable on the client with `EXPO_PUBLIC_ASSESSMENT_V2=true`.
 *
 * Parsing is case-insensitive and trims whitespace so `true`, `True`, `1`, `yes`,
 * or `on` all enable it — a mismatched case must never silently disable Phase 1.
 */
const truthy = new Set(['true', '1', 'yes', 'on']);

export const ASSESSMENT_V2 = truthy.has(
  (process.env.EXPO_PUBLIC_ASSESSMENT_V2 ?? '').trim().toLowerCase(),
);
