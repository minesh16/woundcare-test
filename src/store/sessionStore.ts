import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  AssessmentResult,
  BodyZone,
  CvResult,
  QuestionnaireAnswers,
  ScanSession,
  defaultAnswers,
  defaultSession,
} from '@/decision/types';

type SessionState = {
  session: ScanSession;
  savedReports: ScanSession[];
  setConsent: (given: boolean) => void;
  setImage: (uri: string, includeCoinReference: boolean) => void;
  setCvResult: (cv: CvResult) => void;
  setBodyZone: (zone: BodyZone) => void;
  setAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  resetSession: () => void;
  saveCurrentReport: (result: AssessmentResult) => void;
};

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      session: defaultSession(),
      savedReports: [],
      setConsent: (given) =>
        set((state) => ({
          session: { ...state.session, consentGiven: given },
        })),
      setImage: (uri, includeCoinReference) =>
        set((state) => ({
          session: {
            ...state.session,
            imageUri: uri,
            includeCoinReference,
            cv: null,
            result: null,
          },
        })),
      setCvResult: (cv) =>
        set((state) => ({
          session: { ...state.session, cv },
        })),
      setBodyZone: (zone) =>
        set((state) => ({
          session: { ...state.session, bodyZone: zone },
        })),
      setAnswers: (answers) =>
        set((state) => ({
          session: {
            ...state.session,
            answers: { ...state.session.answers, ...answers },
          },
        })),
      resetSession: () =>
        set({
          session: defaultSession(),
        }),
      saveCurrentReport: (result) =>
        set((state) => ({
          savedReports: [{ ...state.session, result }, ...state.savedReports].slice(0, 10),
        })),
    }),
    {
      name: 'woundcare-session',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ savedReports: state.savedReports }),
    },
  ),
);

export function isQuestionnaireComplete(answers: QuestionnaireAnswers): boolean {
  return (
    answers.durationOver30Days !== null &&
    answers.exudate !== null &&
    answers.warmth !== null
  );
}
