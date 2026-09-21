import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { ResultPanel } from '@/components/ResultPanel';
import { ASSESSMENT_V2 } from '@/config/featureFlags';
import { BODY_ZONE_LABELS } from '@/constants/bodyZones';
import { renderTemplateReport } from '@/assessment/reportTemplate';
import { assess } from '@/decision/rules';
import { evaluate } from '@/decision/engine';
import { toEngineInputs } from '@/decision/rules';
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

  // The full engine result (not just the UI-facing subset) drives the export.
  const engineResult = useMemo(
    () => evaluate(toEngineInputs(session)),
    [session.answers, session.bodyZone, session.cv],
  );

  const saveReport = async () => {
    saveCurrentReport(result);
    // Export carries both documents: the clinician-facing record and the plain
    // -English summary, rendered deterministically so a saved report never
    // depends on a model being reachable.
    const documents = engineResult
      ? renderTemplateReport({
          result: engineResult,
          areaCm2: session.cv?.areaCm2 ?? null,
          bodyZoneLabel: session.bodyZone ? BODY_ZONE_LABELS[session.bodyZone] : null,
          tissuePct: session.cv
            ? {
                granulation: session.cv.granulationPercent,
                slough: session.cv.sloughPercent,
                necrosis: session.cv.necrosisPercent,
                epithelial: session.cv.epithelialPercent,
              }
            : null,
        })
      : null;
    const payload = JSON.stringify({ ...session, result, documents }, null, 2);
    const path = `${FileSystem.cacheDirectory}mendwise-report-${session.id}.json`;

    await FileSystem.writeAsStringAsync(path, payload);

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(path, {
        mimeType: 'application/json',
        dialogTitle: 'Share assessment report',
      });
      return;
    }

    Alert.alert('Report saved', `Saved to ${path}`);
  };

  const startNewScan = () => {
    resetSession();
    router.replace('/');
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={4} title="Your result" />
        <ResultPanel result={result} />
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton label="Save report" onPress={saveReport} />
        {ASSESSMENT_V2 ? (
          <PrimaryButton
            label="Compare with an ungrounded AI answer"
            variant="secondary"
            onPress={() => router.push('/compare')}
          />
        ) : null}
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
