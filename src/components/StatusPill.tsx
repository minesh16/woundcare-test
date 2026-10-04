import { StyleSheet, Text, View } from 'react-native';

import { fonts, radius, status, type, type StatusTone } from '@/theme';

type StatusPillProps = {
  /** compliant = routine / adequate, warning = review, risk = refer. */
  tone: StatusTone;
  label: string;
  showDot?: boolean;
};

/** The clinical-signal primitive. The only place a pill radius is used. */
export function StatusPill({ tone, label, showDot = true }: StatusPillProps) {
  const s = status[tone];
  return (
    <View style={[styles.pill, { backgroundColor: s.bg, borderColor: s.border }]}>
      {showDot ? <View style={[styles.dot, { backgroundColor: s.border }]} /> : null}
      <Text style={[styles.label, { color: s.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 3,
    paddingLeft: 10,
    paddingRight: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    ...type.caption,
    letterSpacing: 0,
    fontFamily: fonts.bodySemiBold,
  },
});
