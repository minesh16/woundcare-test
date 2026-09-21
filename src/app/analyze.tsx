import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { analyzeWoundImage } from '@/cv/opencvPipeline';
import { segmentWoundUri, SegmentResult } from '@/cv/segment';
import { formatArea } from '@/cv/measureArea';
import { AppColors } from '@/constants/appTheme';
import { useSessionStore } from '@/store/sessionStore';

export default function AnalyzeScreen() {
  const session = useSessionStore((state) => state.session);
  const setCvResult = useSessionStore((state) => state.setCvResult);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<SegmentResult | null>(null);

  useEffect(() => {
    if (!session.imageUri) {
      router.replace('/capture');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        const result = await analyzeWoundImage(session.imageUri!, session.includeCoinReference);
        if (!cancelled) {
          setCvResult(result);
        }
        // Additive assessmentV2 pass: SAM 2 boundary seeded by the HSV centroid.
        // No-op unless the flag is on and the endpoint is configured.
        const seg = await segmentWoundUri(session.imageUri!, result.hsvCentroid);
        if (!cancelled && seg) {
          setSegment(seg);
        }
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
  }, [session.imageUri, session.includeCoinReference, setCvResult]);

  const cv = session.cv;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={1} title="Image analysis" />

        {session.imageUri ? (
          <Image
            source={{
              uri: cv?.overlayBase64
                ? `data:image/jpeg;base64,${cv.overlayBase64}`
                : session.imageUri,
            }}
            style={styles.image}
            contentFit="cover"
          />
        ) : null}

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={AppColors.teal} size="large" />
            <Text style={styles.loadingText}>Analysing image with OpenCV…</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {cv ? (
          <View style={styles.metricsCard}>
            <Text style={styles.metricTitle}>Demo tissue breakdown</Text>
            <MetricBar label="Granulation" value={cv.granulationPercent} color="#D64545" />
            <MetricBar label="Slough" value={cv.sloughPercent} color="#E8B923" />
            <MetricBar label="Necrosis" value={cv.necrosisPercent} color="#4A3728" />
            <MetricBar label="Epithelial" value={cv.epithelialPercent} color="#F4A9B8" />
            <MetricBar label="Other" value={cv.otherPercent} color="#94A3B8" />

            <Text style={styles.detail}>Area: {formatArea(cv.areaPx2, cv.areaCm2)}</Text>
            {cv.pxPerCm ? (
              <Text style={styles.detail}>Scale: {cv.pxPerCm.toFixed(1)} px/cm (marker calibrated)</Text>
            ) : null}
            <Text style={styles.detail}>Depth: not assessed in this demo (2D photo limitation)</Text>
            <Text style={styles.detail}>
              Engine:{' '}
              {cv.analysisEngine === 'opencv'
                ? Platform.OS === 'web'
                  ? 'OpenCV (server)'
                  : 'OpenCV (native)'
                : 'Fallback (demo)'}
            </Text>
            <Text style={styles.detail}>Confidence: {cv.confidence}</Text>
            {segment?.source === 'sam2' ? (
              <Text style={styles.detail}>
                SAM 2 ({segment.model ?? 'meta/sam-2'}): {segment.masks.length} mask
                {segment.masks.length === 1 ? '' : 's'}
                {segment.selection
                  ? ` — wound mask selected (${segment.selection.areaPx.toLocaleString()} px)`
                  : ' — no wound mask matched centroid'}{' '}
                ({segment.confidence})
              </Text>
            ) : null}
            {session.includeCoinReference ? (
              <Text style={styles.detail}>
                Coin reference: {cv.coinDetected ? 'detected' : 'not detected — area shown as relative'}
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton
          label="Continue to location"
          disabled={!cv || loading}
          onPress={() => router.push('/location')}
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
  image: {
    width: '100%',
    height: 260,
    borderRadius: 16,
    backgroundColor: AppColors.border,
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
