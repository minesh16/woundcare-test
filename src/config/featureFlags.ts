/**
 * Feature flags for the additive MendWise "assessment V2" pipeline.
 *
 * Per the cage (docs/HANDOFF.md): new work (SAM 2 segmentation, caged VLM, etc.)
 * sits behind `assessmentV2` and defaults OFF so the existing capture → analyze →
 * questions → result demo flow is never affected until explicitly enabled.
 *
 * Enable on the client with `EXPO_PUBLIC_ASSESSMENT_V2=true`.
 */
export const ASSESSMENT_V2 =
  process.env.EXPO_PUBLIC_ASSESSMENT_V2 === 'true' ||
  process.env.EXPO_PUBLIC_ASSESSMENT_V2 === '1';
