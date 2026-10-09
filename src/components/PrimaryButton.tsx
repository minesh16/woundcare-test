import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { colors, MIN_TOUCH, radius, type } from '@/theme';

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Busy: shows a spinner and blocks presses, without the faded disabled look. */
  loading?: boolean;
  variant?: 'primary' | 'secondary';
  style?: ViewStyle;
};

/**
 * Hover and press step the fill darker in solid colour (no opacity fade, no
 * scale), per the design system.
 */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant = 'primary',
  style,
}: PrimaryButtonProps) {
  const [hovered, setHovered] = useState(false);
  const secondary = variant === 'secondary';
  const faded = disabled && !loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        !disabled && !loading && hovered && (secondary ? styles.secondaryActive : styles.primaryHover),
        !disabled && !loading && pressed && (secondary ? styles.secondaryActive : styles.primaryPressed),
        faded && styles.disabled,
        style,
      ]}>
      <View style={styles.content}>
        {loading ? <ActivityIndicator color={secondary ? colors.primary : colors.textOnPrimary} /> : null}
        <Text style={[styles.label, secondary && styles.secondaryLabel]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    minHeight: MIN_TOUCH + 4,
    paddingVertical: 12,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  primaryHover: {
    backgroundColor: colors.primaryHover,
  },
  primaryPressed: {
    backgroundColor: colors.primaryPressed,
  },
  secondary: {
    backgroundColor: colors.surfaceCard,
    borderColor: colors.borderDefault,
  },
  secondaryActive: {
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.borderStrong,
  },
  disabled: {
    opacity: 0.45,
  },
  label: {
    ...type.headingSm,
    color: colors.textOnPrimary,
  },
  secondaryLabel: {
    color: colors.textPrimary,
  },
});
