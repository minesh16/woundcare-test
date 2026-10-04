import { StyleSheet, Text, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

import { colors, fonts, palette } from '@/theme';

type WordmarkProps = {
  /** Height of the mark in px; the wordmark text scales with it. */
  size?: number;
  /** `dark` for light surfaces, `light` for navy / primary surfaces. */
  tone?: 'dark' | 'light';
  /** Mark only, without the "MendWise" text. */
  markOnly?: boolean;
};

/**
 * The sutured-seam mark: a closing line crossed by four stitches on a rising
 * diagonal (assets/brand/logo-mark-*.svg), beside "MendWise" in the display
 * face.
 */
export function Wordmark({ size = 40, tone = 'dark', markOnly = false }: WordmarkProps) {
  const ink = tone === 'dark' ? palette.primary900 : colors.white;

  return (
    <View style={styles.row} accessibilityRole="header" accessibilityLabel="MendWise">
      <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
        <G transform="rotate(-40 24 24)">
          <Path d="M4 24H44" stroke={ink} strokeWidth={2.5} strokeLinecap="round" />
          <Path
            d="M12 19V29M20 15V33M28 15V33M36 19V29"
            stroke={ink}
            strokeWidth={3.25}
            strokeLinecap="round"
          />
        </G>
      </Svg>
      {markOnly ? null : (
        <Text style={[styles.text, { color: ink, fontSize: size * 0.8, lineHeight: size }]}>MendWise</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  text: {
    fontFamily: fonts.display,
    letterSpacing: -0.3,
  },
});
