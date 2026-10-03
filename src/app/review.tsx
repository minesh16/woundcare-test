import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  approveRemote,
  measureRemote,
  rasteriseBoundaryRemote,
  segmentRemote,
  type PromptBox,
  type PromptPoint,
} from '@/assessment/client';
import { toBoundaryProposal } from '@/assessment/proposal';
import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { MaskEditor, type EditorPoint } from '@/components/MaskEditor';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { PromptCanvas, SECOND_OPINION_COLOUR, type PromptMode } from '@/components/PromptCanvas';
import { AppColors } from '@/constants/appTheme';
import type { BoundaryProposal } from '@/decision/types';
import { useSessionStore } from '@/store/sessionStore';

/**
 * Review step — the clinician decides where the wound is (segmentation spec §3.3).
 *
 * Nothing is measured until this screen approves an outline. Ways to get there:
 *
 *   Prompt   tap "this is wound" / "this is not wound", or draw a box; SAM 3 is
 *            asked again with every prompt so far (debounced 400 ms)
 *   Adjust   drag the outline's points (Edit outline mode)
 *   Draw     reject the model and outline the wound from scratch
 *   Approve  the shown outline is right
 *
 * Approval goes to POST /approve, which binds it to this image and this mask and
 * writes the correction log; then POST /measure measures inside it. Only then
 * does the flow move on — the API refuses to measure anything unapproved.
 */

type Screen = 'review' | 'edit';
type Intent = 'adjusted' | 'drawn';

const SOURCE_LABEL: Record<string, string> = {
  sam3: 'SAM 3 (general model, prompted for a wound)',
  fusegnet: 'FUSegNet (wound-specific model)',
  hsv: 'Colour estimate — no model answered',
};

