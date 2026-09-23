import type { BodyZone } from '@/decision/types';

export type BodySide = 'front' | 'back';

/**
 * The long-form name for every zone. This is the string that reaches the
 * clinician report and the AI prompt, so it is the only label users and
 * readers ever see -- the diagram never shows a raw zone id.
 *
 * The Record is exhaustive on purpose: adding a BodyZone is a type error
 * until its label lands here.
 */
export const BODY_ZONE_LABELS: Record<BodyZone, string> = {
  head: 'Head',
  neck: 'Neck',
  chest: 'Chest',
  abdomen: 'Abdomen',
  upper_back: 'Upper back',
  lower_back: 'Lower back',
  sacrum: 'Sacrum',
  shoulder_left: 'Left shoulder',
  shoulder_right: 'Right shoulder',
  upper_arm_left: 'Left upper arm',
  upper_arm_right: 'Right upper arm',
  elbow_left: 'Left elbow',
  elbow_right: 'Right elbow',
  forearm_left: 'Left forearm',
  forearm_right: 'Right forearm',
  hand_left: 'Left hand',
  hand_right: 'Right hand',
  hip_left: 'Left hip',
  hip_right: 'Right hip',
  buttock_left: 'Left buttock',
  buttock_right: 'Right buttock',
  thigh_left: 'Left thigh',
  thigh_right: 'Right thigh',
  knee_left: 'Left knee',
  knee_right: 'Right knee',
  lower_leg_left: 'Left lower leg',
  lower_leg_right: 'Right lower leg',
  ankle_left: 'Left ankle',
  ankle_right: 'Right ankle',
  heel_left: 'Left heel',
  heel_right: 'Right heel',
  foot_left: 'Left foot',
  foot_right: 'Right foot',
  toes_left: 'Left toes',
  toes_right: 'Right toes',
};

/**
 * Which zones each view can reach. Mirrors the regions drawn in
 * `bodyFigure.ts` -- a zone listed here but not drawn there is unreachable
 * from the diagram, so keep the two in step.
 */
export const ZONES_BY_SIDE: Record<BodySide, BodyZone[]> = {
  front: [
    'head',
    'neck',
    'chest',
    'abdomen',
    'shoulder_left',
    'shoulder_right',
    'upper_arm_left',
    'upper_arm_right',
    'elbow_left',
    'elbow_right',
    'forearm_left',
    'forearm_right',
    'hand_left',
    'hand_right',
    'hip_left',
    'hip_right',
    'thigh_left',
    'thigh_right',
    'knee_left',
    'knee_right',
    'lower_leg_left',
    'lower_leg_right',
    'ankle_left',
    'ankle_right',
    'foot_left',
    'foot_right',
    'toes_left',
    'toes_right',
  ],
  back: [
    'head',
    'neck',
    'upper_back',
    'lower_back',
    'sacrum',
    'shoulder_left',
    'shoulder_right',
    'upper_arm_left',
    'upper_arm_right',
    'elbow_left',
    'elbow_right',
    'forearm_left',
    'forearm_right',
    'hand_left',
    'hand_right',
    'buttock_left',
    'buttock_right',
    'thigh_left',
    'thigh_right',
    'knee_left',
    'knee_right',
    'lower_leg_left',
    'lower_leg_right',
    'ankle_left',
    'ankle_right',
    'heel_left',
    'heel_right',
  ],
};

/**
 * The same zones as a plain grouped list, for people who can't or would
 * rather not use the diagram. Every zone appears exactly once.
 */
export const ZONE_GROUPS: { title: string; zones: BodyZone[] }[] = [
  { title: 'Head and neck', zones: ['head', 'neck'] },
  { title: 'Chest and tummy', zones: ['chest', 'abdomen'] },
  { title: 'Back', zones: ['upper_back', 'lower_back', 'sacrum'] },
  {
    title: 'Arms and hands',
    zones: [
      'shoulder_left',
      'shoulder_right',
      'upper_arm_left',
      'upper_arm_right',
      'elbow_left',
      'elbow_right',
      'forearm_left',
      'forearm_right',
      'hand_left',
      'hand_right',
    ],
  },
  {
    title: 'Hips and legs',
    zones: [
      'hip_left',
      'hip_right',
      'buttock_left',
      'buttock_right',
      'thigh_left',
      'thigh_right',
      'knee_left',
      'knee_right',
      'lower_leg_left',
      'lower_leg_right',
    ],
  },
  {
    title: 'Ankles and feet',
    zones: [
      'ankle_left',
      'ankle_right',
      'heel_left',
      'heel_right',
      'foot_left',
      'foot_right',
      'toes_left',
      'toes_right',
    ],
  },
];
