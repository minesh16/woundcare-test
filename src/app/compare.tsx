import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { AppColors } from '@/constants/appTheme';
import { ASSESSMENT_V2 } from '@/config/featureFlags';
import { uriToBase64 } from '@/cv/opencvPipeline';
import { runAssessmentStream } from '@/assessment/client';
import type { AssessmentState, StepOutcome } from '@/assessment/state';
import { assess } from '@/decision/rules';
import { useSessionStore } from '@/store/sessionStore';

/**
 * Side-by-side: the same photo through one unguided model call, and through the
 * MendWise pipeline.
 *
 * The point is not that the model is bad — it is that one column can be checked
 * and the other cannot. The right-hand column carries a measurement, a pathway
 * number traceable to a government guide, a rules version and an audit id; the
 * left-hand column carries fluent prose and no way to tell whether it is right.
 */

type Baseline = { source: string; text?: string; reason?: string; model?: string; latencyMs?: number };

export default function CompareScreen() {
  const session = useSessionStore((state) => state.session);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepOutcome[]>([]);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [grounded, setGrounded] = useState<AssessmentState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!session.imageUri) {
      router.replace('/capture');
      return;
    }

    setRunning(true);
    setError(null);
    setSteps([]);
    setBaseline(null);
    setGrounded(null);

    try {
      const base64 = await uriToBase64(session.imageUri);
      const local = assess(session);

      // Both arms run against the same photo, at the same time.
      const [baselineResult, groundedResult] = await Promise.all([
        fetch('/api/v1/assessments/baseline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64 }),
        })
          .then((r) => (r.ok ? (r.json() as Promise<Baseline>) : null))
          .catch(() => null),
        runAssessmentStream(
          {
            base64,
            inputs: {
              tissue: {
                necrosis: session.cv?.necrosisPercent ?? 0,
                slough: session.cv?.sloughPercent ?? 0,
                granulation: session.cv?.granulationPercent ?? 0,
                epithelial: session.cv?.epithelialPercent ?? 0,
                other: session.cv?.otherPercent ?? 0,
              },
              exudate: local.exudateLevel as never,
              infection: local.infection as never,
              markerFound: session.cv?.coinDetected,
              cvConfidence: session.cv?.confidence,
            },
            pxPerCm: session.cv?.pxPerCm ?? null,
            areaCm2: session.cv?.areaCm2 ?? null,
          },
          (step) => setSteps((prev) => [...prev, step]),
        ),
      ]);

      setBaseline(baselineResult);
      setGrounded(groundedResult);
      if (!groundedResult) {
        setError('The MendWise pipeline is not available here. Check that assessmentV2 is on and the API is reachable.');
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Comparison failed.');
    } finally {
      setRunning(false);
    }
  }, [session]);

  const result = grounded?.result;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={4} title="What grounding changes" />

        {!ASSESSMENT_V2 ? (
          <Text style={styles.warning}>
            This comparison needs the V2 pipeline. Set EXPO_PUBLIC_ASSESSMENT_V2=true and rebuild.
          </Text>
        ) : null}

        <PrimaryButton
          label={running ? 'Running both…' : 'Run both on this photo'}
          disabled={running || !session.imageUri}
          onPress={run}
        />

        {running ? (
          <View style={styles.steps}>
            <ActivityIndicator color={AppColors.teal} />
            {steps.map((step) => (
              <Text key={`${step.step}-${step.ms}`} style={styles.step}>
                {step.status === 'ok' ? '✓' : step.status === 'degraded' ? '•' : '✕'} {step.step} — {step.summary} (
                {step.ms} ms)
              </Text>
            ))}
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.column}>
          <Text style={styles.columnTitle}>One model call, no grounding</Text>
          {baseline?.text ? (
            <>
              <Text style={styles.prose}>{baseline.text}</Text>
              <Text style={styles.meta}>
                {baseline.model} · {baseline.latencyMs} ms · no measurement, no source, nothing to check it against
              </Text>
            </>
          ) : baseline ? (
            <Text style={styles.meta}>Unavailable: {baseline.reason}</Text>
          ) : (
            <Text style={styles.meta}>Not run yet.</Text>
          )}
        </View>

        <View style={[styles.column, styles.groundedColumn]}>
          <Text style={styles.columnTitle}>MendWise</Text>
          {result ? (
            <>
              <Text style={styles.fact}>
                Size: {grounded?.cv?.areaCm2 ? `${grounded.cv.areaCm2.toFixed(1)} cm² (measured)` : 'not measured'}
              </Text>
              <Text style={styles.fact}>
                Tissue: {grounded?.tissue
                  ? `${grounded.tissue.granulation}/${grounded.tissue.slough}/${grounded.tissue.necrotic}% inside the detected boundary`
                  : 'not measured'}
              </Text>
              <Text style={styles.fact}>
                Decision:{' '}
                {result.cwcsPathwayId !== null
                  ? `Australian Government CWCS pathway ${result.cwcsPathwayId}`
                  : `withheld — ${result.gateCodes.join(', ') || 'insufficient inputs'}`}
              </Text>
              <Text style={styles.fact}>
                Referral flags: {result.referrals.length ? result.referrals.map((r) => r.code).join(', ') : 'none'}
              </Text>
              <Text style={styles.fact}>Confidence: {result.confidence}</Text>
              <Text style={styles.meta}>
                Rules version {result.rulesVersion} · assessment {grounded?.id} · every input and gate is in the audit log
              </Text>
            </>
          ) : (
            <Text style={styles.meta}>Not run yet.</Text>
          )}
        </View>

        <Text style={styles.footnote}>
          Both columns saw the same photograph. The difference is not fluency — it is that the right-hand column can be
          checked, repeated and audited, and the left-hand one cannot.
        </Text>
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton label="Back to result" variant="secondary" onPress={() => router.back()} />
        <DisclaimerFooter />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: AppColors.background },
  content: { padding: 20, gap: 14 },
  column: {
    backgroundColor: AppColors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    gap: 6,
  },
  groundedColumn: { borderColor: AppColors.teal, borderWidth: 2 },
  columnTitle: { fontSize: 15, fontWeight: '700', color: AppColors.navy },
  prose: { fontSize: 14, lineHeight: 21, color: AppColors.text },
  fact: { fontSize: 14, lineHeight: 21, color: AppColors.text, fontWeight: '600' },
  meta: { fontSize: 12, lineHeight: 18, color: AppColors.textSecondary },
  steps: { gap: 4, paddingVertical: 8 },
  step: { fontSize: 13, color: AppColors.textSecondary },
  warning: { fontSize: 13, color: AppColors.warning },
  error: { fontSize: 13, color: AppColors.danger },
  footnote: { fontSize: 13, lineHeight: 20, color: AppColors.textSecondary, marginTop: 4 },
  footer: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
});
