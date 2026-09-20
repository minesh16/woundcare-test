import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { OptionButton, QuestionCard } from '@/components/QuestionCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { AppColors } from '@/constants/appTheme';
import { isQuestionnaireComplete, useSessionStore } from '@/store/sessionStore';

export default function QuestionsScreen() {
  const answers = useSessionStore((state) => state.session.answers);
  const setAnswers = useSessionStore((state) => state.setAnswers);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={3} title="Diagnostic questions" />

        <QuestionCard title="Has the wound been present for more than 30 days?">
          {(['yes', 'no', 'unsure'] as const).map((option) => (
            <OptionButton
              key={option}
              label={option === 'yes' ? 'Yes' : option === 'no' ? 'No' : "Don't know"}
              value={option}
              selected={answers.durationOver30Days === option}
              onSelect={(value) => setAnswers({ durationOver30Days: value })}
            />
          ))}
        </QuestionCard>

        <QuestionCard title="Is there exudate or pus?">
          {(['none', 'moderate', 'heavy'] as const).map((option) => (
            <OptionButton
              key={option}
              label={option.charAt(0).toUpperCase() + option.slice(1)}
              value={option}
              selected={answers.exudate === option}
              onSelect={(value) => setAnswers({ exudate: value })}
            />
          ))}
        </QuestionCard>

        <QuestionCard title="Pain level (0–10)">
          <View style={styles.painGrid}>
            {Array.from({ length: 11 }, (_, level) => {
              const selected = answers.pain === level;
              return (
                <Pressable
                  key={level}
                  accessibilityRole="button"
                  onPress={() => setAnswers({ pain: level })}
                  style={[styles.painChip, selected && styles.painChipSelected]}>
                  <Text style={[styles.painChipText, selected && styles.painChipTextSelected]}>
                    {level}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </QuestionCard>

        <QuestionCard title="Does the area around the wound feel warm?">
          {(['yes', 'no'] as const).map((option) => (
            <OptionButton
              key={option}
              label={option === 'yes' ? 'Yes' : 'No'}
              value={option}
              selected={answers.warmth === option}
              onSelect={(value) => setAnswers({ warmth: value })}
            />
          ))}
        </QuestionCard>

        <QuestionCard title="Optional: diabetes or immunocompromise">
          <Text style={styles.optionalHint}>These increase urgency if infection signs are present.</Text>
          <Text style={styles.optionalLabel}>Diabetes</Text>
          {(['yes', 'no'] as const).map((option) => (
            <OptionButton
              key={`diabetes-${option}`}
              label={option === 'yes' ? 'Yes' : 'No / not applicable'}
              value={option}
              selected={answers.diabetes === option}
              onSelect={(value) => setAnswers({ diabetes: value })}
            />
          ))}
          <Text style={styles.optionalLabel}>Immunocompromised</Text>
          {(['yes', 'no'] as const).map((option) => (
            <OptionButton
              key={`immune-${option}`}
              label={option === 'yes' ? 'Yes' : 'No / not applicable'}
              value={option}
              selected={answers.immunocompromised === option}
              onSelect={(value) => setAnswers({ immunocompromised: value })}
            />
          ))}
        </QuestionCard>
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton
          label="View result"
          disabled={!isQuestionnaireComplete(answers)}
          onPress={() => router.push('/result')}
        />
        <DisclaimerFooter />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: AppColors.background,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  painGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  painChip: {
    minWidth: 44,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: AppColors.border,
    backgroundColor: AppColors.background,
    alignItems: 'center',
  },
  painChipSelected: {
    borderColor: AppColors.teal,
    backgroundColor: AppColors.tealLight,
  },
  painChipText: {
    fontSize: 15,
    color: AppColors.text,
    fontWeight: '600',
  },
  painChipTextSelected: {
    color: AppColors.navy,
  },
  optionalHint: {
    fontSize: 13,
    color: AppColors.textSecondary,
  },
  optionalLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: AppColors.text,
    marginTop: 4,
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
  },
});
