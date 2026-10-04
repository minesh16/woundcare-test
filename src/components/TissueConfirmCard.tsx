import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MeasuredView } from '@/assessment/measured';
import { TISSUE_CLASS_PLAIN, TISSUE_CLINICAL } from '@/copy/plainLanguage';
import { TISSUE_PRESENCE_THRESHOLD } from '@/decision/engine';
import type { ClinicianTissueChoice } from '@/decision/engine.types';
import { clinicalColors, colors, fonts, radius, type } from '@/theme';

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
    { label: TISSUE_CLASS_PLAIN.granulation, value: view.granulationPercent, color: clinicalColors.tissue.granulation },
    { label: TISSUE_CLASS_PLAIN.slough, value: view.sloughPercent, color: clinicalColors.tissue.slough },
    { label: TISSUE_CLASS_PLAIN.necrosis, value: view.necrosisPercent, color: clinicalColors.tissue.necrosis },
    { label: TISSUE_CLASS_PLAIN.epithelial, value: view.epithelialPercent, color: clinicalColors.tissue.epithelial },
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
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    ...type.caption,
    color: colors.textSecondary,
  },
  body: {
    ...type.bodyLg,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textPrimary,
  },
  note: {
    ...type.bodySm,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowLabel: {
    ...type.bodySm,
    width: 120,
    color: colors.textSecondary,
  },
  track: {
    flex: 1,
    height: 8,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.sm,
  },
  rowValue: {
    ...type.dataStrong,
    width: 44,
    textAlign: 'right',
    color: colors.textPrimary,
  },
  choices: {
    gap: 8,
  },
  choice: {
    // 44 pt minimum touch target.
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceCard,
  },
  choiceActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySubtle,
  },
  choiceText: {
    ...type.bodyLg,
    fontSize: 15,
    lineHeight: 21,
    color: colors.textPrimary,
  },
  choiceTextActive: {
    fontFamily: fonts.bodyBold,
    color: colors.primary,
  },
});
