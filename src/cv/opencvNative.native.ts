import {
  ColorConversionCodes,
  ContourApproximationModes,
  DataTypes,
  HoughModes,
  InterpolationFlags,
  LineTypes,
  Mat,
  MorphShapes,
  MorphTypes,
  OpenCV,
  PointVectorOfVectors,
  RetrievalModes,
  Scalar,
  Size,
} from 'react-native-fast-opencv';

import { px2ToCm2, pxPerCmFromCoinAreaPx2 } from '@/cv/measureArea';
import { breakdownFromBuffer, toPercentages } from '@/cv/tissueClassifier';
import { CvResult } from '@/decision/types';

const MAX_EDGE = 1024;

/** Count set pixels in a single-channel mask buffer. */
function countMaskPixels(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== 0) n += 1;
  }
  return n;
}

function stripDataUri(base64: string): string {
  return base64.replace(/^data:image\/\w+;base64,/, '');
}

function releaseAll(...objects: { release?: () => void }[]) {
  objects.forEach((object) => object.release?.());
}

function createMats(width: number, height: number) {
  return {
    resized: Mat.create(height, width, DataTypes.CV_8UC3),
    blurred: Mat.create(height, width, DataTypes.CV_8UC3),
    hsv: Mat.create(height, width, DataTypes.CV_8UC3),
    woundMask: Mat.create(height, width, DataTypes.CV_8UC1),
    granulationMask: Mat.create(height, width, DataTypes.CV_8UC1),
    sloughMask: Mat.create(height, width, DataTypes.CV_8UC1),
    necrosisMask: Mat.create(height, width, DataTypes.CV_8UC1),
    combined: Mat.create(height, width, DataTypes.CV_8UC1),
    gray: Mat.create(height, width, DataTypes.CV_8UC1),
  };
}

function detectCoinAreaPx2(gray: Mat): number | null {
  const circles = Mat.create(1, 3, DataTypes.CV_32FC1);
  try {
    OpenCV.HoughCircles(gray, circles, HoughModes.HOUGH_GRADIENT, 1.2, 40, 100, 30);
    if (circles.rows > 0 && circles.cols >= 3) {
      const buffer = circles.toBuffer('float32').buffer;
      const radius = buffer[2];
      if (radius > 0) {
        return Math.PI * radius * radius;
      }
    }
  } finally {
    releaseAll(circles);
  }
  return null;
}

function findLargestContourArea(contours: PointVectorOfVectors): number {
  let maxArea = 0;
  for (let i = 0; i < contours.length; i += 1) {
    const contour = contours.get(i);
    const { value } = OpenCV.contourArea(contour);
    if (value > maxArea) {
      maxArea = value;
    }
  }
  return maxArea;
}

