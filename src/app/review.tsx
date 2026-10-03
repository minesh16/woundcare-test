import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { MaskEditor, type EditorPoint } from '@/components/MaskEditor';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { rasteriseBoundaryRemote } from '@/assessment/client';
import { AppColors } from '@/constants/appTheme';
import { useSessionStore } from '@/store/sessionStore';
import type { ReviewedBoundary } from '@/decision/types';

/**
 * Review step — the clinician decides where the wound is.
 *
 * This is the human-in-the-loop gate the architecture always claimed and the app
 * did not have. Before it, a model's boundary went straight into the tissue
 * measurement and from there into the dressing pathway, with no one asked. Three
 * outcomes, all recorded in the audit trail:
 *
 *   Approve  the model's outline is correct → used as-is
 *   Adjust   the model was close → edit its outline, seeded with the model's own
 *   Reject   the model was wrong → draw the outline from scratch
 *
 * Nothing here is clinical judgement by the app: the engine still decides the
 * dressing, and this screen only settles which pixels are wound. But that is the
 * input every tissue percentage depends on, so it is the one place where a
 * human's opinion has to outrank the model's.
 *
 * When no model boundary exists (segmentation unavailable, or every provider
 * rejected), there is nothing to approve and the screen offers drawing only —
 * stated plainly rather than presenting an empty outline as a proposal.
 */

type Mode = 'summary' | 'edit';

