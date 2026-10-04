import { Image } from 'expo-image';
import { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Polygon, Polyline } from 'react-native-svg';

import { clinicalColors, colors, fonts, radius, type } from '@/theme';

/**
 * Editable wound outline over the photo (segmentation spec §3.3, "Edit outline").
 *
 * Points are kept in FRACTIONAL image coordinates (0–1) throughout, never
 * pixels. The canvas takes the photo's own aspect ratio, so a fraction of the
 * canvas IS a fraction of the image — with a square canvas and a letterboxed
 * portrait photo they were not, and an unchanged "adjust" grew the wound from
 * 2.85% to 5.92% of the frame.
 *
 * Gestures (react-native-gesture-handler, identical on web and native):
 *  - drag a point         → move it
 *  - tap the photo        → add a point (or move the selected one)
 *  - tap a point          → select it; tap elsewhere to move it there (the
 *                           fallback when dragging is awkward); tap it again
 *                           to deselect
 *  - Undo / Reset to AI / Clear → buttons
 *
 * Coordinates come from the gesture events (`x`/`y` relative to the canvas),
 * and a point is only ever created from values verified finite: a NaN point is
 * invisible AND fails server validation, which is how the tap-only version
 * first shipped broken.
 *
 * Handles are drawn at 28 px but hit-tested at 22 px radius — a 44 pt target.
 */

export type EditorPoint = { x: number; y: number };

type MaskEditorProps = {
  imageUri: string;
  points: EditorPoint[];
  onChange: (points: EditorPoint[]) => void;
  /** Called once per finished edit (a tap, or the end of a drag) — for the correction log. */
  onEdit?: () => void;
  /** The model's original outline, drawn dashed for comparison. */
  referenceOutline?: EditorPoint[] | null;
  /** When given, a "Reset to AI" button restores these points. */
  resetTo?: EditorPoint[] | null;
};

const HANDLE_SIZE = 28;
/** Hit radius in px: a 44 pt touch target. */
const HIT_RADIUS_PX = 22;

