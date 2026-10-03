import { Image } from 'expo-image';
import { useCallback, useRef, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Polygon, Polyline } from 'react-native-svg';

import { AppColors } from '@/constants/appTheme';

/**
 * Editable wound outline over the photo.
 *
 * Points are kept in FRACTIONAL image coordinates (0–1) throughout, never
 * pixels. The display size, the photo's real size and the size the mask is
 * finally rasterised at are all different, and a fractional polygon is the only
 * representation that is correct in all three.
 *
 * **Coordinates are the fiddly part.** `event.nativeEvent.locationX` is a lazy
 * getter on react-native-web: it measures `currentTarget` when read, and returns
 * `undefined` once the DOM event has been dispatched. `undefined / width` is
 * `NaN`, and a NaN point is invisible when rendered AND fails server validation —
 * which is exactly how this first shipped: taps registered, nothing drew, and
 * saving failed. So a point is only ever created from coordinates that are
 * verified finite, with a measured fallback when `locationX` is unusable.
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

/** Handle diameter in px. Large enough to be a comfortable touch target. */
const HANDLE_SIZE = 22;

export function MaskEditor({ imageUri, points, onChange, referenceOutline }: MaskEditorProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState<number | null>(null);
  const canvasRef = useRef<View>(null);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);

  const addOrMove = useCallback(
    (fractionalX: number, fractionalY: number) => {
      const point = {
        // Clamp: a tap on the very edge must not produce an out-of-range point,
        // which the server would reject for the whole polygon.
        x: Math.min(1, Math.max(0, fractionalX)),
        y: Math.min(1, Math.max(0, fractionalY)),
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
    [onChange, points, selected],
  );

  /**
   * Resolve a press to fractional coordinates.
   *
   * Fast path: `locationX/locationY`, already relative to this view. Verified
   * finite rather than assumed — see the note at the top of this file.
   *
   * Fallback: `pageX/pageY`, which are plain captured numbers, minus this view's
   * measured position. On web `measureInWindow` is viewport-relative while
   * `pageX` is document-relative, so the scroll offset is subtracted; on native
   * both are window-relative and `window.scrollX` is undefined, so the same
   * expression is correct on both.
   */
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      if (size.width <= 0 || size.height <= 0) return;
      const { locationX, locationY, pageX, pageY } = event.nativeEvent;

      if (Number.isFinite(locationX) && Number.isFinite(locationY)) {
        addOrMove(locationX / size.width, locationY / size.height);
        return;
      }

      if (!Number.isFinite(pageX) || !Number.isFinite(pageY) || !canvasRef.current) {
        // No usable coordinates. Dropping the tap is right: a guessed point puts
        // the wound edge somewhere the clinician did not touch.
        console.warn('MaskEditor: press had no usable coordinates; ignoring the tap.');
        return;
      }

      canvasRef.current.measureInWindow((frameX, frameY) => {
        const scrollX = typeof window !== 'undefined' ? window.scrollX || 0 : 0;
        const scrollY = typeof window !== 'undefined' ? window.scrollY || 0 : 0;
        const x = (pageX - scrollX - frameX) / size.width;
        const y = (pageY - scrollY - frameY) / size.height;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        addOrMove(x, y);
      });
    },
    [addOrMove, size.height, size.width],
  );

  const toPixels = (p: EditorPoint) => `${p.x * size.width},${p.y * size.height}`;
  const closed = points.length >= 3;

  return (
    <View style={styles.container}>
      <Pressable
        ref={canvasRef}
        style={styles.canvas}
        onLayout={onLayout}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel="Wound outline editor. Tap to add a point, tap a point to select it, then tap elsewhere to move it.">
        <Image source={{ uri: imageUri }} style={styles.image} contentFit="contain" />

        {size.width > 0 ? (
          <Svg
            // Explicit width/height/viewBox, not just absoluteFill: an <svg> with
            // no intrinsic dimensions collapses on web and the whole overlay
            // renders invisibly — which is exactly what happened.
            width={size.width}
            height={size.height}
            viewBox={`0 0 ${size.width} ${size.height}`}
            style={styles.svg}
            pointerEvents="none">
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

          </Svg>
        ) : null}

        {/*
          Handles are plain Views, not SVG circles, deliberately: they are the
          one affordance the editor cannot work without, so they must not depend
          on the SVG element sizing correctly on a given platform. Non-interactive
          — the Pressable underneath owns every tap, so a handle cannot swallow
          the press that is meant to select it.
        */}
        {size.width > 0
          ? points.map((p, index) => (
              <View
                key={`handle-${index}`}
                pointerEvents="none"
                style={[
                  styles.handle,
                  {
                    left: p.x * size.width - HANDLE_SIZE / 2,
                    top: p.y * size.height - HANDLE_SIZE / 2,
                  },
                  index === selected ? styles.handleSelected : null,
                ]}>
                <Text style={[styles.handleLabel, index === selected ? styles.handleLabelSelected : null]}>
                  {index + 1}
                </Text>
              </View>
            ))
          : null}
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
  svg: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  handle: {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    borderRadius: HANDLE_SIZE / 2,
    backgroundColor: AppColors.white,
    borderWidth: 2.5,
    borderColor: AppColors.teal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleSelected: {
    backgroundColor: AppColors.navy,
    borderColor: AppColors.white,
    transform: [{ scale: 1.25 }],
  },
  handleLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: AppColors.teal,
  },
  handleLabelSelected: {
    color: AppColors.white,
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
