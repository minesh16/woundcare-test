import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

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
import { runAssessmentStream } from '@/assessment/client';
import { uriToBase64 } from '@/cv/opencvPipeline';
import type { StepOutcome } from '@/assessment/state';
import { useSessionStore } from '@/store/sessionStore';

export default function ResultScreen() {
  const session = useSessionStore((state) => state.session);
  const saveCurrentReport = useSessionStore((state) => state.saveCurrentReport);
  const resetSession = useSessionStore((state) => state.resetSession);
  const setV2Run = useSessionStore((state) => state.setV2Run);

  const [steps, setSteps] = useState<StepOutcome[]>([]);
  const [running, setRunning] = useState(false);
  const started = useRef(false);

  /**
   * Run the server pipeline over the boundary the clinician approved.
   *
   * Until now the main flow stopped at the on-device engine: the caged VLM, the
   * report LLM, Supabase persistence and the audit log were only reachable from
   * the comparison screen, so a real assessment left no audit trail. This is
   * where that changes — `run` is the only path that writes one.
   *
   * `approvedBoundary` is the point of the review step: the server does NOT
   * re-segment, so the tissue percentages are measured inside exactly the mask a
   * human signed off, and the audit record's approval field refers to that mask.
   *
   * Conservative by default: if the run fails for any reason the deterministic
   * on-device result below is already rendered and stands. The server run adds
   * the VLM axis, the written report and the audit row — it never replaces the
   * decision with something less grounded.
   */
  useEffect(() => {
    if (!ASSESSMENT_V2 || started.current) return;
    const boundary = session.boundary;
    if (!boundary || !session.imageUri || !session.cv) return;
    started.current = true;

    let cancelled = false;
    (async () => {
      setRunning(true);
      try {
        const base64 = await uriToBase64(session.imageUri!);
        const final = await runAssessmentStream(
          {
            base64,
            inputs: toEngineInputs(session),
            pxPerCm: session.cv?.pxPerCm ?? null,
            areaCm2: session.cv?.areaCm2 ?? null,
            bodyZoneLabel: session.bodyZone ? BODY_ZONE_LABELS[session.bodyZone] : null,
            approvedBoundary: {
              maskUrl: boundary.maskUrl,
              approval: boundary.approval,
              provider: boundary.provider,
              model: boundary.model,
              outlinePoints: boundary.outline?.length ?? null,
            },
          },
          (step) => {
            if (!cancelled) setSteps((prior) => [...prior, step]);
          },
        );
        if (!cancelled && final) setV2Run(final as unknown as Record<string, unknown>, null);
      } catch {
        // Already handled inside runAssessmentStream; the on-device result stands.
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, setV2Run]);

  const result = useMemo(
    () => assess(session),
    [session.answers, session.bodyZone, session.cv],
  );

  // The full engine result (not just the UI-facing subset) drives the export.
  const engineResult = useMemo(
    () => evaluate(toEngineInputs(session)),
    [session.answers, session.bodyZone, session.cv],
  );

  // Present once a V2 run has been made (from the comparison screen). It is a
  // restatement of the decision above, never an addition to it.
  const aiReport = (session.v2 as { report?: { patientSummary: string; source: string } } | null)?.report ?? null;

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
    // The AI-composed report, when a V2 run produced one. It is an *addition*
    // to the deterministic documents, never a replacement: the template is what
    // the export can always be trusted to contain.
    const v2 = session.v2 as { report?: { clinicianReport: string; patientSummary: string; source: string; model?: string } } | null;

    const payload = JSON.stringify(
      {
        ...session,
        result,
        documents,
        aiReport: v2?.report ?? null,
        comparison: session.baseline ?? null,
      },
      null,
      2,
    );
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
        <ProgressHeader step={5} title="Your result" />
        <ResultPanel result={result} />

        {running ? (
          <View style={styles.runCard}>
            <View style={styles.runHeader}>
              <ActivityIndicator color={AppColors.teal} />
              <Text style={styles.runTitle}>Finishing your assessment</Text>
            </View>
            {steps.map((step, index) => (
              <Text key={`${step.step}-${index}`} style={styles.runStep}>
                {step.status === 'ok' ? '✓' : '·'} {step.summary}
              </Text>
            ))}
            <Text style={styles.runNote}>
              The result above is already final. This step adds the written summary and records
              the assessment.
            </Text>
          </View>
        ) : null}

        {session.boundary ? (
          <Text style={styles.boundaryNote}>
            {session.boundary.approval === 'drawn'
              ? 'Measured inside the outline you drew.'
              : session.boundary.approval === 'adjusted'
                ? 'Measured inside the outline you adjusted.'
                : 'Measured inside the outline you approved.'}
          </Text>
        ) : null}

        {aiReport ? (
          <View style={styles.aiCard}>
            <Text style={styles.aiLabel}>In plain words</Text>
            <Text style={styles.aiBody}>{aiReport.patientSummary}</Text>
            <Text style={styles.aiMeta}>
              {aiReport.source === 'llm'
                ? 'Written from the findings above and checked against them before being shown.'
                : 'Written from the findings above using the standard wording.'}
            </Text>
          </View>
        ) : null}
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
  runCard: {
    backgroundColor: AppColors.card,
    borderRadius: 16,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: AppColors.border,
  },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  runTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: AppColors.navy,
  },
  runStep: {
    fontSize: 14,
    color: AppColors.text,
  },
  runNote: {
    fontSize: 13,
    lineHeight: 19,
    color: AppColors.textSecondary,
  },
  boundaryNote: {
    fontSize: 13,
    color: AppColors.textSecondary,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  aiCard: {
    backgroundColor: AppColors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    gap: 6,
  },
  aiLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: AppColors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  aiBody: {
    fontSize: 15,
    lineHeight: 22,
    color: AppColors.text,
  },
  aiMeta: {
    fontSize: 12,
    lineHeight: 18,
    color: AppColors.textSecondary,
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
  },
});
