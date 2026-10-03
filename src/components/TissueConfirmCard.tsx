import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MeasuredView } from '@/assessment/measured';
import { AppColors } from '@/constants/appTheme';
import { TISSUE_CLASS_PLAIN, TISSUE_CLINICAL } from '@/copy/plainLanguage';
import { TISSUE_PRESENCE_THRESHOLD } from '@/decision/engine';
import type { ClinicianTissueChoice } from '@/decision/engine.types';

/**
 * Tissue confirmation (segmentation build spec §4.3) — before any pathway is
 * shown, the clinician confirms or changes the dominant tissue.
 *
 * The percentages are a colour measurement; the dominant tissue is a judgement.
 * The engine's rule is precedence, not majority: any slough over 10% makes the
 * wound "slough", even at 82% granulation, because the guide says to follow the
 * slough pathway when both are present. That is often right and sometimes not,
 * and only someone looking at the wound can say which — so it is asked, and a
 * change is logged as `tissue_override` in the correction log.
 */

const CHOICES: ClinicianTissueChoice[] = ['necrotic', 'slough', 'granulating', 'epithelialising'];

const CHOICE_LABEL: Record<ClinicianTissueChoice, string> = {
  necrotic: 'Necrotic (dark, dead)',
  slough: TISSUE_CLINICAL.slough,
  granulating: TISSUE_CLINICAL.granulating,
  epithelialising: TISSUE_CLINICAL.epithelialising,
};

export function TissueConfirmCard({
  view,
  auto,
  selected,
  onSelect,
}: {
  view: MeasuredView;
  auto: ClinicianTissueChoice | null;
  selected: ClinicianTissueChoice | null;
  onSelect: (choice: ClinicianTissueChoice) => void;
}) {
  const rows: { label: string; value: number; color: string }[] = [
    { label: TISSUE_CLASS_PLAIN.granulation, value: view.granulationPercent, color: '#D64545' },
    { label: TISSUE_CLASS_PLAIN.slough, value: view.sloughPercent, color: '#E8B923' },
    { label: TISSUE_CLASS_PLAIN.necrosis, value: view.necrosisPercent, color: '#4A3728' },
    { label: TISSUE_CLASS_PLAIN.epithelial, value: view.epithelialPercent, color: '#F4A9B8' },
  ];

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Check the tissue</Text>
      <Text style={styles.note}>Measured inside the outline you approved.</Text>
      {rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <Text style={styles.rowLabel}>{row.label}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${row.value}%`, backgroundColor: row.color }]} />
          </View>
          <Text style={styles.rowValue}>{row.value}%</Text>
        </View>
      ))}

      <Text style={styles.body}>
        {auto
          ? `By the guide's rule the wound is treated as ${CHOICE_LABEL[auto].toLowerCase()}: the most serious tissue covering at least ${TISSUE_PRESENCE_THRESHOLD}% of the wound bed decides.`
          : 'The tissue could not be identified from the measurement.'}{' '}
        Is that right?
      </Text>

      <View style={styles.choices}>
        {CHOICES.map((choice) => {
          const active = selected === choice;
          return (
            <Pressable
              key={choice}
              onPress={() => onSelect(choice)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              style={[styles.choice, active ? styles.choiceActive : null]}>
              <Text style={[styles.choiceText, active ? styles.choiceTextActive : null]}>
                {CHOICE_LABEL[choice]}
                {choice === auto ? ' (measured)' : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: AppColors.card,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: AppColors.border,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: AppColors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: AppColors.text,
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
    color: AppColors.textSecondary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowLabel: {
    width: 120,
    fontSize: 13,
    color: AppColors.textSecondary,
  },
  track: {
    flex: 1,
    height: 8,
    backgroundColor: AppColors.border,
    borderRadius: 999,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 999,
  },
  rowValue: {
    width: 40,
    textAlign: 'right',
    fontWeight: '700',
    color: AppColors.text,
  },
  choices: {
    gap: 8,
  },
  choice: {
    // 44 pt minimum touch target.
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: AppColors.border,
  },
  choiceActive: {
    borderColor: AppColors.teal,
    backgroundColor: 'rgba(0, 150, 150, 0.08)',
  },
  choiceText: {
    fontSize: 15,
    color: AppColors.text,
  },
  choiceTextActive: {
    fontWeight: '700',
    color: AppColors.teal,
  },
});
