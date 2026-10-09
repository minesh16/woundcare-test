import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { MeasurementCard } from '@/components/MeasurementCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { WaitingNotice } from '@/components/WaitingNotice';
import { ResultPanel } from '@/components/ResultPanel';
import { TissueConfirmCard } from '@/components/TissueConfirmCard';
import { ASSESSMENT_V2 } from '@/config/featureFlags';
import { BODY_ZONE_LABELS } from '@/constants/bodyZones';
import { renderTemplateReport } from '@/assessment/reportTemplate';
import { measuredView } from '@/assessment/measured';
import { assess } from '@/decision/rules';
import { evaluate, reconcileTissue } from '@/decision/engine';
import { toEngineInputs } from '@/decision/rules';
import { colors, radius, type } from '@/theme';
import { logTissueConfirmationRemote, runAssessmentStream } from '@/assessment/client';
import type { ReportPair, StepOutcome } from '@/assessment/state';
import type { ClinicianTissueChoice, EngineResult, TissueType } from '@/decision/engine.types';
import { useSessionStore } from '@/store/sessionStore';

/** The engine's tissue type, as one of the four choices offered to the clinician. */
function toChoice(tissue: TissueType | null): ClinicianTissueChoice | null {
  if (tissue === null) return null;
  return tissue === 'necrotic_ischaemic' ? 'necrotic' : tissue;
}

/**
 * The result screen, in three states (assessmentV2, approved + measured outline):
 *
 *   check     what was measured (outline + the coin the scale came from) and the
 *             tissue confirmation (spec §4.3). No pathway is shown yet.
 *   deciding  the server pipeline runs over the approved outline: tissue, the
 *             caged image review, the engine, the report, the audit row.
 *   decided   the SERVER's engine result is rendered — the same one the audit
 *             row records. The screen used to render an on-device result built
 *             from the HSV mask alongside a server report built from the
 *             approved outline, and the two disagreed (77% vs 17% slough).
 *
 * Only if the server cannot be reached does the on-device engine decide, over
 * the same measured inputs, and the screen says so.
 *
 * With assessmentV2 off, the on-device result is shown immediately, as before.
 */
