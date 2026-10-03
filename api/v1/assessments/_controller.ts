import { evaluate } from '../../../src/decision/engine';
import type { EngineInputs, EngineResult } from '../../../src/decision/engine.types';
import type {
  AssessmentState,
  BoundaryApprovalName,
  SegmentationProviderName,
  StepOutcome,
  StepName,
} from '../../../src/assessment/state';
import type { ApprovalRecord } from '../../_apiStore';
import { cropsFromMask } from '../../_crops';
import { loadMaskPixels } from '../../_maskIO';
import { analyzeTissue } from './tissue';
import { extractVlmFeatures } from './vlm-features';
import { composeReport } from './report';
import { appendTimeline, buildAuditRecord, saveAssessment, writeAudit } from './_store';

/**
 * The orchestrator: a deterministic state machine, not an agent.
 *
 * It runs a fixed sequence — segment → tissue → vlm → evaluate → report — with
 * a fixed escalation policy. It chooses nothing clinical; it sequences tools,
 * records what each one did, and hands the engine its inputs.
 *
 * Every step except `evaluate` is allowed to degrade:
 *   boundary down→ next provider, then the HSV mask, confidence downgraded
 *   VLM down     → engine runs without the VLM axis
 *   report down  → deterministic template
 *   Supabase down→ result still returned, audit to stdout
 * Only the engine is non-optional, because only the engine decides anything.
 */

export type RunInput = {
  state: AssessmentState;
  base64: string;
  engineInputs: EngineInputs;
  pxPerCm?: number | null;
  areaCm2?: number | null;
  bodyZoneLabel?: string | null;
  /**
   * The approved mask, and the approval it was signed off under (POST /approve).
   * There is no path through `run` without one (segmentation spec §6A.1: "must
   * pause for /approve — no auto-approval"): the chain is never re-run here,
   * because re-segmenting would measure inside a different boundary from the
   * one a human signed off, and the audit record would name an approval that
   * did not apply to the mask used.
   */
  mask: string;
  approval: ApprovalRecord;
};

export type StepEmitter = (outcome: StepOutcome) => void;

/**
 * Called once, the moment the engine has decided — before the report is
 * written. The report LLM can take minutes; the decision cannot wait for it, or
 * the screen shows nothing (or a different, on-device result) in the meantime.
 */
export type DecisionEmitter = (decision: {
  result: EngineResult;
  engineInputs: EngineInputs;
  tissue: AssessmentState['tissue'];
  vlm: AssessmentState['vlm'];
}) => void;

async function timed<T>(
  step: StepName,
  emit: StepEmitter,
  run: () => Promise<{ value: T; status: StepOutcome['status']; summary: string }>,
): Promise<T> {
  const started = Date.now();
  try {
    const { value, status, summary } = await run();
    emit({ step, status, ms: Date.now() - started, summary });
    return value;
  } catch (error) {
    const summary = error instanceof Error ? error.message : 'Step failed.';
    emit({ step, status: 'failed', ms: Date.now() - started, summary });
    throw error;
  }
}

