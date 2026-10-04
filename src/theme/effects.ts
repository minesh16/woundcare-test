import type { ViewStyle } from 'react-native';

import { palette } from './colors';

/** Soft, low-opacity, never coloured. Reserved for true elevation. */
export const shadow = {
  sm: {
    shadowColor: palette.neutral900,
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: palette.neutral900,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
} as const satisfies Record<string, ViewStyle>;

/**
 * Assessment-report cards: a hairline top rule instead of an ambient shadow,
 * so they read as a clinical record rather than an app panel.
 */
export const certificate = {
  borderTopWidth: 1,
  borderTopColor: palette.neutral200,
} as const satisfies ViewStyle;
