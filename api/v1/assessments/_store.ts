import { createClient, SupabaseClient } from '@supabase/supabase-js';

import type { AssessmentState, StepOutcome } from '../../../src/assessment/state';
import type { EngineInputs, EngineResult } from '../../../src/decision/engine.types';
import { canonicalHash } from '../../_apiCore';

/**
 * Persistence for the V2 pipeline — Supabase, server-side only.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **The service-role key never leaves the server.** Expo inlines every
 *     `EXPO_PUBLIC_*` value into the bundle at build time, web included, so a
 *     key there would be public. The client talks to `/api/v1/*`; only these
 *     functions talk to Supabase.
 *
 *  2. **The database is never on the critical path.** If Supabase is
 *     unreachable, every function here degrades to a no-op (and the audit
 *     record goes to stdout, which Vercel retains). A database outage must not
 *     be able to block a clinical result.
 *
 * Handlers stay pure functions of (state, input) → state'; load/save is only
 * ever this thin wrapper around them, so they remain testable with no database.
 */

let client: SupabaseClient | null = null;

export function isStoreConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

let warnedUnconfigured = false;

function getClient(): SupabaseClient | null {
  if (!isStoreConfigured()) {
    // Silent degradation is right for the request, but silence in the logs is
    // not: a missing env var and a failing write look identical from outside.
    // Warn once per container so the reason is discoverable without noise.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      const missing = [
        process.env.SUPABASE_URL ? null : 'SUPABASE_URL',
        process.env.SUPABASE_SERVICE_ROLE_KEY ? null : 'SUPABASE_SERVICE_ROLE_KEY',
      ].filter(Boolean);
      console.warn(
        `Supabase not configured (missing: ${missing.join(', ')}) — assessments will not be persisted ` +
          'and audit records will go to stdout. See supabase/README.md.',
      );
    }
    return null;
  }
  if (!client) {
    client = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false } },
    );
  }
  return client;
}

export async function loadAssessment(id: string): Promise<AssessmentState | null> {
  const db = getClient();
  if (!db) return null;
  try {
    const { data, error } = await db.from('assessments').select('state').eq('id', id).maybeSingle();
    if (error) throw error;
    return (data?.state as AssessmentState) ?? null;
  } catch (error) {
    console.warn('Supabase load failed; continuing with client-supplied state.', error);
    return null;
  }
}

export async function saveAssessment(state: AssessmentState): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    const { error } = await db.from('assessments').upsert({
      id: state.id,
      wound_id: state.woundId ?? null,
      created_at: state.createdAt,
      updated_at: new Date().toISOString(),
      status: state.result?.status ?? 'in_progress',
      cwcs_pathway_id: state.result?.cwcsPathwayId ?? null,
      tissue_type: state.result?.axes.tissue ?? null,
      exudate_level: state.result?.axes.exudate ?? null,
      infection: state.result?.axes.infection ?? null,
      confidence: state.result?.confidence ?? null,
      rules_version: state.result?.rulesVersion ?? null,
      state,
    });
    if (error) throw error;
  } catch (error) {
    console.warn('Supabase save failed; the result is still returned to the client.', error);
  }
}

/**
 * Append a visit to the longitudinal series. Only called once an assessment
 * completes, and only when the client supplied a `woundId` to group by.
 */
export async function appendTimeline(state: AssessmentState): Promise<void> {
  const db = getClient();
  if (!db || !state.woundId || !state.result) return;
  try {
    const { error } = await db.from('wound_timeline').insert({
      wound_id: state.woundId,
      assessment_id: state.id,
      recorded_at: new Date().toISOString(),
      area_cm2: state.cv?.areaCm2 ?? null,
      tissue_pct: state.tissue ?? null,
      cwcs_pathway_id: state.result.cwcsPathwayId,
    });
    if (error) throw error;
  } catch (error) {
    console.warn('Supabase timeline append failed.', error);
  }
}

// ===========================================================================
// Audit log — the regulatory asset
// ===========================================================================

export type AuditRecord = {
  assessmentId: string;
  at: string;
  /** Stable hash of the engine inputs, so a result can be tied to exactly what produced it. */
  inputsHash: string;
  axes: EngineResult['axes'];
  cwcsPathwayId: number | null;
  pathwayWithheld: boolean;
  gateCodes: string[];
  referralCodes: string[];
  confidence: string;
  rulesVersion: string;
  /**
   * The exact models behind the result. `models` is a jsonb column, so adding a
   * key here needs no migration. `segmentation` is the model label and
   * `segmentationProvider` the backend that answered — both, because the chain
   * means "which model drew this boundary" is no longer a constant, and a
   * boundary from the third fallback is a different result from the same inputs.
   */
  models: {
    vlm?: string;
    llm?: string;
    segmentation?: string;
    segmentationProvider?: string;
    /**
     * Whether a clinician approved, adjusted or drew the boundary. Absent means
     * the boundary was never reviewed — which, for an assurance reviewer, is the
     * single most useful thing this column can tell them.
     */
    segmentationApproval?: string;
    /** The approval this assessment was measured under (spec §6A.1). */
    approvalId?: string;
    /** SHA-256 of the image — ties the record to a photo without storing it. */
    imageSha256?: string;
  };
  steps: StepOutcome[];
};

