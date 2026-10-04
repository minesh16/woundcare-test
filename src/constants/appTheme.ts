import { clinicalColors, colors, status } from '@/theme';

/**
 * @deprecated Transitional aliases over `@/theme` while screens migrate to the
 * MendWise tokens. Use `colors` / `status` / `clinicalColors` from `@/theme`.
 */
export const AppColors = {
  navy: colors.textPrimary,
  teal: colors.primary,
  woundEdge: clinicalColors.woundEdge,
  tealLight: colors.primarySubtle,
  white: colors.white,
  background: colors.surfacePage,
  card: colors.surfaceCard,
  border: colors.border,
  text: colors.textPrimary,
  textSecondary: colors.textSecondary,
  danger: status.risk.fg,
  warning: status.warning.fg,
  success: status.compliant.fg,
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