export default function ReviewScreen() {
  const session = useSessionStore((state) => state.session);
  const setBoundary = useSessionStore((state) => state.setBoundary);

  const proposal = session.boundaryProposal;
  const modelOutline = proposal?.outline ?? null;

  const [mode, setMode] = useState<Mode>('summary');
  const [points, setPoints] = useState<EditorPoint[]>([]);
  const [intent, setIntent] = useState<'adjusted' | 'drawn'>('adjusted');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  if (!session.imageUri) {
    router.replace('/capture');
    return null;
  }

  const commit = (boundary: ReviewedBoundary) => {
    setBoundary(boundary);
    router.push('/location');
  };

  const approve = () => {
    if (!proposal?.maskUrl) return;
    commit({
      maskUrl: proposal.maskUrl,
      approval: 'approved',
      provider: proposal.provider,
      model: proposal.model,
      outline: modelOutline,
      areaPx: proposal.areaPx ?? null,
      areaPct: proposal.areaPct ?? null,
      reviewedAt: new Date().toISOString(),
    });
  };

  const startEdit = (next: 'adjusted' | 'drawn') => {
    setIntent(next);
    // Adjusting starts from the model's outline; drawing starts from nothing.
    // Seeding "draw" with the model's points would make rejection cosmetic.
    setPoints(next === 'adjusted' && modelOutline ? modelOutline : []);
    setError(null);
    setWarning(null);
    setMode('edit');
  };

  const saveEdited = async () => {
    setBusy(true);
    setError(null);
    setWarning(null);
    // The polygon is rasterised server-side so native and web produce an
    // identical mask — Expo-native has no canvas. See api/v1/assessments/mask.ts.
    const result = await rasteriseBoundaryRemote({
      polygon: points,
      approval: intent,
      assessment_id: session.id,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.plausibility !== 'plausible') {
      // Advisory, not a block: the clinician is the authority on this screen.
      // Saving again accepts it.
      if (!warning) {
        setWarning(
          `That outline covers ${result.areaPct}% of the photo — ${result.plausibilityReason}. Tap Save again to use it anyway, or keep editing.`,
        );
        return;
      }
    }

    commit({
      maskUrl: result.mask,
      approval: intent,
      // A drawn boundary has no model behind it and must not borrow the
      // attribution of one.
      provider: intent === 'drawn' ? null : proposal?.provider ?? null,
      model: intent === 'drawn' ? null : proposal?.model ?? null,
      outline: points,
      areaPx: result.areaPx,
      areaPct: result.areaPct,
      reviewedAt: new Date().toISOString(),
    });
  };

  if (mode === 'edit') {
    return (
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <ProgressHeader step={2} title={intent === 'drawn' ? 'Draw the wound edge' : 'Adjust the wound edge'} />
          <Text style={styles.lead}>
            {intent === 'drawn'
              ? 'Tap around the edge of the wound to outline it.'
              : 'Move or add points so the outline follows the wound edge.'}
          </Text>

          <MaskEditor
            imageUri={session.imageUri}
            points={points}
            onChange={(next) => {
              setPoints(next);
              setWarning(null);
            }}
            referenceOutline={intent === 'adjusted' ? modelOutline : null}
          />

          {intent === 'adjusted' && modelOutline ? (
            <Text style={styles.legend}>The dashed line is what the model suggested.</Text>
          ) : null}
          {warning ? <Text style={styles.warning}>{warning}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          <PrimaryButton
            label={busy ? 'Saving…' : warning ? 'Save anyway' : 'Save outline'}
            disabled={points.length < 3 || busy}
            onPress={saveEdited}
          />
          <Pressable onPress={() => setMode('summary')} accessibilityRole="button">
            <Text style={styles.link}>Back</Text>
          </Pressable>
          <DisclaimerFooter />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={2} title="Check the wound outline" />

        <Text style={styles.lead}>
          {proposal?.maskUrl
            ? 'We have outlined what looks like the wound. Please check it before we measure anything.'
            : 'We could not outline the wound automatically. Please draw the edge yourself.'}
        </Text>

        <View style={styles.imageCard}>
          <Image source={{ uri: session.imageUri }} style={styles.image} contentFit="contain" />
          {proposal?.maskUrl ? (
            <Image source={{ uri: proposal.maskUrl }} style={[styles.image, styles.overlay]} contentFit="contain" />
          ) : null}
        </View>

        {proposal?.maskUrl ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>What we found</Text>
            <Text style={styles.cardBody}>
              The outline covers {proposal.areaPct != null ? `${proposal.areaPct}%` : 'part'} of the photo.
            </Text>
            {proposal.multipleRegions ? (
              <Text style={styles.cardBody}>
                We saw more than one separate area. Only the largest is outlined — adjust it if that is wrong.
              </Text>
            ) : null}
            <Text style={styles.cardNote}>
              Nothing is measured until you approve this. Tissue percentages and the dressing
              suggestion are all calculated inside this outline.
            </Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        {busy ? <ActivityIndicator color={AppColors.teal} /> : null}
        {proposal?.maskUrl ? (
          <>
            <PrimaryButton label="Approve this outline" disabled={busy} onPress={approve} />
            <View style={styles.secondaryRow}>
              <SecondaryButton label="Adjust it" onPress={() => startEdit('adjusted')} disabled={busy} />
              <SecondaryButton label="Reject — draw my own" onPress={() => startEdit('drawn')} disabled={busy} />
            </View>
          </>
        ) : (
          <PrimaryButton label="Draw the wound edge" disabled={busy} onPress={() => startEdit('drawn')} />
        )}
        <DisclaimerFooter />
      </View>
    </View>
  );
}

function SecondaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={[styles.secondaryButton, disabled ? styles.secondaryButtonDisabled : null]}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
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
    gap: 16,
  },
  lead: {
    fontSize: 16,
    lineHeight: 23,
    color: AppColors.text,
  },
  imageCard: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: AppColors.navy,
  },
  image: {
    ...StyleSheet.absoluteFill,
  },
  overlay: {
    opacity: 0.4,
  },
  card: {
    backgroundColor: AppColors.card,
    borderRadius: 16,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: AppColors.border,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: AppColors.navy,
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
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: AppColors.border,
    backgroundColor: AppColors.white,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: AppColors.teal,
    alignItems: 'center',
  },
  secondaryButtonDisabled: {
    borderColor: AppColors.border,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: AppColors.teal,
    textAlign: 'center',
  },
  link: {
    fontSize: 15,
    fontWeight: '600',
    color: AppColors.teal,
    textAlign: 'center',
  },
});
