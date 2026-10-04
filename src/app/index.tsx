import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Wordmark } from '@/components/Wordmark';
import { CONSENT_TEXT, RESEARCH_DISCLAIMER, STEPS } from '@/constants/disclaimers';
import { colors, fonts, radius, type } from '@/theme';
import { useSessionStore } from '@/store/sessionStore';

export default function WelcomeScreen() {
  const setConsent = useSessionStore((state) => state.setConsent);
  const [accepted, setAccepted] = useState(false);

  const handleStart = () => {
    setConsent(true);
    router.push('/capture');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.badge}>La Trobe · SDG 3 research demo</Text>
          <Wordmark size={40} />
          <Text style={styles.subtitle}>{RESEARCH_DISCLAIMER}</Text>
        </View>

        <View style={styles.stepsCard}>
          <Text style={styles.sectionTitle}>How it works</Text>
          {STEPS.map((step, index) => (
            <View key={step.title} style={styles.stepRow}>
              <Text style={styles.stepNumber}>{index + 1}</Text>
              <View style={styles.stepCopy}>
                <Text style={styles.stepTitle}>{step.title}</Text>
                <Text style={styles.stepDescription}>{step.description}</Text>
              </View>
            </View>
          ))}
        </View>

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: accepted }}
          onPress={() => setAccepted((value) => !value)}
          style={styles.consentRow}>
          <View style={[styles.checkbox, accepted && styles.checkboxChecked]} />
          <Text style={styles.consentText}>{CONSENT_TEXT}</Text>
        </Pressable>

        <PrimaryButton label="Start assessment" onPress={handleStart} disabled={!accepted} />
      </ScrollView>
      <DisclaimerFooter />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.surfacePage,
  },
  content: {
    padding: 20,
    gap: 20,
  },
  hero: {
    gap: 12,
  },
  badge: {
    ...type.caption,
    alignSelf: 'flex-start',
    backgroundColor: colors.primarySubtle,
    color: colors.primary,
    fontFamily: fonts.bodySemiBold,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primaryMuted,
    overflow: 'hidden',
  },
  subtitle: {
    ...type.bodyLg,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
  },
  stepsCard: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
  },
  sectionTitle: {
    ...type.headingSm,
    color: colors.textPrimary,
  },
  stepRow: {
    flexDirection: 'row',
    gap: 12,
  },
  stepNumber: {
    ...type.dataStrong,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    color: colors.textOnPrimary,
    textAlign: 'center',
    lineHeight: 28,
    overflow: 'hidden',
  },
  stepCopy: {
    flex: 1,
    gap: 2,
  },
  stepTitle: {
    ...type.headingSm,
    fontSize: 15,
    color: colors.textPrimary,
  },
  stepDescription: {
    ...type.bodyMd,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  consentRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceCard,
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  consentText: {
    ...type.bodyMd,
    lineHeight: 20,
    color: colors.textPrimary,
  },
});
