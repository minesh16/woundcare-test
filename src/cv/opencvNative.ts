import { CvResult } from '@/decision/types';

/** Fallback stub — Metro resolves opencvNative.web.ts or opencvNative.native.ts instead. */
export function runOpenCvPipeline(
  _base64: string,
  _includeCoinReference: boolean,
): CvResult {
  throw new Error('OpenCV platform module not linked.');
}
