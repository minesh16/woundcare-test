import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BodyMap } from '@/components/BodyMap';
import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { AppColors } from '@/constants/appTheme';
import { useSessionStore } from '@/store/sessionStore';

export default function LocationScreen() {
  const bodyZone = useSessionStore((state) => state.session.bodyZone);
  const setBodyZone = useSessionStore((state) => state.setBodyZone);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={2} title="Where is the wound?" />
        <BodyMap selectedZone={bodyZone} onSelect={setBodyZone} />
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
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
  },
});
