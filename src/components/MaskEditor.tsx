import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Polygon, Polyline } from 'react-native-svg';

import { AppColors } from '@/constants/appTheme';

/**
 * Editable wound outline over the photo.
 *
 * Points are kept in FRACTIONAL image coordinates (0–1) throughout, never
 * pixels. The display size, the photo's real size and the size the mask is
 * finally rasterised at are all different, and a fractional polygon is the only
 * representation that is correct in all three.
 *
 * Interaction is tap-based rather than drag-based, deliberately:
 *  - tap the photo        → add a point (or move the selected one)
 *  - tap a point          → select it; tap it again to deselect
 *  - Undo / Clear         → buttons, not gestures
 *
 * Dragging is the more natural gesture, but pan handling differs between
 * Expo-web and native and a half-working drag on one platform is worse than a
 * tap that behaves identically on both. `onPress` gives `locationX/locationY`
 * relative to the pressed view everywhere. Freehand drawing is the obvious
 * follow-up once this is clinically validated.
 */

export type EditorPoint = { x: number; y: number };

type MaskEditorProps = {
  imageUri: string;
  points: EditorPoint[];
  onChange: (points: EditorPoint[]) => void;
  /** The model's original outline, drawn faintly for comparison while adjusting. */
  referenceOutline?: EditorPoint[] | null;
};

/** Hit radius for selecting an existing point, in fractional units. */
const HIT_RADIUS = 0.04;

export function MaskEditor({ imageUri, points, onChange, referenceOutline }: MaskEditorProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState<number | null>(null);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);

  const handlePress = useCallback(
    (locationX: number, locationY: number) => {
      if (size.width <= 0 || size.height <= 0) return;
      const point = {
        // Clamp: a tap on the very edge must not produce an out-of-range point,
        // which the server would reject for the whole polygon.
        x: Math.min(1, Math.max(0, locationX / size.width)),
        y: Math.min(1, Math.max(0, locationY / size.height)),
      };

      // Tapping near an existing point selects it rather than adding a new one
      // on top of it; tapping elsewhere with one selected moves it there.
      const hitIndex = points.findIndex(
        (p) => Math.hypot(p.x - point.x, p.y - point.y) < HIT_RADIUS,
      );

      if (selected !== null) {
        if (hitIndex === selected) {
          setSelected(null);
          return;
        }
        const next = [...points];
        next[selected] = point;
        onChange(next);
        setSelected(null);
        return;
      }

      if (hitIndex !== -1) {
        setSelected(hitIndex);
        return;
      }

      onChange([...points, point]);
    },
    [onChange, points, selected, size.height, size.width],
  );

  const toPixels = (p: EditorPoint) => `${p.x * size.width},${p.y * size.height}`;
  const closed = points.length >= 3;

  return (
    <View style={styles.container}>
      <Pressable
        style={styles.canvas}
        onLayout={onLayout}
        onPress={(event) => handlePress(event.nativeEvent.locationX, event.nativeEvent.locationY)}
        accessibilityRole="button"
        accessibilityLabel="Wound outline editor. Tap to add a point, tap a point to select it, then tap elsewhere to move it.">
        <Image source={{ uri: imageUri }} style={styles.image} contentFit="contain" />

        {size.width > 0 ? (
          <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            {/* The model's proposal, for comparison — never editable. */}
            {referenceOutline && referenceOutline.length >= 3 ? (
              <Polygon
                points={referenceOutline.map(toPixels).join(' ')}
                fill="none"
                stroke={AppColors.border}
                strokeWidth={2}
                strokeDasharray="6 5"
              />
            ) : null}

            {closed ? (
              <Polygon
                points={points.map(toPixels).join(' ')}
                fill="rgba(0, 150, 150, 0.22)"
                stroke={AppColors.teal}
                strokeWidth={2.5}
              />
            ) : points.length >= 2 ? (
              // Below three points there is no area yet; show the path so far.
              <Polyline
                points={points.map(toPixels).join(' ')}
                fill="none"
                stroke={AppColors.teal}
                strokeWidth={2.5}
              />
            ) : null}

            {points.map((p, index) => (
              <Circle
                key={`${index}-${p.x}-${p.y}`}
                cx={p.x * size.width}
                cy={p.y * size.height}
                r={index === selected ? 9 : 6}
                fill={index === selected ? AppColors.navy : AppColors.white}
                stroke={AppColors.teal}
                strokeWidth={2.5}
              />
            ))}
          </Svg>
        ) : null}
      </Pressable>

      <View style={styles.toolbar}>
        <Text style={styles.hint}>
          {selected !== null
            ? 'Tap where this point should go'
            : points.length === 0
              ? 'Tap around the edge of the wound'
              : closed
                ? `${points.length} points — tap a point to move it`
                : `${points.length} of 3 points needed`}
        </Text>
        <View style={styles.buttonRow}>
          <SmallButton
            label="Undo"
            disabled={points.length === 0}
            onPress={() => {
              setSelected(null);
              onChange(points.slice(0, -1));
            }}
          />
          <SmallButton
            label="Clear"
            disabled={points.length === 0}
            onPress={() => {
              setSelected(null);
              onChange([]);
            }}
          />
        </View>
      </View>
    </View>
  );
}

function SmallButton({
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
      style={[styles.smallButton, disabled ? styles.smallButtonDisabled : null]}>
      <Text style={[styles.smallButtonText, disabled ? styles.smallButtonTextDisabled : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  canvas: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: AppColors.navy,
  },
  image: {
    ...StyleSheet.absoluteFill,
  },
  toolbar: {
    gap: 10,
  },
  hint: {
    fontSize: 14,
    color: AppColors.textSecondary,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  smallButton: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: AppColors.teal,
  },
  smallButtonDisabled: {
    borderColor: AppColors.border,
  },
  smallButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: AppColors.teal,
  },
  smallButtonTextDisabled: {
    color: AppColors.border,
  },
});
