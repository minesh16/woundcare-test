import { ASSESSMENT_V2 } from '@/config/featureFlags';
import type { ClinicianTissueChoice, EngineInputs, EngineResult } from '@/decision/engine.types';
import type { AssessmentState, MeasurementResult, StepOutcome, TissueSummary } from '@/assessment/state';
import type { ImageSource } from '@/decision/types';

/**
 * The app's side of the module API (segmentation build spec §6A).
 *
 * The app calls exactly the endpoints an integrator calls — same key header,
 * same contracts, same approval requirement — so there is one API and no
 * private side door (§6A.3). Its key (`EXPO_PUBLIC_MENDWISE_API_KEY`) is a
 * SANDBOX key and public by definition: Expo inlines it into the bundle. It is a
 * demo gate that makes abuse rate-limited and visible, not an identity
 * (docs/SECURITY_AUDIT.md MW-01).
 *
 * Every helper returns `{ ok: false, error }` rather than throwing, with the
 * server's own message when there is one, so a screen can say why.
 */

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? '';
const API_KEY = process.env.EXPO_PUBLIC_MENDWISE_API_KEY ?? '';

/**
 * Absolute URL for an endpoint. A bare relative `fetch('/api/…')` works on web
 * and silently fails on native, where there is no page origin.
 */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function apiHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': API_KEY };
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; status?: number };

/** POST JSON; the server's `{ error: { code, message } }` becomes `{ ok: false }`. */
export async function callApi<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  if (!ASSESSMENT_V2) return { ok: false, error: 'The assessment pipeline is switched off in this build.' };
  try {
    const response = await fetch(apiUrl(path), { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: { code?: string; message?: string } })
      | null;
    if (!response.ok || !payload) {
      return {
        ok: false,
        error: payload?.error?.message ?? `The server could not complete this (HTTP ${response.status}).`,
        code: payload?.error?.code,
        status: response.status,
      };
    }
    return { ok: true, data: payload };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `Could not reach the server: ${error.message}` : 'Could not reach the server.',
    };
  }
}

// ---------------------------------------------------------------------------
// Segment (draft outline) — spec §3.2
// ---------------------------------------------------------------------------

export type PromptPoint = { xPct: number; yPct: number; label: 0 | 1 };
export type PromptBox = { x0Pct: number; y0Pct: number; x1Pct: number; y1Pct: number };
export type SegmentPrompts = { text?: string; points?: PromptPoint[]; box?: PromptBox | null };

export type SegmentResponse = {
  source: 'sam3' | 'fusegnet' | 'hsv' | null;
  provider: 'sam3' | 'fusegnet' | null;
  mask: string | null;
  score: number | null;
  box: [number, number, number, number] | null;
  confidence: 'high' | 'medium' | 'low';
  model: string | null;
  outline: { x: number; y: number }[] | null;
  multipleRegions: boolean | null;
  frame: { width: number; height: number };
  areaPx: number | null;
  totalPx: number | null;
  candidates: number;
  promptConflict: boolean;
  secondOpinion:
    | {
        status: 'ok';
        model: string;
        mask: string;
        outline: { x: number; y: number }[] | null;
        agreementIoU: number | null;
        regions: Record<string, number | boolean> | null;
        regionsKept: number | null;
        multipleRegions: boolean | null;
        meanProb: number | null;
        latencyMs: number | null;
      }
    | { status: 'unavailable'; reason: string }
    | null;
  secondOpinionReason: string | null;
  latencyMs: number;
  attempts: { provider: string; status: string; ms: number; reason?: string }[];
  reason?: string;
  degraded?: boolean;
};

export function segmentRemote(body: {
  base64: string;
  prompts?: SegmentPrompts;
  bodyZone?: string | null;
  assessmentId?: string;
}): Promise<ApiResult<SegmentResponse>> {
  return callApi<SegmentResponse>('/api/v1/assessments/segment', {
    base64: body.base64,
    prompts: body.prompts,
    body_zone: body.bodyZone ?? null,
    assessment_id: body.assessmentId,
  });
}

/**
 * Rasterise a clinician's polygon into a mask, server-side — Expo-native has no
 * canvas, so this is the only way both platforms build the same mask.
 */
export function rasteriseBoundaryRemote(body: {
  polygon: { x: number; y: number }[];
  approval?: 'adjusted' | 'drawn';
  assessmentId?: string;
  width?: number;
  height?: number;
}): Promise<
  ApiResult<{ mask: string; areaPx: number; framePx: number; areaPct: number; plausibility: string; plausibilityReason: string }>
> {
  return callApi('/api/v1/assessments/mask', {
    polygon: body.polygon,
    approval: body.approval,
    assessment_id: body.assessmentId,
    width: body.width,
    height: body.height,
  });
}

// ---------------------------------------------------------------------------
// Approve — spec §6A.1, §4.1
// ---------------------------------------------------------------------------

export type ApproveResponse = {
  approval_id: string;
  expires_at: string;
  correction_id: string | null;
  iou: number | null;
  boundary_changed: boolean | null;
  plausibility: string;
  plausibility_reason: string;
};