/**
 * SHA-256 of the engine inputs, canonicalised with keys sorted at EVERY level
 * (docs/SECURITY_AUDIT.md MW-05). The old hash passed `Object.keys(inputs)` as a
 * `JSON.stringify` replacer, which also filtered NESTED keys — so most of the
 * tissue, VLM and Mölnlycke detail never reached it, and two different
 * assessments could share a hash. Old 8-character FNV values in `audit_log`
 * are not comparable with these 64-character ones; rows are not rewritten.
 */
export function hashInputs(inputs: EngineInputs): string {
  return canonicalHash(inputs);
}

export function buildAuditRecord(
  state: AssessmentState,
  inputs: EngineInputs,
  result: EngineResult,
): AuditRecord {
  return {
    assessmentId: state.id,
    at: new Date().toISOString(),
    inputsHash: hashInputs(inputs),
    axes: result.axes,
    cwcsPathwayId: result.cwcsPathwayId,
    pathwayWithheld: result.pathwayWithheld,
    gateCodes: result.gateCodes,
    referralCodes: result.referrals.map((r) => r.code),
    confidence: result.confidence,
    rulesVersion: result.rulesVersion,
    models: {
      vlm: state.vlmModel ?? undefined,
      segmentation: state.segment?.model,
      segmentationProvider: state.segment?.source === 'unavailable' ? undefined : state.segment?.source,
      segmentationApproval: state.segment?.approval,
      approvalId: state.segment?.approvalId,
      imageSha256: state.imageSha256 ?? undefined,
      llm: state.report?.model,
    },
    steps: state.steps ?? [],
  };
}

/**
 * Write the audit record. When the database is absent it goes to stdout, which
 * Vercel retains — so the trail exists from day one, before the schema does.
 * `audit_log` is append-only by grant; there is deliberately no update path.
 */
export async function writeAudit(record: AuditRecord): Promise<void> {
  const db = getClient();
  if (!db) {
    console.log('[audit]', JSON.stringify(record));
    return;
  }
  try {
    const { error } = await db.from('audit_log').insert({
      assessment_id: record.assessmentId,
      at: record.at,
      inputs_hash: record.inputsHash,
      axes: record.axes,
      cwcs_pathway_id: record.cwcsPathwayId,
      pathway_withheld: record.pathwayWithheld,
      gate_codes: record.gateCodes,
      referral_codes: record.referralCodes,
      confidence: record.confidence,
      rules_version: record.rulesVersion,
      models: record.models,
      steps: record.steps,
    });
    if (error) throw error;
  } catch (error) {
    console.warn('Supabase audit write failed — falling back to log output.', error);
    console.log('[audit]', JSON.stringify(record));
  }
}

// ===========================================================================
// Segmentation correction log (segmentation spec §4.1) — the dataset of how
// far clinicians move the model's boundary. Same rules as everything above:
// never on the critical path, stdout when the database is absent.
// ===========================================================================

export type CorrectionRow = {
  assessment_id: string;
  model: string | null;
  confidence: string | null;
  score: number | null;
  approval: 'approved' | 'adjusted' | 'drawn';
  iou: number | null;
  ai_area_px: number | null;
  final_area_px: number | null;
  area_delta_pct: number | null;
  boundary_changed: boolean | null;
  n_edits: number;
  n_taps: number;
  box_used: boolean;
  ms_to_approve: number | null;
  wound_location: string | null;
  monk_tone: number | null;
  image_source: 'public_dataset' | 'synthetic' | 'consented_demo';
  ai_mask_png: string | null;
  final_mask_png: string | null;
  approval_id: string | null;
  clinician_id: string | null;
  second_opinion_status: 'ok' | 'unavailable' | null;
  agreement_iou: number | null;
  fusegnet_regions: Record<string, number | boolean> | null;
  fusegnet_mean_prob: number | null;
  fusegnet_latency_ms: number | null;
};

/** Insert one correction row; returns its id, or null when it went to stdout. */
export async function writeCorrection(row: CorrectionRow): Promise<string | null> {
  const db = getClient();
  // The log line never carries the mask images, whatever the image source.
  const loggable = { ...row, ai_mask_png: row.ai_mask_png ? '[stored]' : null, final_mask_png: row.final_mask_png ? '[stored]' : null };
  if (!db) {
    console.log('[correction]', JSON.stringify(loggable));
    return null;
  }
  try {
    const { data, error } = await db.from('segmentation_corrections').insert(row).select('id').single();
    if (error) throw error;
    return (data?.id as string) ?? null;
  } catch (error) {
    console.warn('Supabase correction write failed — falling back to log output.', error);
    console.log('[correction]', JSON.stringify(loggable));
    return null;
  }
}

/** Record the tissue confirmation (§4.3) against an existing correction row. */
export async function updateCorrectionTissue(
  id: string,
  fields: {
    tissue_auto: string | null;
    tissue_final: string;
    tissue_override: boolean;
    wound_location: string | null;
    monk_tone: number | null;
  },
): Promise<boolean> {
  const db = getClient();
  if (!db) {
    console.log('[correction:tissue]', JSON.stringify({ id, ...fields }));
    return false;
  }
  try {
    const { error } = await db.from('segmentation_corrections').update(fields).eq('id', id);
    if (error) throw error;
    return true;
  } catch (error) {
    console.warn('Supabase correction update failed — falling back to log output.', error);
    console.log('[correction:tissue]', JSON.stringify({ id, ...fields }));
    return false;
  }
}
