import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  AssessmentResult,
  BaselineComparison,
  BodyZone,
  BoundaryProposal,
  CvResult,
  QuestionnaireAnswers,
  ReviewedBoundary,
  ImageSource,
  ScanSession,
  TissueConfirmation,
  WoundMeasurement,
  defaultAnswers,
  defaultSession,
} from '@/decision/types';

type SessionState = {
  session: ScanSession;
  savedReports: ScanSession[];
  setConsent: (given: boolean) => void;
  setImage: (uri: string, includeCoinReference: boolean) => void;
  setCvResult: (cv: CvResult) => void;
  setBoundaryProposal: (proposal: BoundaryProposal | null) => void;
  setBoundary: (boundary: ReviewedBoundary | null) => void;
  setMeasurement: (measurement: WoundMeasurement | null) => void;
  setScaleRejected: (rejected: boolean) => void;
  setTissueConfirmation: (confirmation: TissueConfirmation | null) => void;
  setCorrectionId: (id: string | null) => void;
  setImageBase64: (base64: string | null) => void;
  setImageSource: (source: ImageSource) => void;
  /** A per-install pseudonymous id sent as `clinician_id` until clinician accounts exist (MW-01). */
  clinicianId: string;
  setBodyZone: (zone: BodyZone) => void;
  setAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  setV2Run: (v2: Record<string, unknown> | null, baseline: BaselineComparison | null) => void;
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
            // A boundary approved for the previous photo must not survive a new
            // one — it would be a human sign-off on a different wound.
            boundaryProposal: null,
            boundary: null,
            measurement: null,
            tissueConfirmation: null,
            correctionId: null,
            imageBase64: null,
            result: null,
          },
        })),
      setCvResult: (cv) =>
        set((state) => ({
          session: { ...state.session, cv },
        })),
      setBoundaryProposal: (proposal) =>
        set((state) => ({
          session: { ...state.session, boundaryProposal: proposal },
        })),
      setBoundary: (boundary) =>
        set((state) => ({
          // A new boundary invalidates everything measured or confirmed inside
          // the old one.
          session: {
            ...state.session,
            boundary,
            measurement: null,
            tissueConfirmation: null,
            correctionId: null,
          },
        })),
      setMeasurement: (measurement) =>
        set((state) => ({
          // Tissue confirmed against other percentages is not a confirmation of these.
          session: { ...state.session, measurement, tissueConfirmation: null },
        })),
      setScaleRejected: (rejected) =>
        set((state) => ({
          session: state.session.measurement
            ? { ...state.session, measurement: { ...state.session.measurement, scaleRejected: rejected } }
            : state.session,
        })),
      setTissueConfirmation: (tissueConfirmation) =>
        set((state) => ({
          session: { ...state.session, tissueConfirmation },
        })),
      setCorrectionId: (correctionId) =>
        set((state) => ({
          session: { ...state.session, correctionId },
        })),
      setImageBase64: (imageBase64) =>
        set((state) => ({
          session: { ...state.session, imageBase64 },
        })),
      setImageSource: (imageSource) =>
        set((state) => ({
          session: { ...state.session, imageSource },
        })),
      clinicianId: `device-${globalThis.crypto.randomUUID()}`,
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
      setV2Run: (v2, baseline) =>
        set((state) => ({
          session: {
            ...state.session,
            // Only overwrite with a real result — a failed comparison run must
            // not wipe a good one the user already has.
            v2: v2 ?? state.session.v2,
            baseline: baseline ?? state.session.baseline,
          },
        })),
      resetSession: () =>
        set((state) => ({
          // Where the photos come from is a property of the person's work, not of
          // one scan — keep it across scans.
          session: { ...defaultSession(), imageSource: state.session.imageSource },
        })),
      saveCurrentReport: (result) =>
        set((state) => ({
          savedReports: [{ ...state.session, result }, ...state.savedReports].slice(0, 10),
        })),
    }),
    {
      name: 'woundcare-session',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ savedReports: state.savedReports, clinicianId: state.clinicianId }),
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