export async function runAssessment(
  input: RunInput,
  emit: StepEmitter,
  onDecision?: DecisionEmitter,
): Promise<AssessmentState> {
  const state: AssessmentState = { ...input.state, steps: [] };
  const record: StepEmitter = (outcome) => {
    state.steps = [...(state.steps ?? []), outcome];
    emit(outcome);
  };

  // --- 1. Segment: the approved boundary, never a re-run ------------------
  const approved = input.approval;
  await timed('segment', record, async () => ({
    value: null,
    status: 'ok' as const,
    summary:
      approved.approval === 'drawn'
        ? 'Using the boundary the clinician drew.'
        : approved.approval === 'adjusted'
          ? 'Using the clinician-adjusted boundary.'
          : 'Using the boundary the clinician approved.',
  }));
  state.segment = {
    // A hand-drawn boundary has no model behind it, so it is attributed to the
    // clinician rather than to a provider that did not produce it.
    source:
      approved.provider === 'sam3' || approved.provider === 'fusegnet'
        ? (approved.provider as SegmentationProviderName)
        : 'clinician',
    maskUrl: null, // the mask itself is not stored in the record
    // A reviewed boundary is the highest confidence this pipeline can report.
    confidence: 'high',
    model: approved.model ?? undefined,
    approval: approved.approval as BoundaryApprovalName,
    approvalId: approved.id,
  };

  // --- 2. Tissue ------------------------------------------------------------
  const tissue = await timed('tissue', record, async () => {
    const result = await analyzeTissue({
      base64: input.base64,
      mask: input.mask,
      maskProvider: approved.provider === 'sam3' || approved.provider === 'fusegnet' ? approved.provider : null,
      pxPerCm: input.pxPerCm ?? null,
    });
    return {
      value: result,
      status: (result.tissue ? (result.maskSource === 'model' ? 'ok' : 'degraded') : 'failed') as StepOutcome['status'],
      summary: result.tissue
        ? `Tissue measured inside the ${result.maskSource === 'model' ? 'detected' : 'on-device'} boundary.`
        : (result.reason ?? 'No wound area found.'),
    };
  });
  state.tissue = tissue.tissue;

  // --- 3. Caged VLM ---------------------------------------------------------
  const vlm = await timed('vlm', record, async () => {
    // Crops of the wound bed and the skin around it, from the APPROVED mask.
    const maskPixels = await loadMaskPixels(input.mask);
    const crops = maskPixels ? cropsFromMask(input.base64, maskPixels) : null;
    const result = await extractVlmFeatures({
      base64: input.base64,
      woundCrop: crops?.wound ?? null,
      periwoundCrop: crops?.periwound ?? null,
      tissueSummary: tissue.tissue ?? undefined,
    });
    return {
      value: result,
      status: (result.source === 'gateway' ? 'ok' : 'degraded') as StepOutcome['status'],
      summary:
        result.source === 'gateway'
          ? `Image review complete (${result.model}).`
          : `Image review unavailable — continuing without it.`,
    };
  });
  state.vlm = vlm.features ?? null;
  state.vlmModel = vlm.model ?? null;
  state.vlmUnavailableReason = vlm.source === 'unavailable' ? (vlm.reason ?? null) : null;

  // --- 4. Evaluate — the only non-optional step -----------------------------
  const inputs: EngineInputs = {
    ...input.engineInputs,
    tissue: tissue.tissue
      ? {
          necrosis: tissue.tissue.necrotic,
          slough: tissue.tissue.slough,
          granulation: tissue.tissue.granulation,
          epithelial: tissue.tissue.epithelial,
          other: tissue.tissue.other,
        }
      : input.engineInputs.tissue,
    vlm: vlm.features,
    periwound: tissue.periwound
      ? { rednessPct: tissue.periwound.rednessPct, maceration: tissue.periwound.maceration }
      : undefined,
  };
  state.engineInputs = inputs;

  const result = await timed('evaluate', record, async () => {
    const evaluated = evaluate(inputs);
    return {
      value: evaluated,
      status: (evaluated.status === 'complete' ? 'ok' : 'degraded') as StepOutcome['status'],
      summary:
        evaluated.status === 'complete'
          ? `Decision made — pathway ${evaluated.cwcsPathwayId}.`
          : 'Assessment incomplete — no dressing suggestion given.',
    };
  });
  state.result = result;
  onDecision?.({ result, engineInputs: inputs, tissue: state.tissue ?? null, vlm: state.vlm ?? null });

  // --- 5. Report ------------------------------------------------------------
  const report = await timed('report', record, async () => {
    const composed = await composeReport({
      result,
      areaCm2: input.areaCm2 ?? null,
      bodyZoneLabel: input.bodyZoneLabel ?? null,
      tissuePct: tissue.tissue
        ? {
            granulation: tissue.tissue.granulation,
            slough: tissue.tissue.slough,
            necrosis: tissue.tissue.necrotic,
            epithelial: tissue.tissue.epithelial,
          }
        : null,
    });
    return {
      value: composed,
      status: (composed.source === 'llm' ? 'ok' : 'degraded') as StepOutcome['status'],
      summary: composed.source === 'llm' ? 'Report written.' : 'Report written from the standard template.',
    };
  });
  state.report = report;

  await saveAssessment(state);
  await writeAudit(buildAuditRecord(state, inputs, result));
  if (result.status === 'complete') {
    await appendTimeline(state);
  }

  return state;
}
