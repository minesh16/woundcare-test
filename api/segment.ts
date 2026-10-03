/**
 * POST /api/segment — alias of POST /api/v1/assessments/segment (segmentation
 * spec §6A.1: "Replaces /api/segment (keep an alias)"). Same handler, same key,
 * same contract.
 */
export { default } from './v1/assessments/segment';
