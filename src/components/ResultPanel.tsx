import { StyleSheet, Text, View } from 'react-native';

import { CLASSIFICATION_LABELS, URGENCY_LABELS } from '@/decision/rules';
import { AssessmentResult } from '@/decision/types';
import { AppColors } from '@/constants/appTheme';

type ResultPanelProps = {
  result: AssessmentResult;
};

export function ResultPanel({ result }: ResultPanelProps) {
  const urgencyColor =
    result.urgency === 'immediate'
      ? AppColors.danger
      : result.urgency === 'within_48h'
        ? AppColors.warning
        : AppColors.success;

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.label}>Classification</Text>
        <Text style={styles.value}>{CLASSIFICATION_LABELS[result.classification]}</Text>
      </View>

      <View style={[styles.card, { borderColor: urgencyColor }]}>
        <Text style={styles.label}>Urgency</Text>
        <Text style={[styles.value, { color: urgencyColor }]}>{URGENCY_LABELS[result.urgency]}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Dressing category (demo only)</Text>
        <Text style={styles.body}>{result.dressingCategory}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Why this result</Text>
        {result.rationale.map((line) => (
          <Text key={line} style={styles.bullet}>
            • {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  card: {
    backgroundColor: AppColors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: AppColors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  value: {
    fontSize: 20,
    fontWeight: '700',
    color: AppColors.navy,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: AppColors.text,
  },
  bullet: {
    fontSize: 14,
    lineHeight: 20,
    color: AppColors.text,
  },
});
