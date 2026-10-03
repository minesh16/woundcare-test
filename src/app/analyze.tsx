import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { ASSESSMENT_V2 } from '@/config/featureFlags';
import { segmentRemote, type SegmentResponse } from '@/assessment/client';
import { analyzeWoundBase64, uriToBase64 } from '@/cv/opencvPipeline';
import { toBoundaryProposal } from '@/assessment/proposal';
import { formatArea } from '@/cv/measureArea';
import { AppColors } from '@/constants/appTheme';
import { TISSUE_CLASS_CLINICAL, TISSUE_CLASS_PLAIN } from '@/copy/plainLanguage';
import { useSessionStore } from '@/store/sessionStore';

/**
 * Names for the boundary backends, shown only behind the "Technical detail"
 * toggle. The default reading experience says "the outline we detected"; which
 * network drew it is a debugging fact, not a clinical one.
 */
const BOUNDARY_SOURCE: Record<NonNullable<SegmentResponse['source']>, string> = {
  sam3: 'general model, prompted for a wound',
  fusegnet: 'wound-specific model',
  hsv: 'colour estimate (no model answered)',
};

export default function AnalyzeScreen() {
  const session = useSessionStore((state) => state.session);
  const setCvResult = useSessionStore((state) => state.setCvResult);
  const setBoundaryProposal = useSessionStore((state) => state.setBoundaryProposal);
  const setImageBase64 = useSessionStore((state) => state.setImageBase64);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<SegmentResponse | null>(null);
  const [technical, setTechnical] = useState(false);

  useEffect(() => {
    if (!session.imageUri) {
      router.replace('/capture');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        // Encode ONCE: every later call sends these exact bytes, and the
        // clinician's approval is bound to their hash.
        const base64 = await uriToBase64(session.imageUri!);
        if (cancelled) return;
        setImageBase64(base64);

        // The colour pass: capture quality gate (and the legacy measurement
        // when assessmentV2 is off).
        const result = await analyzeWoundBase64(base64, session.includeCoinReference);
        if (!cancelled) setCvResult(result);

        if (!ASSESSMENT_V2) return;
        // The draft outline. The location decides whether FUSegNet gives a
        // second opinion (foot wounds). No colour centroid is sent any more:
        // when it was wrong, so was the outline (spec §3.2).
        const seg = await segmentRemote({ base64, bodyZone: session.bodyZone, assessmentId: session.id });
        if (cancelled) return;
        if (!seg.ok) {
          setError(`The outline could not be drafted: ${seg.error}`);
          setBoundaryProposal(null);
          return;
        }
        setSegment(seg.data);
        // On the session, so the review screen can act on it.
        setBoundaryProposal(toBoundaryProposal(seg.data));
      } catch (analysisError) {
        if (!cancelled) {
          setError(analysisError instanceof Error ? analysisError.message : 'Analysis failed.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.imageUri, session.includeCoinReference]);

  const cv = session.cv;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={3} title="Your photo" />

        {session.imageUri ? (
          <View style={styles.imageWrap}>
            <Image
              source={{
                // The HSV contour is the legacy flow's outline. Under assessmentV2
                // it is only a quality gate and can trace the whole limb, so it is
                // not drawn beside the model's proposed wound edge.
                uri:
                  !ASSESSMENT_V2 && cv?.overlayBase64
                    ? `data:image/jpeg;base64,${cv.overlayBase64}`
                    : session.imageUri,
              }}
              style={styles.image}
              contentFit="cover"
            />
            {/* The detected boundary, drawn over the photo. A mask you can see
                is a mask you can sanity-check; a text summary is not. */}
            {segment?.mask ? (
              <Image
                source={{ uri: segment.mask }}
                style={[styles.image, styles.maskOverlay]}
                contentFit="cover"
                accessibilityLabel="Detected wound boundary"
              />
            ) : null}
          </View>
        ) : null}

        {segment?.mask ? (
          <Text style={styles.caption}>
            The green tint shows the wound edge we detected. If it is well off, retake the photo.
          </Text>
        ) : null}

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={AppColors.teal} size="large" />
            <Text style={styles.loadingText}>Looking at your photo…</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {cv ? (
          <View style={styles.metricsCard}>
            {ASSESSMENT_V2 ? (
              // Nothing is measured before the outline is approved (spec §3.3).
              // This screen's colour pass is a quality gate: its mask can cover
              // the whole limb, and skin then reads as slough — so its numbers
              // are not shown as a measurement of the wound.
              <>
                <Text style={styles.metricTitle}>Next: check the outline</Text>
                <Text style={styles.detail}>
                  Tissue and size are measured inside the outline once you have checked it, using the
                  coin for scale.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.metricTitle}>What the wound bed is made of</Text>
                <MetricBar label={TISSUE_CLASS_PLAIN.granulation} value={cv.granulationPercent} color="#D64545" />
                <MetricBar label={TISSUE_CLASS_PLAIN.slough} value={cv.sloughPercent} color="#E8B923" />
                <MetricBar label={TISSUE_CLASS_PLAIN.necrosis} value={cv.necrosisPercent} color="#4A3728" />
                <MetricBar label={TISSUE_CLASS_PLAIN.epithelial} value={cv.epithelialPercent} color="#F4A9B8" />
                <MetricBar label={TISSUE_CLASS_PLAIN.other} value={cv.otherPercent} color="#94A3B8" />

                <Text style={styles.detail}>
                  {cv.areaCm2
                    ? `Size: about ${cv.areaCm2.toFixed(1)} square centimetres.`
                    : 'Size: we could not measure this — there was no size reference in the photo.'}
                </Text>
                {cv.periwound ? (
                  <Text style={styles.detail}>
                    Skin around the wound: {cv.periwound.rednessPct}% looks red
                    {cv.periwound.maceration ? ', and it looks waterlogged' : ''}.
                  </Text>
                ) : null}
                <Text style={styles.detail}>
                  How deep the wound is cannot be judged from a photo, so it is not included here.
                </Text>
              </>
            )}

            <Pressable
              onPress={() => setTechnical((v) => !v)}
              style={styles.toggle}
              accessibilityRole="button"
            >
              <Text style={styles.toggleText}>{technical ? 'Hide technical detail' : 'Technical detail'}</Text>
            </Pressable>

            {technical ? (
              <View style={styles.technicalBlock}>
                {ASSESSMENT_V2 ? (
                  <Text style={styles.detail}>On-device colour pass (quality gate only, not the measurement):</Text>
                ) : null}
                <Text style={styles.detail}>
                  {TISSUE_CLASS_CLINICAL.granulation} {cv.granulationPercent}% ·{' '}
                  {TISSUE_CLASS_CLINICAL.slough} {cv.sloughPercent}% · {TISSUE_CLASS_CLINICAL.necrosis}{' '}
                  {cv.necrosisPercent}% · {TISSUE_CLASS_CLINICAL.epithelial} {cv.epithelialPercent}%
                </Text>
                <Text style={styles.detail}>Area: {formatArea(cv.areaPx2, cv.areaCm2)}</Text>
                {cv.pxPerCm ? (
                  <Text style={styles.detail}>Scale: {cv.pxPerCm.toFixed(1)} px/cm (marker calibrated)</Text>
                ) : null}
                {cv.maskSource ? (
                  <Text style={styles.detail}>
                    Tissue measured inside the {cv.maskSource === 'model' ? 'detected' : 'on-device'} outline
                    {cv.maskAreaPx ? ` (${cv.maskAreaPx.toLocaleString()} px)` : ''}
                  </Text>
                ) : null}
                <Text style={styles.detail}>
                  Engine:{' '}
                  {cv.analysisEngine === 'opencv'
                    ? Platform.OS === 'web'
                      ? 'OpenCV (server)'
                      : 'OpenCV (native)'
                    : 'Fallback (demo)'}
                </Text>
                <Text style={styles.detail}>Confidence: {cv.confidence}</Text>
                {segment?.source ? (
                  <Text style={styles.detail}>
                    Outline: {BOUNDARY_SOURCE[segment.source]} ({segment.model ?? segment.source}) —{' '}
                    {segment.candidates} candidate{segment.candidates === 1 ? '' : 's'}
                    {segment.score != null ? `, score ${segment.score.toFixed(2)}` : ''} ({segment.confidence})
                    {segment.secondOpinion?.status === 'ok'
                      ? ` · FUSegNet agreement IoU ${segment.secondOpinion.agreementIoU ?? '—'}`
                      : segment.secondOpinion?.status === 'unavailable'
                        ? ' · FUSegNet unavailable'
                        : ''}
                  </Text>
                ) : null}
                {segment?.attempts?.some((attempt) => attempt.status !== 'ok') ? (
                  // A boundary from the second or third fallback is a different
                  // result from the same photo, so the fallback is shown rather
                  // than hidden behind an identical-looking outline.
                  <Text style={styles.detail}>
                    Fell back from:{' '}
                    {segment.attempts
                      .filter((attempt) => attempt.status !== 'ok')
                      .map((attempt) => `${attempt.provider} (${attempt.status})`)
                      .join(', ')}
                  </Text>
                ) : null}
                {session.includeCoinReference ? (
                  <Text style={styles.detail}>
                    Coin reference: {cv.coinDetected ? 'detected' : 'not detected — area shown as relative'}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton
          label={ASSESSMENT_V2 ? 'Check the outline' : 'Continue to questions'}
          disabled={!cv || loading}
          // With assessmentV2 on, the boundary goes to a clinician before anything
          // is measured inside it. With it off, the old route is unchanged —
          // additive, never destructive.
          onPress={() => router.push(ASSESSMENT_V2 ? '/review' : '/questions')}
        />
        <DisclaimerFooter />
      </View>
    </View>
  );
}

function MetricBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricTrack}>
        <View style={[styles.metricFill, { width: `${value}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.metricValue}>{value}%</Text>
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
  imageWrap: {
    width: '100%',
    height: 260,
  },
  image: {
    width: '100%',
    height: 260,
    borderRadius: 16,
    backgroundColor: AppColors.border,
  },
  maskOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    opacity: 0.35,
    tintColor: '#10B981',
  },
  caption: {
    fontSize: 13,
    lineHeight: 19,
    color: AppColors.textSecondary,
  },
  toggle: {
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: AppColors.border,
  },
  toggleText: {
    fontSize: 14,
    fontWeight: '600',
    color: AppColors.textSecondary,
  },
  technicalBlock: {
    marginTop: 8,
    gap: 4,
  },
  loadingBox: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  loadingText: {
    color: AppColors.textSecondary,
  },
  error: {
    color: AppColors.danger,
  },
  metricsCard: {
    backgroundColor: AppColors.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    gap: 10,
  },
  metricTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: AppColors.navy,
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  metricLabel: {
    width: 90,
    fontSize: 13,
    color: AppColors.textSecondary,
  },
  metricTrack: {
    flex: 1,
    height: 8,
    backgroundColor: AppColors.border,
    borderRadius: 999,
    overflow: 'hidden',
  },
  metricFill: {
    height: '100%',
    borderRadius: 999,
  },
  metricValue: {
    width: 36,
    textAlign: 'right',
    fontWeight: '700',
    color: AppColors.text,
  },
  detail: {
    fontSize: 14,
    color: AppColors.textSecondary,
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
  },
});
