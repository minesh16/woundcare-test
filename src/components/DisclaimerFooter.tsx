import { StyleSheet, Text, View } from 'react-native';

import { SHORT_DISCLAIMER } from '@/constants/disclaimers';
import { AppColors } from '@/constants/appTheme';

export function DisclaimerFooter() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{SHORT_DISCLAIMER}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: AppColors.border,
    backgroundColor: AppColors.tealLight,
  },
  text: {
    fontSize: 12,
    lineHeight: 16,
    color: AppColors.textSecondary,
    textAlign: 'center',
  },
});
