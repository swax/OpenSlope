/** Shared names used by the Mixamo converter, runtime driver, and offline character checker. */
export const MIXAMO_TO_SLOPESMITH = {
  Hips: 'Hips',
  Spine: 'Spine',
  Spine1: 'Chest',
  Spine2: 'ChestUpper',
  Neck: 'Neck',
  Head: 'Head',
  LeftShoulder: 'Clavicle.L',
  LeftArm: 'UpperArm.L',
  LeftForeArm: 'LowerArm.L',
  LeftHand: 'Hand.L',
  RightShoulder: 'Clavicle.R',
  RightArm: 'UpperArm.R',
  RightForeArm: 'LowerArm.R',
  RightHand: 'Hand.R',
  LeftUpLeg: 'UpperLeg.L',
  LeftLeg: 'LowerLeg.L',
  LeftFoot: 'Foot.L',
  RightUpLeg: 'UpperLeg.R',
  RightLeg: 'LowerLeg.R',
  RightFoot: 'Foot.R',
} as const;

export type MixamoBone = keyof typeof MIXAMO_TO_SLOPESMITH;
export type CanonicalCharacterBone = (typeof MIXAMO_TO_SLOPESMITH)[MixamoBone];

export const REQUIRED_CHARACTER_BONES = [
  'Hips', 'Chest', 'Head',
  'UpperArm.L', 'LowerArm.L', 'Hand.L',
  'UpperArm.R', 'LowerArm.R', 'Hand.R',
  'UpperLeg.L', 'LowerLeg.L', 'Foot.L',
  'UpperLeg.R', 'LowerLeg.R', 'Foot.R',
] as const satisfies readonly CanonicalCharacterBone[];

/**
 * glTF material `extras` key carrying a scrolling emissive mask's rate in texture-units per second, as
 * `[u, v]`. The generated built-ins write it and `app/ride/character-glow.ts` honours it, so an animated
 * light is a property of a character file rather than of a material name the runtime happens to know — any
 * hand-authored GLB that declares it animates the same way (docs/030).
 */
export const CHARACTER_UV_SCROLL_KEY = 'slopesmith_uv_scroll';

/** glTF/Three may remove punctuation that animation paths reserve. */
export function normalizedCharacterBoneName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}
