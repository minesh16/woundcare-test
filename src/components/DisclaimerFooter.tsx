import { StyleSheet, Text, View } from 'react-native';

import { SHORT_DISCLAIMER } from '@/constants/disclaimers';
import { colors, type } from '@/theme';

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
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  text: {
    ...type.caption,
    letterSpacing: 0,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
