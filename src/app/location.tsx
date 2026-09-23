import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BodySelector } from '@/components/BodySelector';
import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { AppColors, AppLayout } from '@/constants/appTheme';
import { useSessionStore } from '@/store/sessionStore';

export default function LocationScreen() {
  const bodyZone = useSessionStore((state) => state.session.bodyZone);
  const setBodyZone = useSessionStore((state) => state.setBodyZone);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={2} title="Where is the wound?" />
        <BodySelector selectedZone={bodyZone} onSelect={setBodyZone} />
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton
          label="Continue to questions"
          disabled={!bodyZone}
          onPress={() => router.push('/questions')}
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
    width: '100%',
    maxWidth: AppLayout.maxContentWidth,
    alignSelf: 'center',
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
    width: '100%',
    maxWidth: AppLayout.maxContentWidth,
    alignSelf: 'center',
  },
});
