import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { BodyFigure } from '@/components/BodyFigure';
import { OptionButton, QuestionCard } from '@/components/QuestionCard';
import { AppColors, AppLayout } from '@/constants/appTheme';
import {
  BODY_ZONE_LABELS,
  ZONES_BY_SIDE,
  ZONE_GROUPS,
  type BodySide,
} from '@/constants/bodyZones';
import type { BodySex } from '@/constants/bodyFigure';
import { BodyZone } from '@/decision/types';

type BodySelectorProps = {
  selectedZone: BodyZone | null;
  onSelect: (zone: BodyZone) => void;
};

const SIDE_CAPTION: Record<BodySide, string> = {
  front: 'Front view, as if you are facing the person',
  back: 'Back view, as if you are standing behind them',
};

const SIDE_LABEL: Record<BodySide, string> = { front: 'Front', back: 'Back' };

/** Both figures fit side by side once the column is this wide. */
const SIDE_BY_SIDE_WIDTH = 760;

export function BodySelector({ selectedZone, onSelect }: BodySelectorProps) {
  const [side, setSide] = useState<BodySide>('front');
  // Which figure is drawn is a display preference, not a clinical observation,
  // so it stays out of the session store.
  const [sex, setSex] = useState<BodySex>('male');
  const [listOpen, setListOpen] = useState(false);

  // The web build prerenders this screen, where window width is 0. Gating on
  // mount keeps the server markup and the first client render identical, then
  // upgrades to the wide layout a frame later.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { width } = useWindowDimensions();
  const sideBySide = mounted && width >= SIDE_BY_SIDE_WIDTH;

  // A zone picked from the list may belong to the other view; follow it there
  // so the diagram always shows what is selected.
  const handleSelect = (zone: BodyZone) => {
    if (!ZONES_BY_SIDE[side].includes(zone)) {
      setSide(ZONES_BY_SIDE.front.includes(zone) ? 'front' : 'back');
    }
    onSelect(zone);
  };

  return (
    <View style={styles.container}>
      <View style={styles.sexRow}>
        <Text style={styles.sexLabel}>Figure</Text>
        {(['male', 'female'] as BodySex[]).map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            onPress={() => setSex(option)}
            style={[styles.sexPill, sex === option && styles.sexPillActive]}>
            <Text style={[styles.sexPillText, sex === option && styles.sexPillTextActive]}>
              {option === 'male' ? 'Male' : 'Female'}
            </Text>
          </Pressable>
        ))}
      </View>

      {sideBySide ? (
        <View style={styles.figureRow}>
          {(['front', 'back'] as BodySide[]).map((option) => (
            <View key={option} style={styles.figureCard}>
              <Text style={styles.figureCardTitle}>{SIDE_LABEL[option]}</Text>
              <BodyFigure
                side={option}
                sex={sex}
                selectedZone={selectedZone}
                onSelect={handleSelect}
                maxWidth={AppLayout.maxFigureWidthPaired}
              />
              <Text style={styles.caption}>{SIDE_CAPTION[option]}</Text>
            </View>
          ))}
        </View>
      ) : (
        <>
          <View style={styles.toggleRow}>
            {(['front', 'back'] as BodySide[]).map((option) => (
              <Pressable
                key={option}
                accessibilityRole="button"
                onPress={() => setSide(option)}
                style={[styles.toggle, side === option && styles.toggleActive]}>
                <Text style={[styles.toggleText, side === option && styles.toggleTextActive]}>
                  {SIDE_LABEL[option]}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.figureCard}>
            <BodyFigure
              side={side}
              sex={sex}
              selectedZone={selectedZone}
              onSelect={handleSelect}
              maxWidth={AppLayout.maxFigureWidth}
            />
            <Text style={styles.caption}>{SIDE_CAPTION[side]}</Text>
          </View>
        </>
      )}

      <View style={styles.chip} accessibilityLiveRegion="polite">
        <Text style={styles.chipText}>
          {selectedZone ? `Selected: ${BODY_ZONE_LABELS[selectedZone]}` : 'Tap a body area'}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => setListOpen((open) => !open)}
        style={styles.listToggle}>
        <Text style={styles.listToggleText}>
          {listOpen ? 'Hide the list' : 'Choose from a list instead'}
        </Text>
      </Pressable>

      {listOpen
        ? ZONE_GROUPS.map((group) => (
            <QuestionCard key={group.title} title={group.title}>
              {group.zones.map((zone) => (
                <OptionButton<BodyZone>
                  key={zone}
                  label={BODY_ZONE_LABELS[zone]}
                  value={zone}
                  selected={selectedZone === zone}
                  onSelect={handleSelect}
                />
              ))}
            </QuestionCard>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  sexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sexLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: AppColors.textSecondary,
    marginRight: 2,
  },
  sexPill: {
    borderWidth: 1,
    borderColor: AppColors.border,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: AppColors.white,
  },
  sexPillActive: {
    borderColor: AppColors.teal,
    backgroundColor: AppColors.tealLight,
  },
  sexPillText: {
    fontSize: 13,
    color: AppColors.textSecondary,
    fontWeight: '600',
  },
  sexPillTextActive: {
    color: AppColors.navy,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toggle: {
    flex: 1,
    borderWidth: 1,
    borderColor: AppColors.border,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: AppColors.white,
  },
  toggleActive: {
    borderColor: AppColors.teal,
    backgroundColor: AppColors.tealLight,
  },
  toggleText: {
    color: AppColors.textSecondary,
    fontWeight: '600',
  },
  toggleTextActive: {
    color: AppColors.navy,
  },
  figureRow: {
    flexDirection: 'row',
    gap: 12,
  },
  figureCard: {
    flex: 1,
    backgroundColor: AppColors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    padding: 12,
    gap: 8,
  },
  figureCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: AppColors.navy,
    textAlign: 'center',
  },
  caption: {
    fontSize: 12,
    color: AppColors.textSecondary,
    textAlign: 'center',
  },
  chip: {
    alignSelf: 'center',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: AppColors.tealLight,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '600',
    color: AppColors.navy,
  },
  listToggle: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  listToggleText: {
    fontSize: 14,
    fontWeight: '600',
    color: AppColors.teal,
  },
});
