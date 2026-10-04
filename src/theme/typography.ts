import type { TextStyle } from 'react-native';

/**
 * Each weight of a custom font is its own family. Android ignores `fontWeight`
 * on a custom `fontFamily`, so styles name the weight through the family and
 * never set `fontWeight`.
 */
export const fonts = {
  display: 'SpaceGrotesk_600SemiBold',
  displayBold: 'SpaceGrotesk_700Bold',
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemiBold: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
  bodyExtraBold: 'Manrope_800ExtraBold',
  mono: 'JetBrainsMono_400Regular',
  monoSemiBold: 'JetBrainsMono_600SemiBold',
} as const;

/** The type scale (`--text-*`). Letter spacing is px here, not em. */
export const type = {
  displayLg: { fontFamily: fonts.display, fontSize: 40, lineHeight: 45, letterSpacing: -0.4 },
  displayMd: { fontFamily: fonts.display, fontSize: 32, lineHeight: 37, letterSpacing: -0.32 },
  headingLg: { fontFamily: fonts.bodySemiBold, fontSize: 24, lineHeight: 30 },
  headingMd: { fontFamily: fonts.bodySemiBold, fontSize: 20, lineHeight: 26 },
  headingSm: { fontFamily: fonts.bodySemiBold, fontSize: 16, lineHeight: 22 },
  bodyLg: { fontFamily: fonts.body, fontSize: 16, lineHeight: 25 },
  bodyMd: { fontFamily: fonts.body, fontSize: 14, lineHeight: 22 },
  bodySm: { fontFamily: fonts.body, fontSize: 13, lineHeight: 20 },
  caption: { fontFamily: fonts.bodyMedium, fontSize: 12, lineHeight: 17, letterSpacing: 0.48 },
  data: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 18 },
  dataStrong: { fontFamily: fonts.monoSemiBold, fontSize: 13, lineHeight: 18 },
} as const satisfies Record<string, TextStyle>;
