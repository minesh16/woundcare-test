/**
 * MendWise design-system colours (source: the MendWise / WardCast design
 * system, `tokens/colors.css`). The neutral and status scales are oklch there;
 * React Native cannot paint oklch, so they are stored here as sRGB hex,
 * converted once. A few warning/risk shades sit just outside sRGB and are
 * clipped, as a browser would.
 */
export const palette = {
  primary900: '#081F5C', // Galaxy
  primary800: '#1E3784',
  primary700: '#334EAC', // Planetary
  primary600: '#5272BF',
  primary500: '#7096D1', // Universe
  primary400: '#95B6DE',
  primary300: '#BAD6EB', // Venus
  primary200: '#D0E3FF', // Sky
  primary100: '#E8F1FF',
  primary50: '#F4F8FF',

  cream100: '#F7F2EB', // Meteor
  cream50: '#FFF9F0', // Milky Way

  neutral900: '#15191C',
  neutral800: '#282C2F',
  neutral700: '#3F4346',
  neutral600: '#5B5E61',
  neutral500: '#777B7D',
  neutral400: '#999C9E',
  neutral300: '#BBBEC0',
  neutral200: '#D9DBDC',
  neutral100: '#EDEFF0',
  neutral50: '#F8F8F9',
  white: '#FFFFFF',

  compliant700: '#104F29',
  compliant500: '#378450',
  compliant100: '#DBF2E0',
  warning700: '#844700',
  warning500: '#D58300',
  warning100: '#FAE5C3',
  risk700: '#830013',
  risk500: '#CC2635',
  risk100: '#FFDDDB',
} as const;

/** Brand UI colours, by role. */
export const colors = {
  surfacePage: palette.cream50,
  surfaceCard: palette.white,
  surfaceSunken: palette.neutral100,
  surfaceInverse: palette.primary900,

  /**
   * Primary actions rest one step darker than the DS default (600): white on
   * 600 is 4.65:1, white on 700 is 7.43:1. Hover and press keep stepping down.
   */
  primary: palette.primary700,
  primaryHover: palette.primary800,
  primaryPressed: palette.primary900,
  primarySubtle: palette.primary50,
  primaryMuted: palette.primary100,

  border: palette.neutral200,
  borderDefault: palette.neutral300,
  borderStrong: palette.neutral400,
  borderFocus: palette.primary400,

  textPrimary: palette.neutral900,
  textSecondary: palette.neutral700,
  textMuted: palette.neutral500,
  textDisabled: palette.neutral400,
  textOnPrimary: palette.white,
  link: palette.primary700,

  white: palette.white,
} as const;

export type StatusTone = 'compliant' | 'warning' | 'risk';

/**
 * Clinical state only: compliant = routine, warning = review, risk = refer.
 * Never for decoration, hover, or tissue type.
 */
export const status: Record<StatusTone, { fg: string; bg: string; border: string }> = {
  compliant: { fg: palette.compliant700, bg: palette.compliant100, border: palette.compliant500 },
  warning: { fg: palette.warning700, bg: palette.warning100, border: palette.warning500 },
  risk: { fg: palette.risk700, bg: palette.risk100, border: palette.risk500 },
};

/**
 * Colours that describe the photo or the wound, not the brand. Kept apart from
 * `colors` and `status` so neither leaks into the other.
 */
export const clinicalColors = {
  /** The wound edge drawn over the photo once segmentation has outlined it. */
  woundEdge: '#FFFF00',
  /** Tint over the photo where the wound mask is. */
  maskTint: '#10B981',
  tissue: {
    granulation: '#D64545',
    slough: '#E8B923',
    necrosis: '#4A3728',
    epithelial: '#F4A9B8',
    other: '#94A3B8',
  },
  /** Mask-editor tools: add wound, remove wound, box prompt. */
  tool: {
    include: '#16A34A',
    exclude: '#DC2626',
    box: '#2563EB',
  },
} as const;
