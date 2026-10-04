/** 4px-rooted spacing scale (`--space-1` … `--space-13`). */
export const space = {
  1: 2,
  2: 4,
  3: 8,
  4: 12,
  5: 16,
  6: 20,
  7: 24,
  8: 32,
  9: 40,
  10: 48,
  11: 64,
  12: 80,
  13: 96,
} as const;

/**
 * Restrained radii. `pill` is for status pills and true circles only; cards,
 * buttons and inputs use `md`, photo frames and large surfaces `lg`.
 */
export const radius = {
  sm: 2,
  md: 4,
  lg: 6,
  pill: 999,
} as const;

/** Touch targets on the capture flow are never smaller than this. */
export const MIN_TOUCH = 44;