export default function ReviewScreen() {
  const session = useSessionStore((state) => state.session);
  const clinicianId = useSessionStore((state) => state.clinicianId);
  const setBoundaryProposal = useSessionStore((state) => state.setBoundaryProposal);
  const setBoundary = useSessionStore((state) => state.setBoundary);
  const setMeasurement = useSessionStore((state) => state.setMeasurement);
  const setCorrectionId = useSessionStore((state) => state.setCorrectionId);

  const proposal = session.boundaryProposal;
  // The first proposal, for "Reset to AI".
  const original = useRef<BoundaryProposal | null>(proposal);

  const [screen, setScreen] = useState<Screen>('review');
  const [intent, setIntent] = useState<Intent>('adjusted');
  const [points, setPoints] = useState<EditorPoint[]>([]);
  const [mode, setMode] = useState<PromptMode>(null);
  const [prompts, setPrompts] = useState<{ points: PromptPoint[]; box: PromptBox | null }>({ points: [], box: null });
  const [segmenting, setSegmenting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // For the correction log (spec §4.1).
  const openedAt = useRef(Date.now());
  const edits = useRef(0);
  const taps = useRef(0);
  const boxUsed = useRef(false);
  const requestSeq = useRef(0);

  const opinion = proposal?.secondOpinion?.status === 'ok' ? proposal.secondOpinion : null;
  const modelsDisagree = Boolean(opinion) && proposal?.confidence !== 'high';

  // Low agreement between the two models: ask for a tap (spec §6.4).
  useEffect(() => {
    if (opinion && proposal?.confidence === 'low' && prompts.points.length === 0) setMode('include');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal?.confidence]);

  // Re-ask SAM 3 with every prompt so far, debounced 400 ms (spec §3.3).
  useEffect(() => {
    if (prompts.points.length === 0 && !prompts.box) return;
    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      if (!session.imageBase64) return;
      setSegmenting(true);
      setError(null);
      const result = await segmentRemote({
        base64: session.imageBase64,
        prompts: { points: prompts.points, box: prompts.box },
        bodyZone: session.bodyZone,
        assessmentId: session.id,
      });
      // A newer prompt has superseded this answer.
      if (seq !== requestSeq.current) return;
      setSegmenting(false);
      if (!result.ok) {
        setError(`Could not update the outline: ${result.error}`);
        return;
      }
      setBoundaryProposal(toBoundaryProposal(result.data));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompts]);

  if (!session.imageUri || !session.imageBase64) {
    router.replace('/capture');
    return null;
  }

  const addTap = (point: PromptPoint) => {
    taps.current += 1;
    setPrompts((p) => ({ ...p, points: [...p.points, point] }));
  };
  const setBox = (box: PromptBox) => {
    boxUsed.current = true;
    setPrompts((p) => ({ ...p, box }));
    setMode(null);
  };
  const undoPrompt = () =>
    setPrompts((p) => (p.box && p.points.length === 0 ? { ...p, box: null } : { ...p, points: p.points.slice(0, -1) }));
  const resetToAi = () => {
    requestSeq.current += 1; // drop any answer in flight
    setSegmenting(false);
    setPrompts({ points: [], box: null });
    setMode(null);
    if (original.current) setBoundaryProposal(original.current);
  };

  /**
   * Approve a mask, then measure inside it. The API binds the approval to this
   * image and mask; /measure refuses anything else. If either step fails we stay
   * here — moving on would mean deciding on numbers from an unapproved boundary.
   */
  const commit = async (args: {
    maskUrl: string;
    approval: 'approved' | 'adjusted' | 'drawn';
    provider: 'sam3' | 'fusegnet' | 'hsv' | null;
    model: string | null;
    outline: EditorPoint[] | null;
    areaPx: number | null;
    areaPct: number | null;
  }) => {
    setBusy(true);
    setError(null);
    setStatus('Saving your approval…');
    const approved = await approveRemote({
      base64: session.imageBase64!,
      assessmentId: session.id,
      approval: args.approval,
      finalMask: args.maskUrl,
      aiMask: proposal?.maskUrl ?? null,
      clinicianId,
      provider: args.provider,
      model: args.model,
      confidence: proposal?.confidence ?? null,
      score: proposal?.score ?? null,
      edits: edits.current,
      taps: taps.current,
      boxUsed: boxUsed.current,
      msToApprove: Date.now() - openedAt.current,
      imageSource: session.imageSource,
      bodyZone: session.bodyZone,
      secondOpinion: proposal?.secondOpinion
        ? proposal.secondOpinion.status === 'ok'
          ? {
              status: 'ok',
              agreement_iou: proposal.secondOpinion.agreementIoU,
              regions: proposal.secondOpinion.regions,
              mean_prob: proposal.secondOpinion.meanProb,
              latency_ms: proposal.secondOpinion.latencyMs,
            }
          : { status: 'unavailable' }
        : null,
    });
    if (!approved.ok) {
      setBusy(false);
      setStatus(null);
      setError(`${approved.error} Your outline is kept — try again.`);
      return;
    }

    setStatus('Measuring inside the outline…');
    const measured = await measureRemote({
      base64: session.imageBase64!,
      mask: args.maskUrl,
      approvalId: approved.data.approval_id,
      includeCoinReference: session.includeCoinReference,
    });
    if (!measured.ok) {
      setBusy(false);
      setStatus(null);
      setError(`${measured.error} Your outline is kept — try again.`);
      return;
    }

    setBoundary({
      maskUrl: args.maskUrl,
      approval: args.approval,
      provider: args.provider === 'hsv' ? null : args.provider,
      model: args.model,
      outline: args.outline,
      areaPx: args.areaPx,
      areaPct: args.areaPct,
      reviewedAt: new Date().toISOString(),
      approvalId: approved.data.approval_id,
    });
    const { tissue, measurement } = measured.data;
    setMeasurement({
      granulationPercent: tissue.granulation,
      sloughPercent: tissue.slough,
      necrosisPercent: tissue.necrotic,
      epithelialPercent: tissue.epithelial,
      otherPercent: tissue.other,
      maskAreaPx: tissue.maskAreaPx,
      maskProvider: tissue.maskProvider ?? null,
      periwound: tissue.periwound,
      frame: measurement.frame,
      scale: measurement.scale,
      scaleReason: measurement.scaleReason ?? null,
      scaleRejected: false,
      geometry: measurement.geometry,
      whiteBalance: measurement.whiteBalance,
      measuredAt: new Date().toISOString(),
    });
    setCorrectionId(approved.data.correction_id);
    setBusy(false);
    setStatus(null);
    router.push('/questions');
  };

  const approveShown = () => {
    if (!proposal?.maskUrl) return;
    void commit({
      maskUrl: proposal.maskUrl,
      approval: 'approved',
      provider: proposal.source,
      model: proposal.model,
      outline: proposal.outline,
      areaPx: proposal.areaPx,
      areaPct: proposal.areaPct,
    });
  };

  const approveSecondOpinion = () => {
    if (!opinion) return;
    void commit({
      maskUrl: opinion.maskUrl,
      approval: 'approved',
      provider: 'fusegnet',
      model: opinion.model,
      outline: opinion.outline,
      areaPx: null,
      areaPct: null,
    });
  };

  const startEdit = (next: Intent) => {
    setIntent(next);
    // Adjusting starts from the shown outline; drawing starts from nothing —
    // seeding "draw" with the model's points would make rejection cosmetic.
    setPoints(next === 'adjusted' && proposal?.outline ? proposal.outline : []);
    setError(null);
    setWarning(null);
    setScreen('edit');
  };

  const saveEdited = async () => {
    setBusy(true);
    setError(null);
    // Rasterise at the photo's own proportions (1024 on the longer edge), so a
    // portrait photo does not lose vertical resolution in the mask.
    const frame = proposal?.frame;
    const scale = frame ? 1024 / Math.max(frame.width, frame.height) : 1;
    const result = await rasteriseBoundaryRemote({
      polygon: points,
      approval: intent,
      assessmentId: session.id,
      width: frame ? Math.round(frame.width * scale) : undefined,
      height: frame ? Math.round(frame.height * scale) : undefined,
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    if (result.data.plausibility !== 'plausible' && !warning) {
      // Advisory, not a block: the clinician is the authority on this screen.
      setBusy(false);
      setWarning(
        `That outline covers ${result.data.areaPct}% of the photo — ${result.data.plausibilityReason}. Tap Save again to use it anyway, or keep editing.`,
      );
      return;
    }
    await commit({
      maskUrl: result.data.mask,
      approval: intent,
      // A drawn boundary has no model behind it and must not borrow one's attribution.
      provider: intent === 'drawn' ? null : (proposal?.source ?? null),
      model: intent === 'drawn' ? null : (proposal?.model ?? null),
      outline: points,
      areaPx: result.data.areaPx,
      areaPct: result.data.areaPct,
    });
  };

  if (screen === 'edit') {
    return (
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <ProgressHeader step={3} title={intent === 'drawn' ? 'Draw the wound edge' : 'Adjust the wound edge'} />
          <Text style={styles.lead}>
            {intent === 'drawn'
              ? 'Tap around the edge of the wound to outline it.'
              : 'Drag the points so the outline follows the wound edge. Tap to add a point.'}
          </Text>
          <MaskEditor
            imageUri={session.imageUri}
            points={points}
            onChange={(next) => {
              setPoints(next);
              setWarning(null);
            }}
            onEdit={() => {
              edits.current += 1;
            }}
            referenceOutline={intent === 'adjusted' ? (original.current?.outline ?? null) : null}
            resetTo={intent === 'adjusted' ? (original.current?.outline ?? null) : null}
          />
          {intent === 'adjusted' && original.current?.outline ? (
            <Text style={styles.legend}>The dashed line is what the model first suggested.</Text>
          ) : null}
          {warning ? <Text style={styles.warning}>{warning}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {status ? <Text style={styles.legend}>{status}</Text> : null}
        </ScrollView>
        <View style={styles.footer}>
          <PrimaryButton
            label={busy ? status ?? 'Saving…' : warning ? 'Save anyway' : 'Save outline'}
            disabled={points.length < 3 || busy}
            onPress={saveEdited}
          />
          <Pressable onPress={() => setScreen('review')} accessibilityRole="button" disabled={busy}>
            <Text style={styles.link}>Back</Text>
          </Pressable>
          <DisclaimerFooter />
        </View>
      </View>
    );
  }

  const source = proposal?.source ?? null;
  const promptCount = prompts.points.length + (prompts.box ? 1 : 0);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={3} title="Check the wound outline" />

        <Text style={styles.lead}>
          {source === 'hsv'
            ? 'No model could outline the wound, so this is a rough colour estimate. Correct it before anything is measured.'
            : proposal?.maskUrl
              ? 'This is the outline we suggest. Check it before anything is measured.'
              : 'We could not outline the wound. Please draw the edge yourself.'}
        </Text>

        {proposal?.maskUrl ? (
          <View style={styles.chips}>
            <Text style={[styles.chip, styles[`chip_${proposal.confidence}`]]}>Confidence: {proposal.confidence}</Text>
            {source ? <Text style={[styles.chip, styles.chipSource]}>{SOURCE_LABEL[source] ?? source}</Text> : null}
          </View>
        ) : null}

        {modelsDisagree && opinion ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>Two models drew different outlines</Text>
            <Text style={styles.cardBody}>
              Yellow is SAM 3; the dashed orange line is FUSegNet, a wound-specific model (agreement{' '}
              {opinion.agreementIoU != null ? `${Math.round(opinion.agreementIoU * 100)}%` : 'unknown'}).{' '}
              {proposal?.confidence === 'low'
                ? 'Tap on the wound to help, or pick the one that fits.'
                : 'Pick the one that fits, or adjust it.'}
            </Text>
          </View>
        ) : null}

        <PromptCanvas
          imageUri={session.imageUri}
          outline={proposal?.outline ?? null}
          secondOutline={modelsDisagree ? (opinion?.outline ?? null) : null}
          points={prompts.points}
          box={prompts.box}
          mode={mode}
          busy={segmenting}
          onTap={addTap}
          onBox={setBox}
        />

        {proposal?.maskUrl || source === 'hsv' ? (
          <>
            <Text style={styles.legend}>
              {mode === 'include'
                ? 'Tap on parts of the wound the outline missed.'
                : mode === 'exclude'
                  ? 'Tap on parts that are not wound (skin, the coin, the background).'
                  : mode === 'box'
                    ? 'Drag a box around the whole wound.'
                    : 'Use the tools to correct the outline, or approve it.'}
            </Text>
            <View style={styles.modeRow}>
              <ModeButton label="+ Wound" active={mode === 'include'} onPress={() => setMode(mode === 'include' ? null : 'include')} colour="#16A34A" />
              <ModeButton label="− Not wound" active={mode === 'exclude'} onPress={() => setMode(mode === 'exclude' ? null : 'exclude')} colour="#DC2626" />
              <ModeButton label="Box" active={mode === 'box'} onPress={() => setMode(mode === 'box' ? null : 'box')} colour="#2563EB" />
            </View>
            {promptCount > 0 ? (
              <View style={styles.modeRow}>
                <SecondaryButton label="Undo last" onPress={undoPrompt} disabled={busy} />
                <SecondaryButton label="Reset to AI" onPress={resetToAi} disabled={busy} />
              </View>
            ) : null}
            {proposal?.promptConflict ? (
              <Text style={styles.warning}>
                No outline the model could find matches all your taps. Remove a tap, draw a box, or adjust the points.
              </Text>
            ) : null}
            {proposal?.areaPct != null ? (
              <Text style={styles.cardNote}>
                The outline covers {proposal.areaPct}% of the photo. Nothing is measured until you approve it.
              </Text>
            ) : null}
          </>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {status ? <Text style={styles.legend}>{status}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        {proposal?.maskUrl ? (
          <>
            <PrimaryButton
              label={busy ? status ?? 'Saving…' : modelsDisagree ? 'Approve the yellow outline' : 'Approve this outline'}
              disabled={busy || segmenting}
              onPress={approveShown}
            />
            {modelsDisagree && opinion ? (
              <SecondaryButton label="Approve the orange outline (FUSegNet)" onPress={approveSecondOpinion} disabled={busy || segmenting} colour={SECOND_OPINION_COLOUR} />
            ) : null}
            <View style={styles.secondaryRow}>
              <SecondaryButton label="Adjust points" onPress={() => startEdit('adjusted')} disabled={busy || segmenting} />
              <SecondaryButton label="Reject — draw my own" onPress={() => startEdit('drawn')} disabled={busy || segmenting} />
            </View>
          </>
        ) : (
          <PrimaryButton label="Draw the wound edge" disabled={busy} onPress={() => startEdit('drawn')} />
        )}
        <Pressable onPress={() => router.replace('/capture')} accessibilityRole="button" disabled={busy}>
          <Text style={styles.link}>Retake photo</Text>
        </Pressable>
        <DisclaimerFooter />
      </View>
    </View>
  );
}

function ModeButton({ label, active, onPress, colour }: { label: string; active: boolean; onPress: () => void; colour: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.modeButton, { borderColor: colour }, active ? { backgroundColor: colour } : null]}>
      <Text style={[styles.modeButtonText, { color: active ? AppColors.white : colour }]}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  onPress,
  disabled,
  colour = AppColors.teal,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  colour?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={[styles.secondaryButton, { borderColor: disabled ? AppColors.border : colour }]}>
      <Text style={[styles.secondaryButtonText, { color: disabled ? AppColors.border : colour }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: AppColors.background,
  },
  content: {
    padding: 20,
    paddingBottom: 12,
    gap: 14,
  },
  lead: {
    fontSize: 16,
    lineHeight: 23,
    color: AppColors.text,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    fontSize: 13,
    fontWeight: '700',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 999,
    overflow: 'hidden',
  },
  chip_high: {
    backgroundColor: '#DCFCE7',
    color: '#166534',
  },
  chip_medium: {
    backgroundColor: '#FEF3C7',
    color: '#92400E',
  },
  chip_low: {
    backgroundColor: '#FEE2E2',
    color: '#991B1B',
  },
  chipSource: {
    backgroundColor: AppColors.card,
    color: AppColors.textSecondary,
    fontWeight: '600',
  },
  notice: {
    backgroundColor: '#FFF7ED',
    borderRadius: 14,
    padding: 14,
    gap: 6,
    borderWidth: 1,
    borderColor: '#FDBA74',
  },
  noticeTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#9A3412',
  },
  cardBody: {
    fontSize: 15,
    lineHeight: 22,
    color: AppColors.text,
  },
  cardNote: {
    fontSize: 13,
    lineHeight: 19,
    color: AppColors.textSecondary,
  },
  legend: {
    fontSize: 13,
    color: AppColors.textSecondary,
  },
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  modeButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  modeButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  warning: {
    fontSize: 14,
    lineHeight: 21,
    color: AppColors.warning,
    fontWeight: '600',
  },
  error: {
    fontSize: 14,
    color: AppColors.danger,
    fontWeight: '600',
  },
  footer: {
    padding: 20,
    paddingTop: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: AppColors.border,
    backgroundColor: AppColors.white,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryButton: {
    flexGrow: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  link: {
    fontSize: 15,
    fontWeight: '600',
    color: AppColors.teal,
    textAlign: 'center',
  },
});
