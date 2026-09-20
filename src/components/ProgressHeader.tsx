import { StyleSheet, Text, View } from 'react-native';

import { AppColors } from '@/constants/appTheme';

type ProgressHeaderProps = {
  step: number;
  total?: number;
  title: string;
};

export function ProgressHeader({ step, total = 4, title }: ProgressHeaderProps) {
  const progress = step / total;

  return (
    <View style={styles.container}>
      <Text style={styles.stepLabel}>
        Step {step} of {total}
      </Text>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${progress * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
    marginBottom: 16,
  },
  stepLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: AppColors.teal,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: AppColors.navy,
  },
  track: {
    height: 6,
    borderRadius: 999,
    backgroundColor: AppColors.border,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: AppColors.teal,
    borderRadius: 999,
  },
});