export function runOpenCvPipeline(
  base64: string,
  includeCoinReference: boolean,
): CvResult {
  const src = Mat.createFromBase64(stripDataUri(base64));
  const scale = Math.min(1, MAX_EDGE / Math.max(src.rows, src.cols));
  const targetWidth = Math.max(1, Math.round(src.cols * scale));
  const targetHeight = Math.max(1, Math.round(src.rows * scale));

  const mats = createMats(targetWidth, targetHeight);
  const kernel = OpenCV.getStructuringElement(MorphShapes.MORPH_ELLIPSE, Size.create(5, 5));
  const contours = PointVectorOfVectors.create();
  let overlay: Mat | null = null;

  try {
    OpenCV.resize(
      src,
      mats.resized,
      Size.create(targetWidth, targetHeight),
      0,
      0,
      InterpolationFlags.INTER_LINEAR,
    );
    OpenCV.GaussianBlur(mats.resized, mats.blurred, Size.create(5, 5), 0);
    OpenCV.cvtColor(mats.blurred, mats.hsv, ColorConversionCodes.COLOR_BGR2HSV);
    OpenCV.cvtColor(mats.blurred, mats.gray, ColorConversionCodes.COLOR_BGR2GRAY);

    OpenCV.inRange(
      mats.hsv,
      Scalar.create(0, 30, 35),
      Scalar.create(35, 255, 255),
      mats.woundMask,
    );
    OpenCV.inRange(
      mats.hsv,
      Scalar.create(8, 20, 30),
      Scalar.create(45, 255, 255),
      mats.sloughMask,
    );
    OpenCV.bitwise_or(mats.woundMask, mats.sloughMask, mats.combined);
    OpenCV.inRange(
      mats.hsv,
      Scalar.create(0, 0, 0),
      Scalar.create(180, 255, 70),
      mats.necrosisMask,
    );
    OpenCV.bitwise_or(mats.combined, mats.necrosisMask, mats.combined);
    OpenCV.morphologyEx(mats.combined, mats.combined, MorphTypes.MORPH_CLOSE, kernel);
    OpenCV.morphologyEx(mats.combined, mats.combined, MorphTypes.MORPH_OPEN, kernel);

    OpenCV.findContours(
      mats.combined,
      contours,
      RetrievalModes.RETR_EXTERNAL,
      ContourApproximationModes.CHAIN_APPROX_SIMPLE,
    );

    const areaPx2 = findLargestContourArea(contours);

    OpenCV.inRange(
      mats.hsv,
      Scalar.create(0, 35, 35),
      Scalar.create(20, 255, 255),
      mats.granulationMask,
    );
    OpenCV.inRange(
      mats.hsv,
      Scalar.create(15, 35, 40),
      Scalar.create(45, 255, 255),
      mats.sloughMask,
    );
    OpenCV.inRange(
      mats.hsv,
      Scalar.create(0, 0, 0),
      Scalar.create(180, 255, 55),
      mats.necrosisMask,
    );

    const bgrBuffer = mats.blurred.toBuffer('uint8');
    // Parity with the server pipeline: tissue composition is measured inside the
    // wound mask only, so skin and background pixels can't reach the CWCS axis.
    const maskBuffer = mats.combined.toBuffer('uint8');
    const tissue = breakdownFromBuffer(bgrBuffer.buffer, bgrBuffer.channels, maskBuffer.buffer);
    const percentages = toPercentages(tissue);

    let coinDetected = false;
    let areaCm2: number | null = null;
    let pxPerCm: number | null = null;

    if (includeCoinReference) {
      const coinAreaPx2 = detectCoinAreaPx2(mats.gray);
      if (coinAreaPx2) {
        coinDetected = true;
        areaCm2 = px2ToCm2(areaPx2, coinAreaPx2);
        pxPerCm = pxPerCmFromCoinAreaPx2(coinAreaPx2);
      }
    }

    overlay = OpenCV.clone(mats.blurred);

    if (contours.length > 0) {
      OpenCV.drawContours(
        overlay,
        contours,
        0,
        Scalar.create(0, 200, 120),
        2,
        LineTypes.LINE_8,
      );
    }

    const confidence =
      areaPx2 > 500 ? (coinDetected ? 'high' : 'medium') : ('low' as const);

    return {
      ...percentages,
      areaPx2,
      areaCm2,
      pxPerCm,
      depthAssessed: false,
      confidence,
      overlayBase64: overlay?.toBase64() ?? null,
      analysisEngine: 'opencv',
      coinDetected,
      // SAM 2 point-prompt seed is computed server-side (web) from the HSV
      // centroid; the native fallback path relies on the user-tap fallback.
      hsvCentroid: null,
      maskSource: 'hsv',
      maskAreaPx: countMaskPixels(maskBuffer.buffer),
      // The periwound band needs a calibrated scale to size 4 cm in pixels; the
      // native on-device pass is a capture-time gate, so it is measured on the
      // server pipeline instead of here.
      periwound: null,
    };
  } finally {
    releaseAll(
      src,
      ...Object.values(mats),
      kernel,
      contours,
      ...(overlay ? [overlay] : []),
    );
  }
}