export default function ResultScreen() {
  const session = useSessionStore((state) => state.session);
  const saveCurrentReport = useSessionStore((state) => state.saveCurrentReport);
  const resetSession = useSessionStore((state) => state.resetSession);
  const setV2Run = useSessionStore((state) => state.setV2Run);
  const setScaleRejected = useSessionStore((state) => state.setScaleRejected);
  const setTissueConfirmation = useSessionStore((state) => state.setTissueConfirmation);

  const view = measuredView(session);
  const needsConfirmation = ASSESSMENT_V2 && session.boundary !== null && session.measurement !== null;
  const confirmed = session.tissueConfirmation !== null;

  const autoTissue = useMemo(() => {
    if (!view) return null;
    const { tissueType } = reconcileTissue(
      {
        necrosis: view.necrosisPercent,
        slough: view.sloughPercent,
        granulation: view.granulationPercent,
        epithelial: view.epithelialPercent,
        other: view.otherPercent,
      },
      toEngineInputs(session).perfusion,
    );
    return toChoice(tissueType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.measurement, session.cv, session.answers.perfusion]);

  const [choice, setChoice] = useState<ClinicianTissueChoice | null>(session.tissueConfirmation?.final ?? null);
  const selectedTissue = choice ?? autoTissue;

  const [steps, setSteps] = useState<StepOutcome[]>([]);
  const [running, setRunning] = useState(false);
  const [decision, setDecision] = useState<EngineResult | null>(null);
  const [serverFailed, setServerFailed] = useState(false);
  const [report, setReport] = useState<ReportPair | null>(null);
  const started = useRef(false);

  const confirmTissue = () => {
    if (!selectedTissue) return;
    setTissueConfirmation({ auto: autoTissue, final: selectedTissue, confirmedAt: new Date().toISOString() });
    // Joins the approval's correction row as `tissue_override` (spec §4.1/§4.3).
    if (session.correctionId) {
      void logTissueConfirmationRemote({
        correctionId: session.correctionId,
        tissueAuto: autoTissue,
        tissueFinal: selectedTissue,
        woundLocation: session.bodyZone,
        monkTone: session.answers.monkTone ?? null,
      });
    }
  };

  /**
   * Run the server pipeline over the boundary the clinician approved, once the
   * tissue is confirmed. `approvedBoundary` makes the server skip segmentation,
   * so tissue is measured inside exactly the mask a human signed off; the
   * engine inputs carry the confirmed tissue and the coin scale.
   */
  useEffect(() => {
    if (!ASSESSMENT_V2 || started.current) return;
    const boundary = session.boundary;
    if (!boundary || !session.imageBase64) return;
    if (needsConfirmation && !confirmed) return;
    started.current = true;

    let cancelled = false;
    (async () => {
      setRunning(true);
      let decided = false;
      try {
        const measured = measuredView(session);
        // The same bytes and mask the approval was bound to; anything else is a 403.
        const final = await runAssessmentStream(
          {
            base64: session.imageBase64!,
            mask: boundary.maskUrl,
            approvalId: boundary.approvalId,
            inputs: toEngineInputs(session),
            pxPerCm: measured?.pxPerCm ?? null,
            areaCm2: measured?.areaCm2 ?? null,
            bodyZoneLabel: session.bodyZone ? BODY_ZONE_LABELS[session.bodyZone] : null,
          },
          (step) => {
            if (!cancelled) setSteps((prior) => [...prior, step]);
          },
          ({ result }) => {
            decided = true;
            if (!cancelled) setDecision(result);
          },
        );
        if (cancelled) return;
        if (final?.result && !decided) {
          decided = true;
          setDecision(final.result);
        }
        if (final) {
          setV2Run(final as unknown as Record<string, unknown>, null);
          setReport(final.report ?? null);
        }
        if (!decided) setServerFailed(true);
      } catch {
        if (!cancelled && !decided) setServerFailed(true);
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, needsConfirmation, confirmed, setV2Run]);

  const checking = needsConfirmation && !confirmed;
  const awaitingDecision =
    ASSESSMENT_V2 && session.boundary !== null && !checking && decision === null && !serverFailed;

  // The server's decision when there is one; otherwise the same engine, here,
  // over the same measured inputs.
  const result = useMemo(
    () => assess(session, decision),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.answers, session.bodyZone, session.cv, session.measurement, session.tissueConfirmation, decision],
  );

  // The full engine result (not just the UI-facing subset) drives the export.
  const engineResult = useMemo(
    () => decision ?? evaluate(toEngineInputs(session)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.answers, session.bodyZone, session.cv, session.measurement, session.tissueConfirmation, decision],
  );

  const aiReport =
    report ?? (session.v2 as { report?: { patientSummary: string; source: string } } | null)?.report ?? null;

  const saveReport = async () => {
    saveCurrentReport(result);
    // Export carries both documents: the clinician-facing record and the plain
    // -English summary, rendered deterministically so a saved report never
    // depends on a model being reachable.
    const documents = engineResult
      ? renderTemplateReport({
          result: engineResult,
          areaCm2: view?.areaCm2 ?? null,
          bodyZoneLabel: session.bodyZone ? BODY_ZONE_LABELS[session.bodyZone] : null,
          tissuePct: view
            ? {
                granulation: view.granulationPercent,
                slough: view.sloughPercent,
                necrosis: view.necrosisPercent,
                epithelial: view.epithelialPercent,
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

  const measurementCard =
    session.measurement && view && session.imageUri ? (
      <MeasurementCard
        imageUri={session.imageUri}
        outline={session.boundary?.outline ?? null}
        measurement={session.measurement}
        view={view}
        onRejectScale={setScaleRejected}
        locked={!checking}
      />
    ) : null;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={5} title={checking ? 'Check before the result' : 'Your result'} />

        {checking && view ? (
          <>
            {measurementCard}
            <TissueConfirmCard view={view} auto={autoTissue} selected={selectedTissue} onSelect={setChoice} />
          </>
        ) : awaitingDecision ? (
          <View style={styles.runCard}>
            <WaitingNotice
              message="Working out the result"
              slowHint="The server can take longer when it has been idle. Please keep this screen open."
            />
            {steps.map((step, index) => (
              <Text key={`${step.step}-${index}`} style={styles.runStep}>
                {step.status === 'ok' ? '✓' : '·'} {step.summary}
              </Text>
            ))}
            <Text style={styles.runNote}>
              Checking the photo for signs of infection, then applying the wound care guide to what was
              measured inside your outline.
            </Text>
          </View>
        ) : (
          <>
            <ResultPanel result={result} />

            {serverFailed ? (
              <Text style={styles.boundaryNote}>
                The server could not be reached, so this result was worked out on this device from the same
                measurements. It has no image review and was not recorded.
              </Text>
            ) : null}

            {running ? (
              <View style={styles.runCard}>
                <WaitingNotice message="Writing the summary" />
                <Text style={styles.runNote}>
                  The result above is final. This step adds the written summary and records the assessment.
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
                {session.tissueConfirmation
                  ? session.tissueConfirmation.final === session.tissueConfirmation.auto
                    ? ' You confirmed the tissue type.'
                    : ' You changed the tissue type.'
                  : ''}
              </Text>
            ) : null}

            {measurementCard}

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
          </>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {checking ? (
          <PrimaryButton
            label="Confirm and see the result"
            disabled={!selectedTissue}
            onPress={confirmTissue}
          />
        ) : awaitingDecision ? null : (
          <>
            <PrimaryButton label="Save report" onPress={saveReport} />
            {ASSESSMENT_V2 ? (
              <PrimaryButton
                label="Compare with an ungrounded AI answer"
                variant="secondary"
                onPress={() => router.push('/compare')}
              />
            ) : null}
            <PrimaryButton label="Start new scan" onPress={startNewScan} variant="secondary" />
          </>
        )}
        <DisclaimerFooter />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surfacePage,
  },
  runCard: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  runStep: {
    ...type.bodyMd,
    color: colors.textPrimary,
  },
  runNote: {
    ...type.bodySm,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  boundaryNote: {
    ...type.bodySm,
    color: colors.textSecondary,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  aiCard: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  aiLabel: {
    ...type.caption,
    color: colors.textSecondary,
  },
  aiBody: {
    ...type.bodyLg,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textPrimary,
  },
  aiMeta: {
    ...type.data,
    fontSize: 12,
    color: colors.textSecondary,
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
  },
});
