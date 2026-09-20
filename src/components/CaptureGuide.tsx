import { StyleSheet, Text, View } from 'react-native';

import { AppColors } from '@/constants/appTheme';

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
    backgroundColor: AppColors.tealLight,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: AppColors.navy,
  },
  item: {
    fontSize: 13,
    color: AppColors.textSecondary,
    lineHeight: 18,
  },
});
