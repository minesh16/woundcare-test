import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppColors } from '@/constants/appTheme';

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
    backgroundColor: AppColors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    gap: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: AppColors.text,
  },
  option: {
    borderWidth: 1,
    borderColor: AppColors.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: AppColors.background,
  },
  optionSelected: {
    borderColor: AppColors.teal,
    backgroundColor: AppColors.tealLight,
  },
  optionText: {
    fontSize: 15,
    color: AppColors.text,
  },
  optionTextSelected: {
    color: AppColors.navy,
    fontWeight: '600',
  },
});
