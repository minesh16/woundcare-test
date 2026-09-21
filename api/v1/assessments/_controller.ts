import { evaluate } from '../../../src/decision/engine';
import type { EngineInputs } from '../../../src/decision/engine.types';
import type { AssessmentState, StepOutcome, StepName } from '../../../src/assessment/state';
import { isSam2Configured, runSam2Segmentation } from '../../_sam2';
import { selectWoundMask } from '../../_maskSelect';
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
 *   SAM 2 down   → HSV mask, confidence downgraded
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
};

export type StepEmitter = (outcome: StepOutcome) => void;

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

export async function runAssessment(input: RunInput, emit: StepEmitter): Promise<AssessmentState> {
  const state: AssessmentState = { ...input.state, steps: [] };
  const record: StepEmitter = (outcome) => {
    state.steps = [...(state.steps ?? []), outcome];
    emit(outcome);
  };

  // --- 1. Segment -----------------------------------------------------------
  const segment = await timed('segment', record, async () => {
    if (!isSam2Configured()) {
      return {
        value: null,
        status: 'degraded' as const,
        summary: 'SAM 2 not configured — using the on-device boundary instead.',
      };
    }
    try {
      const result = await runSam2Segmentation({
        imageDataUrl: input.base64.startsWith('data:') ? input.base64 : `data:image/jpeg;base64,${input.base64}`,
      });
      const point = input.state.cv?.hsvCentroid ?? null;
      const selection = point && result.individualMasks.length ? await selectWoundMask(result.individualMasks, point) : null;
      return {
        value: { maskUrl: selection?.maskUrl ?? result.combinedMask, model: result.model, selected: Boolean(selection) },
        status: 'ok' as const,
        summary: selection ? 'Wound boundary found.' : 'Boundary found, but the wound could not be isolated.',
      };
    } catch (error) {
      return {
        value: null,
        status: 'degraded' as const,
        summary: `Boundary detection unavailable (${error instanceof Error ? error.message : 'failed'}) — using the on-device boundary.`,
      };
    }
  });

  state.segment = segment
    ? { source: 'sam2', maskUrl: segment.maskUrl, confidence: segment.selected ? 'high' : 'medium', model: segment.model }
    : { source: 'unavailable', maskUrl: null, confidence: 'low' };

  // --- 2. Tissue ------------------------------------------------------------
  const tissue = await timed('tissue', record, async () => {
    const result = await analyzeTissue({
      base64: input.base64,
      mask: segment?.maskUrl ?? null,
      pxPerCm: input.pxPerCm ?? null,
    });
    return {
      value: result,
      status: (result.tissue ? (result.maskSource === 'sam2' ? 'ok' : 'degraded') : 'failed') as StepOutcome['status'],
      summary: result.tissue
        ? `Tissue measured inside the ${result.maskSource === 'sam2' ? 'detected' : 'on-device'} boundary.`
        : (result.reason ?? 'No wound area found.'),
    };
  });
  state.tissue = tissue.tissue;

  // --- 3. Caged VLM ---------------------------------------------------------
  const vlm = await timed('vlm', record, async () => {
    const result = await extractVlmFeatures({
      base64: input.base64,
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
