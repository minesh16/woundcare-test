import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { CLASSIFICATION_LABELS, URGENCY_ACTIONS } from '@/decision/rules';
import { AssessmentResult } from '@/decision/types';
import {
  CONFIDENCE_PLAIN,
  EXUDATE_PLAIN,
  GATE_PLAIN,
  INFECTION_PLAIN,
  TISSUE_CLINICAL,
  TISSUE_PLAIN,
} from '@/copy/plainLanguage';
import { REFERRAL_COPY, URGENCY_PLAIN } from '@/copy/referrals';
import type { ExudateLevel, Infection, TissueType } from '@/decision/engine.types';
import { certificate, colors, fonts, radius, status, type } from '@/theme';

/**
 * The scan result, written for the person holding the phone.
 *
 * Order is deliberate: what to do, then what we saw, then the dressing
 * suggestion, then why. The clinical vocabulary is not deleted — it moves
 * behind the "Clinician view" toggle, along with the pathway number, the
 * referral codes and the rules version, so the audit-facing detail is one tap
 * away rather than the default reading experience.
 */

type ResultPanelProps = {
  result: AssessmentResult;
};

export function ResultPanel({ result }: ResultPanelProps) {
  const [clinicianView, setClinicianView] = useState(false);

  const urgencyTone =
    result.urgency === 'immediate'
      ? status.risk
      : result.urgency === 'within_48h'
        ? status.warning
        : status.compliant;

  const referrals = result.referrals ?? [];
  const gateCodes = result.gateCodes ?? [];
  const tissue = result.tissueType as TissueType | null | undefined;

  return (
    <View style={styles.container}>
      {/* 1. What to do -------------------------------------------------- */}
      <View style={[styles.actionCard, { borderColor: urgencyTone.border }]}>
        <Text style={styles.label}>What to do</Text>
        <Text style={[styles.action, { color: urgencyTone.fg }]}>{URGENCY_ACTIONS[result.urgency]}</Text>
        {referrals.length > 0 ? (
          <Text style={styles.actionDetail}>
            {REFERRAL_COPY[referrals[0].code]?.whatToDo ?? referrals[0].message}
          </Text>
        ) : null}
      </View>

      {/* 2. What we saw -------------------------------------------------- */}
      <View style={styles.card}>
        <Text style={styles.label}>What we saw</Text>
        {/* Not "mostly": the guide follows the most serious tissue present (any
            slough over 10% counts as slough), so an 82%-granulation wound can be
            on the slough pathway. Saying "mostly slough" there would be false. */}
        {tissue ? (
          <Text style={styles.body}>• For choosing a dressing, the wound counts as having {TISSUE_PLAIN[tissue]}.</Text>
        ) : null}
        {result.exudateLevel ? (
          <Text style={styles.body}>
            • There is {EXUDATE_PLAIN[result.exudateLevel as ExudateLevel]} coming from the wound.
          </Text>
        ) : null}
        {result.infection ? (
          <Text style={styles.body}>• We found {INFECTION_PLAIN[result.infection as Infection]}.</Text>
        ) : null}
        {result.areaCm2 ? (
          <Text style={styles.body}>• The wound measures about {result.areaCm2.toFixed(1)} square centimetres.</Text>
        ) : (
          <Text style={styles.body}>• We could not measure the size of the wound from this photo.</Text>
        )}
      </View>

      {/* 3. Dressing, or why there isn't one ----------------------------- */}
      {result.cwcsPathwayId != null && result.primaryDressings?.length ? (
        <View style={styles.card}>
          <Text style={styles.label}>Suggested dressing type</Text>
          {result.primaryDressings.map((item) => (
            <Text key={item} style={styles.body}>
              • {item}
            </Text>
          ))}
          <Text style={styles.provenance}>
            Based on the Australian Government wound care guide (pathway {result.cwcsPathwayId}).
          </Text>
        </View>
      ) : gateCodes.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.label}>Why there is no dressing suggestion</Text>
          {gateCodes.map((code) => {
            const gate = GATE_PLAIN[code];
            return gate ? (
              <View key={code} style={styles.gate}>
                <Text style={styles.gateTitle}>{gate.title}</Text>
                <Text style={styles.body}>{gate.whatToDo}</Text>
              </View>
            ) : null;
          })}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>No dressing suggestion yet</Text>
          <Text style={styles.body}>
            We do not have enough information to suggest a dressing. Answer the remaining questions, or have the wound
            looked at.
          </Text>
        </View>
      )}

      {/* 4. Things to raise ---------------------------------------------- */}
      {referrals.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.label}>Things to raise with a clinician</Text>
          {referrals.map((flag) => {
            const copy = REFERRAL_COPY[flag.code];
            return (
              <View key={flag.code} style={styles.gate}>
                <Text style={styles.gateTitle}>{copy?.title ?? URGENCY_PLAIN[flag.urgency as 'urgent']}</Text>
                <Text style={styles.body}>{copy?.whatThisMeans ?? flag.message}</Text>
                {copy ? <Text style={styles.bodyMuted}>{copy.whatToDo}</Text> : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* 5. Confidence ---------------------------------------------------- */}
      {result.confidence ? (
        <View style={styles.card}>
          <Text style={styles.label}>How sure are we?</Text>
          <Text style={styles.body}>{CONFIDENCE_PLAIN[result.confidence]}</Text>
        </View>
      ) : null}

      {/* 6. Clinician view ------------------------------------------------ */}
      <Pressable
        onPress={() => setClinicianView((v) => !v)}
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityLabel={clinicianView ? 'Hide clinician view' : 'Show clinician view'}
      >
        <Text style={styles.toggleText}>{clinicianView ? 'Hide clinician view' : 'Clinician view'}</Text>
      </Pressable>

      {clinicianView ? (
        <View style={[styles.card, styles.clinicianCard]}>
          <Text style={styles.label}>Clinician view</Text>
          <Text style={styles.mono}>Classification: {CLASSIFICATION_LABELS[result.classification]}</Text>
          <Text style={styles.mono}>
            Axes — tissue: {tissue ? TISSUE_CLINICAL[tissue] : 'not determined'}; exudate:{' '}
            {result.exudateLevel ?? 'not determined'}; infection: {result.infection ?? 'not determined'}
          </Text>
          <Text style={styles.mono}>
            CWCS pathway: {result.cwcsPathwayId ?? 'none'}
            {result.pathwayWithheld ? ' (withheld by safety gate)' : ''}
          </Text>
          {result.secondaryDressings?.length ? (
            <Text style={styles.mono}>Secondary: {result.secondaryDressings.join('; ')}</Text>
          ) : null}
          {referrals.length ? (
            <Text style={styles.mono}>
              Referral flags: {referrals.map((f) => `${f.code} (${f.urgency})`).join(', ')}
            </Text>
          ) : null}
          {gateCodes.length ? <Text style={styles.mono}>Safety gates: {gateCodes.join(', ')}</Text> : null}
          <Text style={styles.mono}>Confidence: {result.confidence ?? 'n/a'}</Text>
          <Text style={styles.mono}>Rules version: {result.rulesVersion ?? 'n/a'}</Text>
          <Text style={[styles.label, styles.rationaleLabel]}>Rationale</Text>
          {result.rationale.map((line) => (
            <Text key={line} style={styles.mono}>
              • {line}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  actionCard: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    borderWidth: 2,
    gap: 6,
  },
  /** The audit-facing record: hairline top rule, no ambient shadow. */
  clinicianCard: {
    ...certificate,
    borderTopColor: colors.borderDefault,
  },
  label: {
    ...type.caption,
    color: colors.textSecondary,
  },
  action: {
    ...type.headingMd,
    fontSize: 22,
    lineHeight: 28,
  },
  actionDetail: {
    ...type.bodyLg,
    lineHeight: 23,
    color: colors.textPrimary,
  },
  body: {
    ...type.bodyLg,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textPrimary,
  },
  bodyMuted: {
    ...type.bodyMd,
    lineHeight: 21,
    color: colors.textSecondary,
  },
  provenance: {
    ...type.caption,
    letterSpacing: 0,
    lineHeight: 18,
    color: colors.textSecondary,
    marginTop: 4,
  },
  gate: {
    gap: 2,
    marginTop: 4,
  },
  gateTitle: {
    ...type.headingSm,
    fontSize: 15,
    fontFamily: fonts.bodyBold,
    color: colors.textPrimary,
  },
  toggle: {
    alignSelf: 'flex-start',
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
  mono: {
    ...type.data,
    lineHeight: 19,
    color: colors.textPrimary,
  },
  rationaleLabel: {
    marginTop: 8,
  },
});
