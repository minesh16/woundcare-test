import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { CONSENT_TEXT, RESEARCH_DISCLAIMER, STEPS } from '@/constants/disclaimers';
import { AppColors } from '@/constants/appTheme';
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
          <Text style={styles.title}>WoundCare Demo</Text>
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
    backgroundColor: AppColors.background,
  },
  content: {
    padding: 20,
    gap: 20,
  },
  hero: {
    gap: 10,
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: AppColors.tealLight,
    color: AppColors.teal,
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: AppColors.navy,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: AppColors.textSecondary,
  },
  stepsCard: {
    backgroundColor: AppColors.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: AppColors.navy,
  },
  stepRow: {
    flexDirection: 'row',
    gap: 12,
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: AppColors.teal,
    color: AppColors.white,
    textAlign: 'center',
    lineHeight: 28,
    fontWeight: '700',
  },
  stepCopy: {
    flex: 1,
    gap: 2,
  },
  stepTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: AppColors.text,
  },
  stepDescription: {
    fontSize: 14,
    lineHeight: 20,
    color: AppColors.textSecondary,
  },
  consentRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: AppColors.border,
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: AppColors.teal,
    borderColor: AppColors.teal,
  },
  consentText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: AppColors.text,
  },
});
