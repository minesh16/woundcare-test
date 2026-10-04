/**
 * Caps for the assessment screens on wide (desktop web) viewports. Without
 * these the step screens stretch to the full window width.
 */
export const AppLayout = {
  maxContentWidth: 640,
  maxFigureWidth: 320,
  /** Both figures are shown at once on desktop, so each has to be shorter. */
  maxFigureWidthPaired: 205,
} as const;
