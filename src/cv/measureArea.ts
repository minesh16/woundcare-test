/** Australian 20c coin diameter in cm (28.52 mm). */
export const COIN_DIAMETER_CM = 2.852;

/** Australian 20c coin face area in cm² (diameter 28.52 mm). */
export const COIN_AREA_CM2 = Math.PI * (COIN_DIAMETER_CM / 2) ** 2;

export function px2ToCm2(woundAreaPx2: number, coinAreaPx2: number): number {
  if (coinAreaPx2 <= 0) {
    return 0;
  }
  return (woundAreaPx2 / coinAreaPx2) * COIN_AREA_CM2;
}

/**
 * Calibration scale (pixels per cm) from the detected coin's pixel area.
 * The coin is circular, so diameter_px = 2·√(area_px2 / π); px_per_cm is that
 * diameter divided by the known coin diameter. Returns null if area is invalid.
 */
export function pxPerCmFromCoinAreaPx2(coinAreaPx2: number): number | null {
  if (coinAreaPx2 <= 0) {
    return null;
  }
  const diameterPx = 2 * Math.sqrt(coinAreaPx2 / Math.PI);
  return diameterPx / COIN_DIAMETER_CM;
}

/**
 * Calibration scale (pixels per cm) from a square reference marker (e.g. ArUco)
 * of a known side length. Returns null if inputs are invalid.
 */
export function pxPerCmFromMarkerSide(markerSidePx: number, markerSideCm: number): number | null {
  if (markerSidePx <= 0 || markerSideCm <= 0) {
    return null;
  }
  return markerSidePx / markerSideCm;
}

export function formatArea(areaPx2: number, areaCm2: number | null): string {
  if (areaCm2 !== null && areaCm2 > 0) {
    return `${areaCm2.toFixed(1)} cm²`;
  }
  return `${Math.round(areaPx2).toLocaleString()} px² (relative)`;
}
