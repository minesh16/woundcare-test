import { BodyZone } from '@/decision/types';

export type BodySide = 'front' | 'back';

export type ZoneDefinition = {
  id: BodyZone;
  label: string;
  side: BodySide;
  x: number;
  y: number;
  width: number;
  height: number;
};

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
  forearm_left: 'Left forearm',
  forearm_right: 'Right forearm',
  hand_left: 'Left hand',
  hand_right: 'Right hand',
  hip_left: 'Left hip',
  hip_right: 'Right hip',
  thigh_left: 'Left thigh',
  thigh_right: 'Right thigh',
  lower_leg_left: 'Left lower leg',
  lower_leg_right: 'Right lower leg',
  foot_left: 'Left foot',
  foot_right: 'Right foot',
};

export const BODY_ZONES: ZoneDefinition[] = [
  { id: 'head', label: 'Head', side: 'front', x: 42, y: 4, width: 16, height: 10 },
  { id: 'neck', label: 'Neck', side: 'front', x: 44, y: 14, width: 12, height: 6 },
  { id: 'chest', label: 'Chest', side: 'front', x: 34, y: 20, width: 32, height: 14 },
  { id: 'abdomen', label: 'Abdomen', side: 'front', x: 36, y: 34, width: 28, height: 14 },
  { id: 'shoulder_left', label: 'L shoulder', side: 'front', x: 24, y: 20, width: 12, height: 8 },
  { id: 'shoulder_right', label: 'R shoulder', side: 'front', x: 64, y: 20, width: 12, height: 8 },
  { id: 'upper_arm_left', label: 'L upper arm', side: 'front', x: 18, y: 28, width: 10, height: 14 },
  { id: 'upper_arm_right', label: 'R upper arm', side: 'front', x: 72, y: 28, width: 10, height: 14 },
  { id: 'forearm_left', label: 'L forearm', side: 'front', x: 14, y: 42, width: 10, height: 14 },
  { id: 'forearm_right', label: 'R forearm', side: 'front', x: 76, y: 42, width: 10, height: 14 },
  { id: 'hand_left', label: 'L hand', side: 'front', x: 12, y: 56, width: 10, height: 8 },
  { id: 'hand_right', label: 'R hand', side: 'front', x: 78, y: 56, width: 10, height: 8 },
  { id: 'hip_left', label: 'L hip', side: 'front', x: 34, y: 48, width: 14, height: 8 },
  { id: 'hip_right', label: 'R hip', side: 'front', x: 52, y: 48, width: 14, height: 8 },
  { id: 'thigh_left', label: 'L thigh', side: 'front', x: 36, y: 56, width: 12, height: 16 },
  { id: 'thigh_right', label: 'R thigh', side: 'front', x: 52, y: 56, width: 12, height: 16 },
  { id: 'lower_leg_left', label: 'L lower leg', side: 'front', x: 38, y: 72, width: 10, height: 16 },
  { id: 'lower_leg_right', label: 'R lower leg', side: 'front', x: 52, y: 72, width: 10, height: 16 },
  { id: 'foot_left', label: 'L foot', side: 'front', x: 36, y: 88, width: 12, height: 8 },
  { id: 'foot_right', label: 'R foot', side: 'front', x: 52, y: 88, width: 12, height: 8 },
  { id: 'head', label: 'Head', side: 'back', x: 42, y: 4, width: 16, height: 10 },
  { id: 'upper_back', label: 'Upper back', side: 'back', x: 34, y: 20, width: 32, height: 14 },
  { id: 'lower_back', label: 'Lower back', side: 'back', x: 36, y: 34, width: 28, height: 12 },
  { id: 'sacrum', label: 'Sacrum', side: 'back', x: 40, y: 46, width: 20, height: 8 },
  { id: 'shoulder_left', label: 'L shoulder', side: 'back', x: 24, y: 20, width: 12, height: 8 },
  { id: 'shoulder_right', label: 'R shoulder', side: 'back', x: 64, y: 20, width: 12, height: 8 },
  { id: 'upper_arm_left', label: 'L upper arm', side: 'back', x: 18, y: 28, width: 10, height: 14 },
  { id: 'upper_arm_right', label: 'R upper arm', side: 'back', x: 72, y: 28, width: 10, height: 14 },
  { id: 'forearm_left', label: 'L forearm', side: 'back', x: 14, y: 42, width: 10, height: 14 },
  { id: 'forearm_right', label: 'R forearm', side: 'back', x: 76, y: 42, width: 10, height: 14 },
  { id: 'hand_left', label: 'L hand', side: 'back', x: 12, y: 56, width: 10, height: 8 },
  { id: 'hand_right', label: 'R hand', side: 'back', x: 78, y: 56, width: 10, height: 8 },
  { id: 'thigh_left', label: 'L thigh', side: 'back', x: 36, y: 56, width: 12, height: 16 },
  { id: 'thigh_right', label: 'R thigh', side: 'back', x: 52, y: 56, width: 12, height: 16 },
  { id: 'lower_leg_left', label: 'L lower leg', side: 'back', x: 38, y: 72, width: 10, height: 16 },
  { id: 'lower_leg_right', label: 'R lower leg', side: 'back', x: 52, y: 72, width: 10, height: 16 },
  { id: 'foot_left', label: 'L foot', side: 'back', x: 36, y: 88, width: 12, height: 8 },
  { id: 'foot_right', label: 'R foot', side: 'back', x: 52, y: 88, width: 12, height: 8 },
];
