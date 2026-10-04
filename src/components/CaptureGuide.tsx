import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, type } from '@/theme';

export function CaptureGuide() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Capture tips</Text>
      <Text style={styles.item}>• Centre the wound in the frame</Text>
      <Text style={styles.item}>• Use bright, even lighting</Text>
      <Text style={styles.item}>• Hold the camera 15–30 cm away</Text>
      <Text style={styles.item}>• Optional: include a 20c coin beside the wound for scale</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.primarySubtle,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primaryMuted,
    padding: 14,
    gap: 6,
  },
  title: {
    ...type.bodyMd,
    fontFamily: fonts.bodyBold,
    color: colors.textPrimary,
  },
  item: {
    ...type.bodySm,
    lineHeight: 18,
    color: colors.textSecondary,
  },
});
