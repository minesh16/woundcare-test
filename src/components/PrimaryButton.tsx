import { useState } from 'react';
import { Pressable, StyleSheet, Text, ViewStyle } from 'react-native';

import { colors, MIN_TOUCH, radius, type } from '@/theme';

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
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
  variant = 'primary',
  style,
}: PrimaryButtonProps) {
  const [hovered, setHovered] = useState(false);
  const secondary = variant === 'secondary';

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        !disabled && hovered && (secondary ? styles.secondaryActive : styles.primaryHover),
        !disabled && pressed && (secondary ? styles.secondaryActive : styles.primaryPressed),
        disabled && styles.disabled,
        style,
      ]}>
      <Text style={[styles.label, secondary && styles.secondaryLabel]}>{label}</Text>
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
