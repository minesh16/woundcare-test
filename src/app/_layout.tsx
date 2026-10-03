import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppColors } from '@/constants/appTheme';

export default function RootLayout() {
  return (
    // Gestures (dragging outline points, drawing a box) need this root on both
    // web and native.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: AppColors.white },
          headerTintColor: AppColors.navy,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: AppColors.background },
        }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="capture" options={{ title: 'Capture wound' }} />
        <Stack.Screen name="analyze" options={{ title: 'Your photo' }} />
        <Stack.Screen name="review" options={{ title: 'Check the outline' }} />
        <Stack.Screen name="location" options={{ title: 'Wound location' }} />
        <Stack.Screen name="questions" options={{ title: 'Questions' }} />
        <Stack.Screen name="result" options={{ title: 'Your result' }} />
        <Stack.Screen name="compare" options={{ title: 'Grounded vs ungrounded' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
