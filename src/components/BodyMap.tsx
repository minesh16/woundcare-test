import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Ellipse, Rect } from 'react-native-svg';

import { BODY_ZONES, BodySide } from '@/constants/bodyZones';
import { AppColors } from '@/constants/appTheme';
import { BodyZone } from '@/decision/types';

type BodyMapProps = {
  selectedZone: BodyZone | null;
  onSelect: (zone: BodyZone) => void;
};

export function BodyMap({ selectedZone, onSelect }: BodyMapProps) {
  const [side, setSide] = useState<BodySide>('front');
  const zones = useMemo(() => BODY_ZONES.filter((zone) => zone.side === side), [side]);

  return (
    <View style={styles.container}>
      <View style={styles.toggleRow}>
        {(['front', 'back'] as BodySide[]).map((option) => (
          <Pressable
            key={option}
            onPress={() => setSide(option)}
            style={[styles.toggle, side === option && styles.toggleActive]}>
            <Text style={[styles.toggleText, side === option && styles.toggleTextActive]}>
              {option === 'front' ? 'Front' : 'Back'}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.mapWrap}>
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
          <Ellipse cx="50" cy="52" rx="22" ry="42" fill="#E8EDF5" stroke={AppColors.border} />
          <Ellipse cx="50" cy="10" rx="8" ry="8" fill="#E8EDF5" stroke={AppColors.border} />
          {zones.map((zone) => (
            <Rect
              key={`${zone.side}-${zone.id}`}
              x={zone.x}
              y={zone.y}
              width={zone.width}
              height={zone.height}
              rx={3}
              fill={selectedZone === zone.id ? AppColors.teal : 'transparent'}
              opacity={selectedZone === zone.id ? 0.45 : 0.01}
              stroke={selectedZone === zone.id ? AppColors.teal : 'transparent'}
              strokeWidth={1}
            />
          ))}
        </Svg>

        {zones.map((zone) => (
          <Pressable
            key={`${zone.side}-${zone.id}-press`}
            accessibilityRole="button"
            accessibilityLabel={zone.label}
            onPress={() => onSelect(zone.id)}
            style={[
              styles.zone,
              {
                left: `${zone.x}%`,
                top: `${zone.y}%`,
                width: `${zone.width}%`,
                height: `${zone.height}%`,
              },
              selectedZone === zone.id && styles.zoneSelected,
            ]}
          />
        ))}
      </View>

      <Text style={styles.hint}>
        {selectedZone ? `Selected: ${zones.find((z) => z.id === selectedZone)?.label ?? selectedZone}` : 'Tap a body area'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
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
  mapWrap: {
    height: 360,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    backgroundColor: AppColors.white,
    overflow: 'hidden',
    position: 'relative',
  },
  zone: {
    position: 'absolute',
    borderRadius: 6,
  },
  zoneSelected: {
    borderWidth: 2,
    borderColor: AppColors.teal,
    backgroundColor: 'rgba(27, 153, 139, 0.15)',
  },
  hint: {
    fontSize: 14,
    color: AppColors.textSecondary,
    textAlign: 'center',
  },
});
