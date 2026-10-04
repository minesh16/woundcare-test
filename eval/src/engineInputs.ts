/**
 * The engine-input mapping (spec §11.3) — the ONLY re-implemented logic in the
 * harness, guarded by `parity` (§12).
 *
 * Two sources, mirrored:
 *
 *  1. The BASE inputs the client sends to `/run`. These are not re-implemented:
 *     the harness builds the same `ScanSession` the client holds after
 *     `/measure` (default answers, no tissue confirmation — there is no
 *     clinician) and calls the client's own `toEngineInputs`, which reads the
 *     measurement through `measuredView`.
 *
 *  2. The overrides `runAssessment` applies in its step 4
 *     (api/v1/assessments/_controller.ts): tissue from the `/run` tissue step,
 *     the VLM features, and the periwound band. This IS a copy — three lines —
 *     and `parity` fails the moment the controller changes.
 *
 * Input policies (§11.4) are applied last, on top of what the app would send.
 */
import type { TissueResponse } from '../../api/v1/assessments/tissue';
import { toEngineInputs } from '../../src/decision/rules';
import { defaultSession, type ScanSession, type WoundMeasurement } from '../../src/decision/types';
import type { EngineInputs, VlmFeatures } from '../../src/decision/engine.types';
import type { BodyZone } from '../../src/decision/types';
import type { GroundTruth } from './schema';

export const POLICIES = ['image_only', 'image+vlm', 'label-axes'] as const;
export type Policy = (typeof POLICIES)[number];

/** The `/measure` response → the `WoundMeasurement` the client stores on the session. */
export function measurementFromMeasure(measure: TissueResponse): WoundMeasurement | null {
  const m = measure.measurement;
  const t = measure.tissue;
  if (!m || !t) return null;
  return {
    granulationPercent: t.granulation,
    sloughPercent: t.slough,
    necrosisPercent: t.necrotic,
    epithelialPercent: t.epithelial,
    otherPercent: t.other,
    maskAreaPx: measure.maskAreaPx,
    maskProvider: measure.maskProvider ?? null,
    periwound: measure.periwound ?? null,
    frame: m.frame,
    scale: m.scale,
    scaleReason: m.scaleReason ?? null,
    scaleRejected: false, // nobody is there to reject the coin
    geometry: m.geometry,
    whiteBalance: m.whiteBalance,
    measuredAt: new Date(0).toISOString(),
  };
}

/** The session the client would hold at the moment it calls `/run`. */
export function sessionFor(args: { measure: TissueResponse | null; bodyZone?: string | null }): ScanSession {
  const session = defaultSession();
  session.measurement = args.measure ? measurementFromMeasure(args.measure) : null;
  session.bodyZone = (args.bodyZone ?? null) as BodyZone | null;
  return session;
}

/** What the client sends as `engineInputs` (and `px_per_cm`) to `/run`. */
export function baseInputs(args: { measure: TissueResponse | null; bodyZone?: string | null }): {
  inputs: EngineInputs;
  pxPerCm: number | null;
} {
  const session = sessionFor(args);
  const inputs = toEngineInputs(session);
  return { inputs, pxPerCm: session.measurement?.scale?.pxPerCm ?? null };
}

/** `runAssessment` step 4 — the controller's overrides, copied. Guarded by parity. */
export function applyControllerOverrides(
  base: EngineInputs,
  runTissue: TissueResponse | null,
  vlmFeatures: VlmFeatures | undefined,
): EngineInputs {
  const tissue = runTissue?.tissue ?? null;
  return {
    ...base,
    tissue: tissue
      ? {
          necrosis: tissue.necrotic,
          slough: tissue.slough,
          granulation: tissue.granulation,
          epithelial: tissue.epithelial,
          other: tissue.other,
        }
      : base.tissue,
    vlm: vlmFeatures,
    periwound: runTissue?.periwound
      ? { rednessPct: runTissue.periwound.rednessPct, maceration: runTissue.periwound.maceration }
      : undefined,
  };
}

/** Apply an input policy (spec §11.4). `label-axes` returns null when the item has no labelled axis. */
export function applyPolicy(inputs: EngineInputs, policy: Policy, gt: GroundTruth): EngineInputs | null {
  if (policy !== 'label-axes') return inputs;
  if (!gt.exudate && !gt.infection && !gt.ischaemia) return null;
  return {
    ...inputs,
    exudate: gt.exudate ?? inputs.exudate,
    infection: gt.infection ?? inputs.infection,
    perfusion: gt.ischaemia === 'yes' ? 'ischaemic' : gt.ischaemia === 'no' ? 'non_ischaemic' : inputs.perfusion,
  };
}

/** Everything the engine sees for one item, built the app's way. */
export function buildEngineInputs(args: {
  measure: TissueResponse | null;
  runTissue: TissueResponse | null;
  vlm?: VlmFeatures;
  bodyZone?: string | null;
  policy: Policy;
  gt: GroundTruth;
}): { base: EngineInputs; pxPerCm: number | null; inputs: EngineInputs | null } {
  const { inputs: base, pxPerCm } = baseInputs({ measure: args.measure, bodyZone: args.bodyZone });
  const merged = applyControllerOverrides(base, args.runTissue, args.vlm);
  return { base, pxPerCm, inputs: applyPolicy(merged, args.policy, args.gt) };
}
