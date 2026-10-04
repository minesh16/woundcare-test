import {
  JetBrainsMono_400Regular,
  JetBrainsMono_600SemiBold,
} from '@expo-google-fonts/jetbrains-mono';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import { SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { colors, type } from '@/theme';

// Native holds the splash until the brand fonts are in, so text never flashes
// in the system face. Web does not wait: with static output, holding the first
// render would export an empty page for every route.
if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync();
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_600SemiBold,
  });
  // A font that fails to load must never block the app; it falls back to the
  // system face.
  const fontsSettled = fontsLoaded || fontError != null;

  useEffect(() => {
    if (fontsSettled && Platform.OS !== 'web') {
      SplashScreen.hideAsync();
    }
  }, [fontsSettled]);

  if (!fontsSettled && Platform.OS !== 'web') {
    return null;
  }

  return (
    // Gestures (dragging outline points, drawing a box) need this root on both
    // web and native.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surfaceCard },
          headerTintColor: colors.textPrimary,
          headerTitleStyle: { fontFamily: type.headingSm.fontFamily, fontSize: type.headingSm.fontSize },
          contentStyle: { backgroundColor: colors.surfacePage },
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
