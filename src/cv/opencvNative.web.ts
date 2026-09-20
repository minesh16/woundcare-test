import { CvResult } from '@/decision/types';

/** Web stub — real OpenCV runs only in the native dev client. */
export function runOpenCvPipeline(
  _base64: string,
  _includeCoinReference: boolean,
): CvResult {
  throw new Error('OpenCV is not available on web.');
}
