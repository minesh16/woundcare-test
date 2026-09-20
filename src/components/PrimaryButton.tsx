import { Pressable, StyleSheet, Text, ViewStyle } from 'react-native';

import { AppColors } from '@/constants/appTheme';

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  style?: ViewStyle;
};

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  variant = 'primary',
  style,
}: PrimaryButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        variant === 'secondary' && styles.secondary,
        disabled && styles.disabled,
        style,
      ]}>
      <Text style={[styles.label, variant === 'secondary' && styles.secondaryLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: AppColors.teal,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  secondary: {
    backgroundColor: AppColors.white,
    borderWidth: 1,
    borderColor: AppColors.border,
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    color: AppColors.white,
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryLabel: {
    color: AppColors.navy,
  },
});
