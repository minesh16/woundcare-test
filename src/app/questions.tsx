import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { OptionButton, QuestionCard } from '@/components/QuestionCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { colors, fonts, radius, type } from '@/theme';
import { isQuestionnaireComplete, useSessionStore } from '@/store/sessionStore';

/** The Monk Skin Tone Scale's ten reference colours (Monk, 2019; Google, CC-BY 4.0). */
const MONK_SWATCHES = ['#f6ede4', '#f3e7db', '#f7ead0', '#eadaba', '#d7bd96', '#a07e56', '#825c43', '#604134', '#3a312a', '#292420'];

function TriRow({
  value,
  onSelect,
}: {
  value: 'yes' | 'no' | 'unsure' | null;
  onSelect: (value: 'yes' | 'no' | 'unsure') => void;
}) {
  return (
    <>
      {(['yes', 'no', 'unsure'] as const).map((option) => (
        <OptionButton
          key={option}
          label={option === 'yes' ? 'Yes' : option === 'no' ? 'No' : 'Unsure'}
          value={option}
          selected={value === option}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export default function QuestionsScreen() {
  const answers = useSessionStore((state) => state.session.answers);
  const setAnswers = useSessionStore((state) => state.setAnswers);
  const [clinicianFields, setClinicianFields] = useState(false);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={4} title="A few questions" />

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

        <QuestionCard title="Is fluid or pus coming from the wound?">
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

        {/* Palpated warmth (spec §4.4): a hand on the skin, compared with the
            same place on the other side. It OVERRIDES the photo's guess at
            warmth; the yes/no `warmth` answer is derived from it. */}
        <QuestionCard title="How warm is the skin around the wound, compared with the same place on the other side?">
          {(
            [
              ['cooler', 'Cooler'],
              ['same', 'About the same'],
              ['warmer', 'Warmer'],
              ['hot', 'Hot'],
            ] as const
          ).map(([value, label]) => (
            <OptionButton
              key={value}
              label={label}
              value={value}
              selected={answers.palpatedWarmth === value}
              onSelect={(v) => setAnswers({ palpatedWarmth: v, warmth: v === 'warmer' || v === 'hot' ? 'yes' : 'no' })}
            />
          ))}
        </QuestionCard>

        <QuestionCard title="Signs of local infection?">
          <Text style={styles.optionalHint}>
            Two or more of: increasing pain, spreading redness, swelling, purulent discharge, odour.
          </Text>
          {(['yes', 'no'] as const).map((option) => (
            <OptionButton
              key={`infection-${option}`}
              label={option === 'yes' ? 'Yes' : 'No'}
              value={option}
              selected={answers.infectionSigns === option}
              onSelect={(value) => setAnswers({ infectionSigns: value })}
            />
          ))}
        </QuestionCard>

        <QuestionCard title="Redness spreading more than 2 cm from the wound edge?">
          <Text style={styles.optionalHint}>Suggests spreading infection → urgent review.</Text>
          {(['yes', 'no'] as const).map((option) => (
            <OptionButton
              key={`spread-${option}`}
              label={option === 'yes' ? 'Yes' : 'No'}
              value={option}
              selected={answers.spreadingRedness === option}
              onSelect={(value) => setAnswers({ spreadingRedness: value })}
            />
          ))}
        </QuestionCard>

        <QuestionCard title="Blood flow to the area">
          <Text style={styles.optionalHint}>
            Poor blood flow changes what should be done about dead tissue, and who should look at it.
          </Text>
          {(['normal', 'reduced', 'unknown'] as const).map((option) => (
            <OptionButton
              key={`perfusion-${option}`}
              label={
                option === 'normal'
                  ? 'Normal — you can feel a pulse in the foot or limb'
                  : option === 'reduced'
                    ? 'Reduced — cold, pale or no pulse'
                    : "Don't know"
              }
              value={option}
              selected={answers.perfusion === option}
              onSelect={(value) => setAnswers({ perfusion: value })}
            />
          ))}

          {/* The ABPI reading comes from a clinician's test — most people will
              not have the number, so it sits behind the clinician toggle rather
              than as a question that reads as unanswerable. */}
          <Pressable
            onPress={() => setClinicianFields((v) => !v)}
            style={styles.toggle}
            accessibilityRole="button"
          >
            <Text style={styles.toggleText}>
              {clinicianFields ? 'Hide clinician fields' : 'I have a circulation test result'}
            </Text>
          </Pressable>

          {clinicianFields ? (
            <>
              {/* clinician-copy — these are the clinical band labels a
                  clinician reads off their own measurement. */}
              <Text style={styles.optionalLabel}>ABPI (ankle–brachial pressure index)</Text>
              {(['lt_0_5', '0_5_to_0_8', '0_8_to_1_3', 'gt_1_4', 'unknown'] as const).map((option) => (
                <OptionButton
                  key={`abpi-${option}`}
                  label={
                    option === 'lt_0_5'
                      ? '< 0.5 (critical ischaemia)'
                      : option === '0_5_to_0_8'
                        ? '0.5 – 0.8'
                        : option === '0_8_to_1_3'
                          ? '0.8 – 1.3 (normal range)'
                          : option === 'gt_1_4'
                            ? '> 1.4 (incompressible)'
                            : 'Not measured'
                  }
                  value={option}
                  selected={answers.abpiBand === option}
                  onSelect={(value) => setAnswers({ abpiBand: value })}
                />
              ))}
            </>
          ) : null}
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
        <QuestionCard title="Clinician examination (optional)">
          <Text style={styles.optionalHint}>For a clinician examining the wound. Leave blank if not assessed.</Text>

          <Text style={styles.optionalLabel}>Induration (firm swelling around the wound)</Text>
          <TriRow value={answers.induration} onSelect={(v) => setAnswers({ induration: v })} />

          <Text style={styles.optionalLabel}>Oedema</Text>
          <TriRow value={answers.oedema} onSelect={(v) => setAnswers({ oedema: v })} />

          <Text style={styles.optionalLabel}>Undermining or tunnelling</Text>
          <TriRow
            value={answers.underminingTunnelling}
            onSelect={(v) => setAnswers({ underminingTunnelling: v, underminingClock: v === 'yes' ? answers.underminingClock : null })}
          />
          {answers.underminingTunnelling === 'yes' ? (
            <>
              <Text style={styles.optionalHint}>Where? (o'clock, 12 = towards the head) — optional</Text>
              <View style={styles.painGrid}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((hour) => {
                  const selected = answers.underminingClock === hour;
                  return (
                    <Pressable
                      key={hour}
                      accessibilityRole="button"
                      onPress={() => setAnswers({ underminingClock: selected ? null : hour })}
                      style={[styles.painChip, selected && styles.painChipSelected]}>
                      <Text style={[styles.painChipText, selected && styles.painChipTextSelected]}>{hour}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          <Text style={styles.optionalLabel}>Depth (mm)</Text>
          <TextInput
            style={styles.input}
            keyboardType="decimal-pad"
            placeholder="e.g. 4"
            value={answers.depthMm != null ? String(answers.depthMm) : ''}
            onChangeText={(text) => {
              const value = Number(text.replace(',', '.'));
              setAnswers({ depthMm: text.trim() === '' || !Number.isFinite(value) ? null : Math.min(200, Math.max(0, value)) });
            }}
            accessibilityLabel="Wound depth in millimetres"
          />

          {/* Monk Skin Tone (spec §4.4): NEVER a clinical input. It stratifies
              accuracy and drives one conservative rule — at 7+, "no redness
              seen" is not taken as evidence of no infection. */}
          <Text style={styles.optionalLabel}>Skin tone (Monk scale)</Text>
          <Text style={styles.optionalHint}>Used only to check the app works equally well across skin tones.</Text>
          <View style={styles.monkRow}>
            {MONK_SWATCHES.map((colour, i) => {
              const tone = i + 1;
              const selected = answers.monkTone === tone;
              return (
                <Pressable
                  key={tone}
                  accessibilityRole="button"
                  accessibilityLabel={`Monk skin tone ${tone}`}
                  accessibilityState={{ selected }}
                  onPress={() => setAnswers({ monkTone: selected ? null : tone })}
                  style={[styles.monkSwatch, { backgroundColor: colour }, selected && styles.monkSwatchSelected]}>
                  <Text style={[styles.monkLabel, { color: tone >= 6 ? '#FFFFFF' : '#1F2937' }]}>{tone}</Text>
                </Pressable>
              );
            })}
          </View>
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
  input: {
    ...type.bodyLg,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceCard,
  },
  monkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  monkSwatch: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  monkSwatchSelected: {
    borderColor: colors.primary,
    transform: [{ scale: 1.1 }],
  },
  monkLabel: {
    ...type.dataStrong,
  },
  container: {
    flex: 1,
    backgroundColor: colors.surfacePage,
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
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceCard,
    alignItems: 'center',
  },
  painChipSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySubtle,
  },
  painChipText: {
    ...type.dataStrong,
    fontSize: 15,
    color: colors.textPrimary,
  },
  painChipTextSelected: {
    color: colors.primary,
  },
  toggle: {
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceCard,
  },
  toggleText: {
    ...type.bodyMd,
    fontFamily: fonts.bodySemiBold,
    color: colors.textPrimary,
  },
  optionalHint: {
    ...type.bodySm,
    color: colors.textSecondary,
  },
  optionalLabel: {
    ...type.bodyMd,
    fontFamily: fonts.bodyBold,
    color: colors.textPrimary,
    marginTop: 4,
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
  },
});
