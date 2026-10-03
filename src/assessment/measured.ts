import type { ScanSession } from '@/decision/types';

/**
 * The one place that answers "what did we measure?" for a session.
 *
 * Every consumer — the engine inputs, the rationale, the result screen, the
 * report and the server run — reads tissue %, scale and size through here, so
 * there is no way for one of them to use the approved outline while another
 * uses the HSV mask. That split is exactly how a leg-ulcer photo showed "77%
 * slough" (skin, inside the HSV mask of the whole leg) beside a server report of
 * 82% granulation (inside the approved outline).
 *
 *  - `approved_outline`: the measurement of the boundary the clinician signed
 *    off (`session.measurement`, assessmentV2).
 *  - `hsv`: the on-device colour-threshold pass (`session.cv`) — the legacy
 *    flow with assessmentV2 off.
 */
export type MeasuredView = {
  source: 'approved_outline' | 'hsv';
  granulationPercent: number;
  sloughPercent: number;
  necrosisPercent: number;
  epithelialPercent: number;
  otherPercent: number;
  pxPerCm: number | null;
  /** A scale reference was found AND not rejected by the clinician. */
  markerFound: boolean;
  areaCm2: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  perimeterCm: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** Colours corrected against a white reference patch. */
  whiteBalanced: boolean;
  periwound: { rednessPct: number; maceration: boolean } | null;
};

/** Below this many pixels an outline is too small to measure reliably. */
const MIN_RELIABLE_MASK_PX = 500;

export function measuredView(session: ScanSession): MeasuredView | null {
  const m = session.measurement;
  if (m) {
    const scale = m.scaleRejected ? null : m.scale;
    return {
      source: 'approved_outline',
      granulationPercent: m.granulationPercent,
      sloughPercent: m.sloughPercent,
      necrosisPercent: m.necrosisPercent,
      epithelialPercent: m.epithelialPercent,
      otherPercent: m.otherPercent,
      pxPerCm: scale?.pxPerCm ?? null,
      markerFound: scale !== null,
      // Everything in cm was sized with the scale; a rejected scale takes it all.
      areaCm2: scale ? m.geometry.areaCm2 : null,
      lengthCm: scale ? m.geometry.lengthCm : null,
      widthCm: scale ? m.geometry.widthCm : null,
      perimeterCm: scale ? m.geometry.perimeterCm : null,
      // Same rule the on-device pass uses, so the engine sees comparable bands —
      // and capped at medium when the colours were not corrected against a white
      // reference (spec §5: no marker → `no_marker`, tissue confidence ≤ medium).
      confidence:
        m.maskAreaPx <= MIN_RELIABLE_MASK_PX ? 'low' : scale && m.whiteBalance?.applied ? 'high' : 'medium',
      whiteBalanced: Boolean(m.whiteBalance?.applied),
      // The 4 cm periwound band was sized with the scale too.
      periwound: scale && m.periwound ? { rednessPct: m.periwound.rednessPct, maceration: m.periwound.maceration } : null,
    };
  }

  const cv = session.cv;
  if (!cv) return null;
  return {
    source: 'hsv',
    granulationPercent: cv.granulationPercent,
    sloughPercent: cv.sloughPercent,
    necrosisPercent: cv.necrosisPercent,
    epithelialPercent: cv.epithelialPercent,
    otherPercent: cv.otherPercent,
    pxPerCm: cv.pxPerCm,
    markerFound: cv.coinDetected,
    areaCm2: cv.areaCm2,
    lengthCm: null,
    widthCm: null,
    perimeterCm: null,
    confidence: cv.confidence,
    whiteBalanced: false,
    periwound: cv.periwound ? { rednessPct: cv.periwound.rednessPct, maceration: cv.periwound.maceration } : null,
  };
}
