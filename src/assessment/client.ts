import { ASSESSMENT_V2 } from '@/config/featureFlags';
import type { EngineInputs, EngineResult, VlmFeatures } from '@/decision/engine.types';
import type { AssessmentState, ReportPair, StepOutcome, TissueSummary } from '@/assessment/state';

/**
 * Client helpers for the V2 pipeline.
 *
 * Every function here returns `null` when `assessmentV2` is off, and `null`
 * again on any network failure — so the existing demo flow is never affected
 * and never breaks because a server-side step was unavailable. Callers treat
 * `null` as "this step didn't run", not as an error to surface.
 */

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? '';

function url(path: string): string {
  return `${API_BASE}${path}`;
}

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  if (!ASSESSMENT_V2) return null;
  try {
    const response = await fetch(url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    console.warn(`V2 request to ${path} failed; continuing without it.`, error);
    return null;
  }
}

export async function createAssessment(woundId?: string | null): Promise<string | null> {
  const result = await postJson<{ assessment_id: string }>('/api/v1/assessments/create', {
    wound_id: woundId ?? null,
  });
  return result?.assessment_id ?? null;
}

export async function analyzeTissueRemote(body: {
  base64: string;
  mask?: string | null;
  pxPerCm?: number | null;
}): Promise<TissueSummary | null> {
  const result = await postJson<{ tissue: TissueSummary | null }>('/api/v1/assessments/tissue', body);
  return result?.tissue ?? null;
}

export async function vlmFeatures(body: {
  base64: string;
  tissueSummary?: TissueSummary | null;
}): Promise<{ features: VlmFeatures | null; reason?: string } | null> {
  const result = await postJson<{ source: string; features?: VlmFeatures; reason?: string }>(
    '/api/v1/assessments/vlm-features',
    body,
  );
  if (!result) return null;
  return { features: result.features ?? null, reason: result.reason };
}

export async function evaluateRemote(
  inputs: EngineInputs,
  assessmentId?: string | null,
): Promise<EngineResult | null> {
  const result = await postJson<{ result: EngineResult }>('/api/v1/assessments/evaluate', {
    inputs,
    assessment_id: assessmentId ?? null,
  });
  return result?.result ?? null;
}

export async function composeReportRemote(body: {
  result: EngineResult;
  areaCm2?: number | null;
  bodyZoneLabel?: string | null;
}): Promise<ReportPair | null> {
  return postJson<ReportPair>('/api/v1/assessments/report', body);
}

/**
 * Stream the whole pipeline, calling `onStep` as each stage lands.
 *
 * Parses SSE by hand rather than using EventSource, because EventSource cannot
 * POST and React Native's fetch has no streaming body on every platform — so we
 * read what we can and fall back to parsing the completed response. The step
 * callbacks are progress reporting; the returned state is what matters.
 */
export async function runAssessmentStream(
  body: {
    base64: string;
    inputs: EngineInputs;
    state?: Partial<AssessmentState>;
    pxPerCm?: number | null;
    areaCm2?: number | null;
    bodyZoneLabel?: string | null;
  },
  onStep?: (step: StepOutcome) => void,
): Promise<AssessmentState | null> {
  if (!ASSESSMENT_V2) return null;

  try {
    const response = await fetch(url('/api/v1/assessments/run'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;

    let buffer = '';
    let final: AssessmentState | null = null;

    const handleFrame = (frame: string) => {
      const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!eventLine || !dataLine) return;
      const event = eventLine.slice(6).trim();
      const payload = JSON.parse(dataLine.slice(5).trim());
      if (event === 'step') onStep?.(payload as StepOutcome);
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

    const body_ = response.body as ReadableStream<Uint8Array> | null;
    if (body_?.getReader) {
      const reader = body_.getReader();
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
    console.warn('Assessment run failed; falling back to the on-device flow.', error);
    return null;
  }
}
