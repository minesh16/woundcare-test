import loadOpenCV from 'opencv-js-wasm';

/**
 * Focused type surface for the OpenCV.js build shipped by `opencv-js-wasm`.
 * The package's bundled .d.ts only covers a subset of the real runtime API,
 * so we declare exactly the members this backend uses.
 */
export interface CvMat {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32F: Float32Array;
  type(): number;
  channels(): number;
  clone(): CvMat;
  delete(): void;
}

export interface CvMatVector {
  size(): number;
  get(index: number): CvMat;
  delete(): void;
}

export interface CvSize {
  width: number;
  height: number;
}

/** Spatial image moments (subset) — used to derive a contour centroid. */
export interface CvMoments {
  m00: number;
  m10: number;
  m01: number;
}

export interface CvScalar {
  readonly __scalar: unique symbol;
}

export interface ImageDataLike {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Cv {
  Mat: {
    new (): CvMat;
    new (rows: number, cols: number, type: number): CvMat;
    new (rows: number, cols: number, type: number, scalar: CvScalar): CvMat;
  };
  MatVector: { new (): CvMatVector };
  Size: { new (width: number, height: number): CvSize };
  Scalar: { new (v0: number, v1?: number, v2?: number, v3?: number): CvScalar };

  matFromImageData(imageData: ImageDataLike): CvMat;
  cvtColor(src: CvMat, dst: CvMat, code: number, dstCn?: number): void;
  resize(src: CvMat, dst: CvMat, dsize: CvSize, fx?: number, fy?: number, interpolation?: number): void;
  GaussianBlur(src: CvMat, dst: CvMat, ksize: CvSize, sigmaX: number, sigmaY?: number): void;
  inRange(src: CvMat, lowerb: CvMat, upperb: CvMat, dst: CvMat): void;
  bitwise_or(src1: CvMat, src2: CvMat, dst: CvMat): void;
  morphologyEx(src: CvMat, dst: CvMat, op: number, kernel: CvMat): void;
  dilate(src: CvMat, dst: CvMat, kernel: CvMat): void;
  subtract(src1: CvMat, src2: CvMat, dst: CvMat): void;
  getStructuringElement(shape: number, ksize: CvSize): CvMat;
  findContours(image: CvMat, contours: CvMatVector, hierarchy: CvMat, mode: number, method: number): void;
  drawContours(image: CvMat, contours: CvMatVector, contourIdx: number, color: CvScalar, thickness?: number, lineType?: number): void;
  contourArea(contour: CvMat): number;
  moments(array: CvMat, binaryImage?: boolean): CvMoments;
  HoughCircles(
    image: CvMat,
    circles: CvMat,
    method: number,
    dp: number,
    minDist: number,
    param1?: number,
    param2?: number,
    minRadius?: number,
    maxRadius?: number,
  ): void;

  CV_8UC1: number;
  CV_8UC3: number;
  COLOR_RGBA2RGB: number;
  COLOR_RGB2HSV: number;
  COLOR_RGB2GRAY: number;
  COLOR_RGB2RGBA: number;
  MORPH_ELLIPSE: number;
  MORPH_CLOSE: number;
  MORPH_OPEN: number;
  RETR_EXTERNAL: number;
  CHAIN_APPROX_SIMPLE: number;
  INTER_LINEAR: number;
  HOUGH_GRADIENT: number;
  LINE_8: number;
}

let cached: Promise<Cv> | null = null;

/** Loads the embedded-WASM OpenCV.js runtime once and caches it across warm invocations. */
export function loadCv(): Promise<Cv> {
  if (!cached) {
    cached = loadOpenCV() as unknown as Promise<Cv>;
  }
  return cached;
}
