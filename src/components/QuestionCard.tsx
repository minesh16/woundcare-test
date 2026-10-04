import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, type } from '@/theme';

type QuestionCardProps = {
  title: string;
  children: ReactNode;
};

export function QuestionCard({ title, children }: QuestionCardProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </View>
  );
}

type OptionProps<T extends string> = {
  label: string;
  value: T;
  selected: boolean;
  onSelect: (value: T) => void;
};

export function OptionButton<T extends string>({
  label,
  value,
  selected,
  onSelect,
}: OptionProps<T>) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onSelect(value)}
      style={[styles.option, selected && styles.optionSelected]}>
      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
  },
  title: {
    ...type.headingSm,
    color: colors.textPrimary,
  },
  option: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: colors.surfaceCard,
  },
  optionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySubtle,
  },
  optionText: {
    ...type.bodyLg,
    lineHeight: 21,
    color: colors.textPrimary,
  },
  optionTextSelected: {
    fontFamily: type.headingSm.fontFamily,
  },
});
