import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { ResultPanel } from '@/components/ResultPanel';
import { assess } from '@/decision/rules';
import { AppColors } from '@/constants/appTheme';
import { useSessionStore } from '@/store/sessionStore';

export default function ResultScreen() {
  const session = useSessionStore((state) => state.session);
  const saveCurrentReport = useSessionStore((state) => state.saveCurrentReport);
  const resetSession = useSessionStore((state) => state.resetSession);

  const result = useMemo(
    () => assess(session),
    [session.answers, session.bodyZone, session.cv],
  );

  const saveReport = async () => {
    saveCurrentReport(result);
    const payload = JSON.stringify({ ...session, result }, null, 2);
    const path = `${FileSystem.cacheDirectory}woundcare-demo-${session.id}.json`;

    await FileSystem.writeAsStringAsync(path, payload);

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(path, {
        mimeType: 'application/json',
        dialogTitle: 'Share demo assessment report',
      });
      return;
    }

    Alert.alert('Report saved', `Demo report saved to ${path}`);
  };

  const startNewScan = () => {
    resetSession();
    router.replace('/');
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={4} title="Demo assessment result" />
        <ResultPanel result={result} />
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton label="Save demo report" onPress={saveReport} />
        <PrimaryButton label="Start new scan" onPress={startNewScan} variant="secondary" />
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
