import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, type } from '@/theme';

type WaitingNoticeProps = {
  /** What is happening right now, e.g. "Measuring inside the outline…". */
  message: string;
  /** Shown once the wait passes `slowAfterSec`, e.g. why a model can be slow. */
  slowHint?: string;
  slowAfterSec?: number;
  /** Restart the clock when the stage changes (pass the stage name). */
  resetKey?: string;
};

/** Seconds since mount (or since `resetKey` last changed). */
function useElapsedSeconds(resetKey?: string) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [resetKey]);
  return seconds;
}

/**
 * A spinner with the current stage, for any wait that can run past a couple of
 * seconds (model calls, measuring). After 3 s it counts up, so a slow server
 * reads as "still working", not as a hung app.
 */
export function WaitingNotice({ message, slowHint, slowAfterSec = 12, resetKey }: WaitingNoticeProps) {
  const seconds = useElapsedSeconds(resetKey);

  return (
    <View style={styles.container} accessibilityRole="progressbar" accessibilityLiveRegion="polite">
      <View style={styles.row}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.message}>{message}</Text>
        {seconds >= 3 ? <Text style={styles.elapsed}>{seconds}s</Text> : null}
      </View>
      {slowHint && seconds >= slowAfterSec ? <Text style={styles.hint}>{slowHint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  message: {
    ...type.bodyMd,
    flexShrink: 1,
    fontFamily: fonts.bodySemiBold,
    color: colors.textPrimary,
  },
  elapsed: {
    ...type.bodySm,
    fontFamily: fonts.mono,
    color: colors.textMuted,
  },
  hint: {
    ...type.bodySm,
    lineHeight: 19,
    color: colors.textSecondary,
  },
});