export function MaskEditor({ imageUri, points, onChange, onEdit, referenceOutline, resetTo }: MaskEditorProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [aspect, setAspect] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [historyLength, setHistoryLength] = useState(0);
  const history = useRef<EditorPoint[][]>([]);
  const dragging = useRef<{ index: number; before: EditorPoint[] } | null>(null);
  // Gesture callbacks read the latest points through a ref, so a drag in
  // progress is never working from a stale copy.
  const pointsRef = useRef(points);
  pointsRef.current = points;

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);

  const toFraction = (x: number, y: number): EditorPoint | null => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || size.width <= 0 || size.height <= 0) return null;
    // Clamp: a touch on the very edge must not produce an out-of-range point,
    // which the server would reject for the whole polygon.
    return { x: Math.min(1, Math.max(0, x / size.width)), y: Math.min(1, Math.max(0, y / size.height)) };
  };

  const hitIndex = (x: number, y: number) =>
    pointsRef.current.findIndex((p) => Math.hypot(p.x * size.width - x, p.y * size.height - y) <= HIT_RADIUS_PX);

  const remember = (before: EditorPoint[]) => {
    history.current.push(before);
    setHistoryLength(history.current.length);
  };

  const commit = (next: EditorPoint[]) => {
    remember(pointsRef.current);
    onChange(next);
    onEdit?.();
  };

  const handleTap = (x: number, y: number) => {
    const point = toFraction(x, y);
    if (!point) {
      console.warn('MaskEditor: a tap had no usable coordinates; ignoring it.');
      return;
    }
    const hit = hitIndex(x, y);
    if (selected !== null) {
      if (hit === selected) {
        setSelected(null);
        return;
      }
      const next = [...pointsRef.current];
      next[selected] = point;
      setSelected(null);
      commit(next);
      return;
    }
    if (hit !== -1) {
      setSelected(hit);
      return;
    }
    commit([...pointsRef.current, point]);
  };

  // The gesture objects are created ONCE. Re-creating them on every render (each
  // drag update re-renders this component) makes GestureDetector drop the
  // gesture in flight, so a drag only ever applied its first update. Handlers
  // are read through a ref, so they still see the latest state.
  const handlers = useRef({
    start: (_x: number, _y: number) => {},
    update: (_x: number, _y: number) => {},
    end: () => {},
    tap: (_x: number, _y: number) => {},
  });
  handlers.current = {
    start: (x, y) => {
      const index = hitIndex(x, y);
      dragging.current = index === -1 ? null : { index, before: pointsRef.current };
      if (index !== -1) setSelected(null);
    },
    update: (x, y) => {
      const drag = dragging.current;
      const point = toFraction(x, y);
      if (!drag || !point) return;
      const next = [...pointsRef.current];
      next[drag.index] = point;
      pointsRef.current = next;
      onChange(next);
    },
    end: () => {
      const drag = dragging.current;
      dragging.current = null;
      if (!drag) return;
      remember(drag.before);
      onEdit?.();
    },
    tap: (x, y) => handleTap(x, y),
  };

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(4)
      .onStart((e) => handlers.current.start(e.x, e.y))
      .onUpdate((e) => handlers.current.update(e.x, e.y))
      .onEnd(() => handlers.current.end());
    const tap = Gesture.Tap()
      .runOnJS(true)
      .maxDistance(8)
      .onEnd((e, success) => {
        if (success) handlers.current.tap(e.x, e.y);
      });
    return Gesture.Race(pan, tap);
  }, []);

  const undo = () => {
    setSelected(null);
    const previous = history.current.pop();
    setHistoryLength(history.current.length);
    if (previous) {
      onChange(previous);
      onEdit?.();
    }
  };

  const toPixels = (p: EditorPoint) => `${p.x * size.width},${p.y * size.height}`;
  const closed = points.length >= 3;

  return (
    <View style={styles.container}>
      <GestureDetector gesture={gesture}>
        <View
          style={[styles.canvas, { aspectRatio: aspect }]}
          onLayout={onLayout}
          accessibilityLabel="Wound outline editor. Drag a point to move it, or tap to add a point.">
          {/* pointerEvents none: on web a press-and-move on an <img> starts the
              browser's native image drag, which cancels the pointer stream after
              a few pixels — a drag would stop dead. The gesture view gets it all. */}
          <View style={styles.image} pointerEvents="none">
            <Image
              source={{ uri: imageUri }}
              style={styles.image}
              // "fill" is distortion-free here because the canvas has the image's
              // own aspect ratio; it guarantees the photo spans the canvas.
              contentFit="fill"
              onLoad={(event) => {
                const { width, height } = event.source;
                if (width > 0 && height > 0) setAspect(width / height);
              }}
            />
          </View>

          {size.width > 0 ? (
            <Svg
              // Explicit width/height/viewBox: an <svg> with no intrinsic size
              // collapses on web and the overlay renders invisibly.
              width={size.width}
              height={size.height}
              viewBox={`0 0 ${size.width} ${size.height}`}
              style={styles.svg}
              pointerEvents="none">
              {referenceOutline && referenceOutline.length >= 3 ? (
                <Polygon
                  points={referenceOutline.map(toPixels).join(' ')}
                  fill="none"
                  stroke={colors.border}
                  strokeWidth={2}
                  strokeDasharray="6 5"
                />
              ) : null}
              {closed ? (
                <Polygon
                  points={points.map(toPixels).join(' ')}
                  fill="rgba(0, 150, 150, 0.22)"
                  stroke={clinicalColors.woundEdge}
                  strokeWidth={2.5}
                />
              ) : points.length >= 2 ? (
                <Polyline points={points.map(toPixels).join(' ')} fill="none" stroke={clinicalColors.woundEdge} strokeWidth={2.5} />
              ) : null}
            </Svg>
          ) : null}

          {/* Handles are plain Views, not SVG, so they never depend on the SVG
              sizing correctly; non-interactive — the gesture owns every touch. */}
          {size.width > 0
            ? points.map((p, index) => (
                <View
                  key={`handle-${index}`}
                  pointerEvents="none"
                  style={[
                    styles.handle,
                    { left: p.x * size.width - HANDLE_SIZE / 2, top: p.y * size.height - HANDLE_SIZE / 2 },
                    index === selected ? styles.handleSelected : null,
                  ]}>
                  <Text style={[styles.handleLabel, index === selected ? styles.handleLabelSelected : null]}>
                    {index + 1}
                  </Text>
                </View>
              ))
            : null}
        </View>
      </GestureDetector>

      <View style={styles.toolbar}>
        <Text style={styles.hint}>
          {selected !== null
            ? 'Tap where this point should go'
            : points.length === 0
              ? 'Tap around the edge of the wound'
              : closed
                ? `${points.length} points — drag a point to move it, or tap to add one`
                : `${points.length} of 3 points needed`}
        </Text>
        <View style={styles.buttonRow}>
          <SmallButton label="Undo" disabled={historyLength === 0} onPress={undo} />
          {resetTo && resetTo.length >= 3 ? (
            <SmallButton
              label="Reset to AI"
              onPress={() => {
                setSelected(null);
                commit(resetTo);
              }}
            />
          ) : null}
          <SmallButton
            label="Clear"
            disabled={points.length === 0}
            onPress={() => {
              setSelected(null);
              commit([]);
            }}
          />
        </View>
      </View>
    </View>
  );
}

function SmallButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={[styles.smallButton, disabled ? styles.smallButtonDisabled : null]}>
      <Text style={[styles.smallButtonText, disabled ? styles.smallButtonTextDisabled : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  canvas: {
    width: '100%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surfaceInverse,
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
    backgroundColor: colors.white,
    borderWidth: 2.5,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleSelected: {
    backgroundColor: colors.surfaceInverse,
    borderColor: colors.white,
    transform: [{ scale: 1.25 }],
  },
  handleLabel: {
    fontFamily: fonts.monoSemiBold,
    fontSize: 11,
    color: colors.primary,
  },
  handleLabelSelected: {
    color: colors.white,
  },
  toolbar: {
    gap: 10,
  },
  hint: {
    ...type.bodyMd,
    color: colors.textSecondary,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  smallButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.surfaceCard,
  },
  smallButtonDisabled: {
    borderColor: colors.border,
  },
  smallButtonText: {
    ...type.bodyMd,
    fontFamily: fonts.bodyBold,
    color: colors.primary,
  },
  smallButtonTextDisabled: {
    color: colors.textDisabled,
  },
});
