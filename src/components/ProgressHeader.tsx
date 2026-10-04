import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, type } from '@/theme';

type ProgressHeaderProps = {
  step: number;
  total?: number;
  title: string;
};

export function ProgressHeader({ step, total = 5, title }: ProgressHeaderProps) {
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
    ...type.caption,
    color: colors.textMuted,
  },
  title: {
    ...type.headingLg,
    color: colors.textPrimary,
  },
  track: {
    height: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
  },
});
