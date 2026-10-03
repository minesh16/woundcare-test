import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { CaptureGuide } from '@/components/CaptureGuide';
import { DisclaimerFooter } from '@/components/DisclaimerFooter';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ProgressHeader } from '@/components/ProgressHeader';
import { AppColors } from '@/constants/appTheme';
import { useSessionStore } from '@/store/sessionStore';

export default function CaptureScreen() {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  // On by default — with it off no scale is ever looked for, and a photo that
  // did carry a coin was reported as having no size reference.
  const [includeCoin, setIncludeCoin] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const setImage = useSessionStore((state) => state.setImage);
  const imageSource = useSessionStore((state) => state.session.imageSource);
  const setImageSource = useSessionStore((state) => state.setImageSource);

  // Location comes before analysis (segmentation spec §6.4): it decides whether
  // the foot-ulcer model gives a second opinion on the outline.
  const proceedWithUri = (uri: string) => {
    setImage(uri, includeCoin);
    router.push('/location');
  };

  const takePhoto = async () => {
    setError(null);

    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setError('Camera permission is required. Use gallery instead.');
        return;
      }
    }

    // On web the returned uri is a base64 data URI (no local filesystem path).
    const photo = await cameraRef.current?.takePictureAsync({
      quality: 0.85,
      base64: Platform.OS === 'web',
    });
    if (!photo?.uri) {
      setError('Could not capture photo. Try again.');
      return;
    }

    proceedWithUri(photo.uri);
  };

  const pickFromGallery = async () => {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
    });

    if (!result.canceled && result.assets[0]?.uri) {
      proceedWithUri(result.assets[0].uri);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ProgressHeader step={1} title="Capture wound photo" />
        <CaptureGuide />

        {permission?.granted ? (
          <View style={styles.cameraWrap}>
            <CameraView ref={cameraRef} style={styles.camera} facing="back" />
            <View style={styles.guideBox} />
          </View>
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>
              Camera permission needed. Allow access or choose from gallery.
            </Text>
          </View>
        )}

        <View style={styles.toggleRow}>
          <View style={styles.toggleCopy}>
            <Text style={styles.toggleTitle}>Include 20c coin for scale</Text>
            <Text style={styles.toggleHint}>Place a coin beside the wound in the photo.</Text>
          </View>
          <Switch value={includeCoin} onValueChange={setIncludeCoin} trackColor={{ true: AppColors.teal }} />
        </View>

        {/* Research log (spec §4.1): decides whether outline images may be kept
            in the correction dataset. Only non-patient images ever are. */}
        <View style={styles.sourceCard}>
          <Text style={styles.toggleTitle}>Where is this photo from?</Text>
          <Text style={styles.toggleHint}>
            For the research log. Outline images are only kept for synthetic or public-dataset photos.
          </Text>
          <View style={styles.sourceRow}>
            {(
              [
                ['consented_demo', 'Consented photo'],
                ['synthetic', 'Synthetic'],
                ['public_dataset', 'Public dataset'],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                onPress={() => setImageSource(value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: imageSource === value }}
                style={[styles.sourceChip, imageSource === value ? styles.sourceChipActive : null]}>
                <Text style={[styles.sourceChipText, imageSource === value ? styles.sourceChipTextActive : null]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <PrimaryButton label="Take photo" onPress={takePhoto} />
        <PrimaryButton label="Choose from gallery" onPress={pickFromGallery} variant="secondary" />
      </ScrollView>
      <DisclaimerFooter />
    </View>
  );
}

const styles = StyleSheet.create({
  sourceCard: {
    gap: 8,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: AppColors.border,
    backgroundColor: AppColors.white,
  },
  sourceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sourceChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: AppColors.border,
  },
  sourceChipActive: {
    borderColor: AppColors.teal,
    backgroundColor: 'rgba(0, 150, 150, 0.08)',
  },
  sourceChipText: {
    fontSize: 14,
    color: AppColors.text,
  },
  sourceChipTextActive: {
    fontWeight: '700',
    color: AppColors.teal,
  },
  container: {
    flex: 1,
    backgroundColor: AppColors.background,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  cameraWrap: {
    height: 320,
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  guideBox: {
    position: 'absolute',
    top: '25%',
    left: '20%',
    width: '60%',
    height: '40%',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.8)',
    borderRadius: 12,
  },
  placeholder: {
    height: 220,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: AppColors.border,
    backgroundColor: AppColors.white,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  placeholderText: {
    textAlign: 'center',
    color: AppColors.textSecondary,
    lineHeight: 20,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: AppColors.white,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: AppColors.border,
  },
  toggleCopy: {
    flex: 1,
    gap: 4,
  },
  toggleTitle: {
    fontWeight: '700',
    color: AppColors.text,
  },
  toggleHint: {
    fontSize: 13,
    color: AppColors.textSecondary,
  },
  error: {
    color: AppColors.danger,
    fontSize: 14,
  },
});
