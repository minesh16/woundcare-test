import { Image } from 'expo-image';
import { useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Polygon, Rect } from 'react-native-svg';

import type { MeasuredView } from '@/assessment/measured';
import type { WoundMeasurement } from '@/decision/types';
import { clinicalColors, colors, fonts, radius, type } from '@/theme';

/**
 * What was measured, drawn on the photo: the approved outline, and the coin the
 * scale came from.
 *
 * The coin is circled because a scale nobody can see is a scale nobody can catch
 * being wrong — and a wrong scale is worse than none (it does not withhold the
 * pathway; it states a confident, wrong size). "Not the coin" drops the scale and
 * everything sized with it.
 */
export function MeasurementCard({
  imageUri,
  outline,
  measurement,
  view,
  onRejectScale,
  locked,
}: {
  imageUri: string;
  outline: { x: number; y: number }[] | null;
  measurement: WoundMeasurement;
  view: MeasuredView;
  onRejectScale: (rejected: boolean) => void;
  /** True once the result is computed — the scale can no longer change under it. */
  locked: boolean;
}) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const { width: fw, height: fh } = measurement.frame;
  const coin = measurement.scale;

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox({ width, height });
  };

  const size =
    view.areaCm2 != null
      ? `About ${view.areaCm2.toFixed(1)} cm²` +
        (view.lengthCm != null && view.widthCm != null
          ? ` — ${view.lengthCm.toFixed(1)} cm long, ${view.widthCm.toFixed(1)} cm wide`
          : '') +
        '.'
      : 'Size not measured — there is no size reference.';

  return (
    <View style={styles.card}>
      <Text style={styles.label}>What was measured</Text>
      <View style={[styles.photo, { aspectRatio: fw / fh }]} onLayout={onLayout}>
        <Image source={{ uri: imageUri }} style={StyleSheet.absoluteFill} contentFit="fill" />
        {box.width > 0 ? (
          <Svg
            width={box.width}
            height={box.height}
            viewBox={`0 0 ${fw} ${fh}`}
            style={StyleSheet.absoluteFill}
            pointerEvents="none">
            {outline && outline.length >= 3 ? (
              <Polygon
                points={outline.map((p) => `${p.x * fw},${p.y * fh}`).join(' ')}
                fill="rgba(0, 150, 150, 0.18)"
                stroke={clinicalColors.woundEdge}
                // In viewBox (analysis-frame) units, so scale to 3 screen px — a bare 3
                // shrinks to ~1 px on a phone and the edge vanishes against the wound.
                strokeWidth={(3 * fw) / box.width}
              />
            ) : null}
            {measurement.whiteBalance?.applied ? (
              <Rect
                x={measurement.whiteBalance.patch.xPct * fw}
                y={measurement.whiteBalance.patch.yPct * fh}
                width={measurement.whiteBalance.patch.wPct * fw}
                height={measurement.whiteBalance.patch.hPct * fh}
                fill="none"
                stroke="#A855F7"
                strokeWidth={4}
              />
            ) : null}
            {coin && !measurement.scaleRejected ? (
              <Circle
                cx={coin.xPct * fw}
                cy={coin.yPct * fh}
                r={coin.rPct * fw}
                fill="none"
                stroke="#2563EB"
                strokeWidth={4}
              />
            ) : null}
          </Svg>
        ) : null}
      </View>

      <Text style={styles.body}>{size}</Text>
      {coin ? (
        measurement.scaleRejected ? (
          <Text style={styles.note}>You said the circled object is not the coin, so no size is given.</Text>
        ) : (
          <Text style={styles.note}>
            Scale from the coin circled in blue (20c, 28.5 mm). The yellow outline is the wound edge you approved.
          </Text>
        )
      ) : (
        <Text style={styles.note}>{measurement.scaleReason ?? 'No coin found beside the wound.'}</Text>
      )}
      <Text style={styles.note}>
        {measurement.whiteBalance?.applied
          ? 'Colours corrected using the white card (outlined in purple).'
          : 'Colours not corrected — no white reference card in the photo, so tissue confidence is capped at medium.'}
      </Text>
      {coin && !locked ? (
        <Pressable onPress={() => onRejectScale(!measurement.scaleRejected)} accessibilityRole="button">
          <Text style={styles.link}>
            {measurement.scaleRejected ? 'Use the circled coin after all' : 'That is not the coin — ignore it'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    ...type.caption,
    color: colors.textSecondary,
  },
  photo: {
    width: '100%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surfaceInverse,
  },
  body: {
    ...type.bodyLg,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textPrimary,
  },
  note: {
    ...type.bodySm,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  link: {
    ...type.bodyMd,
    fontFamily: fonts.bodySemiBold,
    color: colors.link,
  },
});
