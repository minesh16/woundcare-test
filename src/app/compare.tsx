import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { colors, fonts, radius, status, type } from '@/theme';
import { ASSESSMENT_V2 } from '@/config/featureFlags';
import { baselineRemote, runAssessmentStream } from '@/assessment/client';
import type { AssessmentState, StepOutcome } from '@/assessment/state';
import { measuredView } from '@/assessment/measured';
import { toEngineInputs } from '@/decision/rules';
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
  const setV2Run = useSessionStore((state) => state.setV2Run);
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
      const base64 = session.imageBase64;
      const measured = measuredView(session);
      const boundary = session.boundary;
      if (!base64 || !boundary) {
        setError('Approve the wound outline first — the grounded arm only runs on an approved outline.');
        setRunning(false);
        return;
      }

      // Both arms run against the same photo, at the same time.
      const [baselineResult, groundedResult] = await Promise.all([
        // Goes through the shared client so it honours EXPO_PUBLIC_API_BASE —
        // a bare relative fetch works on web and fails on native.
        baselineRemote(base64),
        runAssessmentStream(
          {
            base64,
            // The same inputs as the main result — the approved outline's
            // measurement and the confirmed tissue — so the grounded arm is the
            // assessment the clinician saw, not a re-segmented variant of it.
            inputs: toEngineInputs(session),
            pxPerCm: measured?.pxPerCm ?? null,
            areaCm2: measured?.areaCm2 ?? null,
            mask: boundary.maskUrl,
            approvalId: boundary.approvalId,
          },
          (step) => setSteps((prev) => [...prev, step]),
        ),
      ]);

      setBaseline(baselineResult);
      setGrounded(groundedResult);

      // Persist onto the session so the run — including the AI-composed report —
      // survives navigation and reaches the exported report.
      setV2Run(
        groundedResult as unknown as Record<string, unknown> | null,
        baselineResult?.text
          ? { text: baselineResult.text, model: baselineResult.model, latencyMs: baselineResult.latencyMs }
          : null,
      );

      if (!groundedResult) {
        setError('The MendWise pipeline is not available here. Check that assessmentV2 is on and the API is reachable.');
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Comparison failed.');
    } finally {
      setRunning(false);
    }
  }, [session, setV2Run]);

  const result = grounded?.result;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={5} title="What grounding changes" />

        {!ASSESSMENT_V2 ? (
          <Text style={styles.warning}>
            This comparison needs the V2 pipeline. Set EXPO_PUBLIC_ASSESSMENT_V2=true and rebuild.
          </Text>
        ) : null}

        <PrimaryButton
          label={running ? 'Running both…' : 'Run both on this photo'}
          disabled={!session.imageUri}
          loading={running}
          onPress={run}
        />

        {running ? (
          <View style={styles.steps}>
            <ActivityIndicator color={colors.primary} />
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

        {grounded?.report ? (
          <View style={styles.column}>
            <Text style={styles.columnTitle}>
              Report written from the decided facts
              {grounded.report.source === 'template' ? ' (standard template — the model was unavailable)' : ''}
            </Text>
            <Text style={styles.prose}>{grounded.report.patientSummary}</Text>
            <Text style={styles.meta}>
              Saved with your report. {grounded.report.model ? `Written by ${grounded.report.model}, ` : ''}
              checked against the engine result before being shown.
            </Text>
          </View>
        ) : null}

        <Text style={styles.footnote}>
          Both columns saw the same photograph. The difference is not fluency — it is that the right-hand column can be
          checked, repeated and audited, and the left-hand one cannot.
        </Text>
      </ScrollView>

      <View style={styles.footer}>
        {grounded ? (
          <Text style={styles.savedNote}>
            This run is saved with your assessment — use “Save report” on the result screen to export it.
          </Text>
        ) : null}
        <PrimaryButton label="Back to result" variant="secondary" onPress={() => router.back()} />
        <DisclaimerFooter />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfacePage },
  content: { padding: 20, gap: 14 },
  column: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  groundedColumn: { borderColor: colors.primary, borderWidth: 2 },
  columnTitle: { ...type.headingSm, fontSize: 15, fontFamily: fonts.bodyBold, color: colors.textPrimary },
  prose: { ...type.bodyMd, lineHeight: 21, color: colors.textPrimary },
  fact: { ...type.bodyMd, lineHeight: 21, fontFamily: fonts.bodySemiBold, color: colors.textPrimary },
  meta: { ...type.data, fontSize: 12, color: colors.textSecondary },
  steps: { gap: 4, paddingVertical: 8 },
  step: { ...type.bodySm, color: colors.textSecondary },
  warning: { ...type.bodySm, color: status.warning.fg },
  error: { ...type.bodySm, color: status.risk.fg },
  footnote: { ...type.bodySm, lineHeight: 20, color: colors.textSecondary, marginTop: 4 },
  savedNote: { ...type.caption, letterSpacing: 0, lineHeight: 18, color: colors.textSecondary, textAlign: 'center' },
  footer: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
});
