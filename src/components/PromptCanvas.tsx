import { Image } from 'expo-image';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, G, Line, Polygon, Rect } from 'react-native-svg';

import type { PromptBox, PromptPoint } from '@/assessment/client';
import { AppColors } from '@/constants/appTheme';

/**
 * The review screen's photo, with the model's outline and the clinician's
 * prompts (segmentation spec §3.3, modes 1–3):
 *
 *   include  tap → a `label: 1` point (this is wound)
 *   exclude  tap → a `label: 0` point (this is not wound)
 *   box      drag → a box around the wound
 *
 * The parent re-asks SAM 3 with every prompt so far. Fractional coordinates
 * throughout; the canvas has the photo's aspect ratio, so a fraction of the
 * canvas is a fraction of the image.
 */

export type PromptMode = 'include' | 'exclude' | 'box' | null;
type Point = { x: number; y: number };

export const SECOND_OPINION_COLOUR = '#F97316';

export function PromptCanvas({
  imageUri,
  outline,
  secondOutline,
  points,
  box,
  mode,
  busy,
  onTap,
  onBox,
}: {
  imageUri: string;
  /** The proposed outline (yellow). */
  outline: Point[] | null;
  /** FUSegNet's outline (orange), shown when the two models disagree. */
  secondOutline?: Point[] | null;
  points: PromptPoint[];
  box: PromptBox | null;
  mode: PromptMode;
  busy: boolean;
  onTap: (point: PromptPoint) => void;
  onBox: (box: PromptBox) => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [aspect, setAspect] = useState(1);
  const [draft, setDraft] = useState<PromptBox | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // The box being drawn, readable from the gesture's end without going through
  // a state updater (calling the parent from inside one is not allowed).
  const draftRef = useRef<PromptBox | null>(null);

  const frac = (x: number, y: number) =>
    Number.isFinite(x) && Number.isFinite(y) && size.width > 0 && size.height > 0
      ? { x: Math.min(1, Math.max(0, x / size.width)), y: Math.min(1, Math.max(0, y / size.height)) }
      : null;

  // Created once: a gesture re-created on render (the box preview re-renders on
  // every move) is dropped by GestureDetector mid-drag. Handlers go via a ref.
  const handlers = useRef({ tap: (_x: number, _y: number) => {}, start: (_x: number, _y: number) => {}, update: (_x: number, _y: number) => {}, end: () => {} });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  handlers.current = {
    tap: (x, y) => {
      const p = frac(x, y);
      const m = modeRef.current;
      if (!p || (m !== 'include' && m !== 'exclude')) return;
      onTap({ xPct: p.x, yPct: p.y, label: m === 'include' ? 1 : 0 });
    },
    start: (x, y) => {
      start.current = modeRef.current === 'box' ? frac(x, y) : null;
    },
    update: (x, y) => {
      const p = frac(x, y);
      const s0 = start.current;
      if (!p || !s0) return;
      const next = { x0Pct: Math.min(s0.x, p.x), y0Pct: Math.min(s0.y, p.y), x1Pct: Math.max(s0.x, p.x), y1Pct: Math.max(s0.y, p.y) };
      draftRef.current = next;
      setDraft(next);
    },
    end: () => {
      start.current = null;
      const finished = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (finished && finished.x1Pct - finished.x0Pct > 0.01 && finished.y1Pct - finished.y0Pct > 0.01) onBox(finished);
    },
  };

  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .runOnJS(true)
      .maxDistance(8)
      .onEnd((e, success) => {
        if (success) handlers.current.tap(e.x, e.y);
      });
    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(4)
      .onStart((e) => handlers.current.start(e.x, e.y))
      .onUpdate((e) => handlers.current.update(e.x, e.y))
      .onEnd(() => handlers.current.end());
    return Gesture.Race(pan, tap);
  }, []);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  };

  const px = (p: Point) => `${p.x * size.width},${p.y * size.height}`;
  const shownBox = draft ?? box;

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={[styles.canvas, { aspectRatio: aspect }]}
        onLayout={onLayout}
        accessibilityLabel={
          mode === 'include'
            ? 'Tap on the wound to include that area'
            : mode === 'exclude'
              ? 'Tap on an area that is not wound'
              : mode === 'box'
                ? 'Drag a box around the wound'
                : 'The proposed wound outline'
        }>
        {/* pointerEvents none: on web a press-and-move on an <img> starts the
            browser's native image drag and cancels the gesture. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Image
            source={{ uri: imageUri }}
            style={StyleSheet.absoluteFill}
            contentFit="fill"
            onLoad={(event) => {
              const { width, height } = event.source;
              if (width > 0 && height > 0) setAspect(width / height);
            }}
          />
        </View>
        {size.width > 0 ? (
          <Svg
            width={size.width}
            height={size.height}
            viewBox={`0 0 ${size.width} ${size.height}`}
            style={StyleSheet.absoluteFill}
            pointerEvents="none">
            {secondOutline && secondOutline.length >= 3 ? (
              <Polygon points={secondOutline.map(px).join(' ')} fill="none" stroke={SECOND_OPINION_COLOUR} strokeWidth={2.5} strokeDasharray="7 5" />
            ) : null}
            {outline && outline.length >= 3 ? (
              <Polygon points={outline.map(px).join(' ')} fill="rgba(0, 150, 150, 0.2)" stroke={AppColors.woundEdge} strokeWidth={3} />
            ) : null}
            {shownBox ? (
              <Rect
                x={shownBox.x0Pct * size.width}
                y={shownBox.y0Pct * size.height}
                width={(shownBox.x1Pct - shownBox.x0Pct) * size.width}
                height={(shownBox.y1Pct - shownBox.y0Pct) * size.height}
                fill="none"
                stroke="#2563EB"
                strokeWidth={2.5}
                strokeDasharray={draft ? '6 4' : undefined}
              />
            ) : null}
            {points.map((p, i) => {
              const cx = p.xPct * size.width;
              const cy = p.yPct * size.height;
              const colour = p.label === 1 ? '#16A34A' : '#DC2626';
              return (
                <G key={`p-${i}`}>
                  <Circle cx={cx} cy={cy} r={11} fill={colour} stroke="#FFFFFF" strokeWidth={2} />
                  <Line x1={cx - 5} y1={cy} x2={cx + 5} y2={cy} stroke="#FFFFFF" strokeWidth={2.5} />
                  {p.label === 1 ? <Line x1={cx} y1={cy - 5} x2={cx} y2={cy + 5} stroke="#FFFFFF" strokeWidth={2.5} /> : null}
                </G>
              );
            })}
          </Svg>
        ) : null}
        {busy ? (
          <View style={styles.busy} pointerEvents="none">
            <ActivityIndicator color={AppColors.white} size="large" />
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  canvas: {
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: AppColors.navy,
  },
  busy: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
