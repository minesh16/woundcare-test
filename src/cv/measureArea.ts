/** Australian 20c coin face area in cm² (diameter 28.52 mm). */
export const COIN_AREA_CM2 = Math.PI * (2.852 / 2) ** 2;

export function px2ToCm2(woundAreaPx2: number, coinAreaPx2: number): number {
  if (coinAreaPx2 <= 0) {
    return 0;
  }
  return (woundAreaPx2 / coinAreaPx2) * COIN_AREA_CM2;
}

export function formatArea(areaPx2: number, areaCm2: number | null): string {
  if (areaCm2 !== null && areaCm2 > 0) {
    return `${areaCm2.toFixed(1)} cm²`;
  }
  return `${Math.round(areaPx2).toLocaleString()} px² (relative)`;
}
