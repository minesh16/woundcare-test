export const AppColors = {
  navy: '#0B2545',
  teal: '#1B998B',
  /** The wound edge drawn over the photo once segmentation has outlined it. */
  woundEdge: '#FFFF00',
  tealLight: '#E6F5F3',
  white: '#FFFFFF',
  background: '#F7F9FC',
  card: '#FFFFFF',
  border: '#D8E0EA',
  text: '#102A43',
  textSecondary: '#627D98',
  danger: '#C0392B',
  warning: '#D68910',
  success: '#1B998B',
};

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