export function approveRemote(body: {
  base64: string;
  assessmentId: string;
  approval: 'approved' | 'adjusted' | 'drawn';
  finalMask: string;
  aiMask: string | null;
  clinicianId: string;
  provider: 'sam3' | 'fusegnet' | 'hsv' | null;
  model: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  score: number | null;
  edits: number;
  taps: number;
  boxUsed: boolean;
  msToApprove: number;
  imageSource: ImageSource;
  bodyZone: string | null;
  secondOpinion?: {
    status: 'ok' | 'unavailable';
    agreement_iou?: number | null;
    regions?: Record<string, number | boolean> | null;
    mean_prob?: number | null;
    latency_ms?: number | null;
  } | null;
}): Promise<ApiResult<ApproveResponse>> {
  return callApi<ApproveResponse>('/api/v1/assessments/approve', {
    base64: body.base64,
    assessment_id: body.assessmentId,
    approval: body.approval,
    final_mask: body.finalMask,
    ai_mask: body.aiMask,
    clinician_id: body.clinicianId,
    provider: body.provider,
    model: body.model,
    confidence: body.confidence,
    score: body.score,
    edits: body.edits,
    taps: body.taps,
    box_used: body.boxUsed,
    ms_to_approve: Math.round(body.msToApprove),
    image_source: body.imageSource,
    body_zone: body.bodyZone,
    second_opinion: body.secondOpinion ?? null,
  });
}

/** Measure the APPROVED outline: tissue %, coin scale, size, white balance. */
export async function measureRemote(body: {
  base64: string;
  mask: string;
  approvalId: string;
  includeCoinReference: boolean;
}): Promise<ApiResult<{ tissue: TissueSummary; measurement: MeasurementResult }>> {
  const result = await callApi<{ tissue: TissueSummary | null; measurement: MeasurementResult | null }>(
    '/api/v1/assessments/measure',
    {
      base64: body.base64,
      mask: body.mask,
      approval_id: body.approvalId,
      include_coin_reference: body.includeCoinReference,
    },
  );
  if (!result.ok) return result;
  if (!result.data.tissue || !result.data.measurement) return { ok: false, error: 'The outline could not be measured.' };
  return { ok: true, data: { tissue: result.data.tissue, measurement: result.data.measurement } };
}

/** Record the tissue confirmation against the approval's correction row (§4.3). */
export function logTissueConfirmationRemote(body: {
  correctionId: string;
  tissueAuto: ClinicianTissueChoice | null;
  tissueFinal: ClinicianTissueChoice;
  woundLocation: string | null;
  monkTone: number | null;
}): Promise<ApiResult<{ stored: boolean }>> {
  return callApi('/api/v1/assessments/correction', {
    correction_id: body.correctionId,
    tissue_auto: body.tissueAuto,
    tissue_final: body.tissueFinal,
    wound_location: body.woundLocation,
    monk_tone: body.monkTone,
  });
}

/** The deliberately ungrounded comparison arm. Never feeds the assessment. */
export async function baselineRemote(base64: string): Promise<{
  source: string;
  text?: string;
  reason?: string;
  model?: string;
  latencyMs?: number;
} | null> {
  const result = await callApi<{ source: string; text?: string; reason?: string; model?: string; latencyMs?: number }>(
    '/api/v1/assessments/baseline',
    { base64 },
  );
  return result.ok ? result.data : null;
}

// ---------------------------------------------------------------------------
// Run — streamed
// ---------------------------------------------------------------------------

/**
 * Stream the pipeline over an APPROVED outline, calling `onStep` as each stage
 * lands and `onDecision` the moment the engine has decided (before the report).
 *
 * Parses SSE by hand rather than using EventSource, because EventSource cannot
 * POST and React Native's fetch has no streaming body on every platform — so we
 * read what we can and fall back to parsing the completed response.
 */
export async function runAssessmentStream(
  body: {
    base64: string;
    mask: string;
    approvalId: string;
    inputs: EngineInputs;
    pxPerCm?: number | null;
    areaCm2?: number | null;
    bodyZoneLabel?: string | null;
  },
  onStep?: (step: StepOutcome) => void,
  onDecision?: (decision: { result: EngineResult; tissue?: TissueSummary | null }) => void,
): Promise<AssessmentState | null> {
  if (!ASSESSMENT_V2) return null;

  try {
    const response = await fetch(apiUrl('/api/v1/assessments/run'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        base64: body.base64,
        mask: body.mask,
        approval_id: body.approvalId,
        inputs: body.inputs,
        px_per_cm: body.pxPerCm ?? null,
        area_cm2: body.areaCm2 ?? null,
        body_zone_label: body.bodyZoneLabel ?? null,
      }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      console.warn('Assessment run refused:', detail?.error?.message ?? response.status);
      return null;
    }

    let buffer = '';
    let final: AssessmentState | null = null;

    const handleFrame = (frame: string) => {
      const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!eventLine || !dataLine) return;
      const event = eventLine.slice(6).trim();
      const payload = JSON.parse(dataLine.slice(5).trim());
      if (event === 'step') onStep?.(payload as StepOutcome);
      else if (event === 'decision') onDecision?.(payload);
      else if (event === 'result') final = payload as AssessmentState;
    };

    const drain = () => {
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        handleFrame(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    };

    const stream = response.body as ReadableStream<Uint8Array> | null;
    if (stream?.getReader) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        drain();
      }
    } else {
      buffer = await response.text();
      drain();
    }

    return final;
  } catch (error) {
    console.warn('Assessment run failed; falling back to the on-device engine.', error);
    return null;
  }
}
