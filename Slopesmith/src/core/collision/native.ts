/** Native `ObjectProperties.CollsionMode` values [Trailmap: 130-collision-data]. The misspelling is part of the file contract. */
export const NATIVE_COLLISION_MODE = {
  none: 0,
  triangleProxy: 1,
  boundingBox: 2,
  physicsBodySpheres: 3,
} as const;

export type NativeCollisionMode = typeof NATIVE_COLLISION_MODE[keyof typeof NATIVE_COLLISION_MODE];
export type NativeContactState = 'none' | 'through' | 'solid';

export interface NativeCollisionState {
  visible: boolean;
  playerCollision: boolean;
  playerBounce: boolean;
  mode: NativeCollisionMode;
  responseMass: number;
  hasTriangleProxy: boolean;
  hasPhysicsBody: boolean;
}

/**
 * Specified rider-response classification [Trailmap: 130-collision-data]. A mode selects the tested shape; it does not by itself make an instance
 * contactable. Once a shape reports contact, exact-zero response mass (`ObjectProperties.U0` on disc) is
 * massless/pass-through. PlayerBounce-off also preserves contact/effect dispatch while suppressing physical
 * response in every tested shape mode: the live mode-1 follow-up emitted its cyan marker and passed through,
 * matching the earlier mode-2 control. Dynamic body activation is separate; its inverse mass comes from the
 * activating effect payload rather than this instance field.
 *
 * This helper drives Slopesmith previews, not canonical serialization: raw fields always pack unchanged.
 */
export function nativeContactState(state: NativeCollisionState): NativeContactState {
  if (!state.playerCollision) return 'none';
  const hasShape = state.mode === NATIVE_COLLISION_MODE.triangleProxy ? state.hasTriangleProxy
    : state.mode === NATIVE_COLLISION_MODE.boundingBox
      ? true
      : state.mode === NATIVE_COLLISION_MODE.physicsBodySpheres ? state.hasPhysicsBody : false;
  if (!hasShape) return 'none';
  if (state.responseMass === 0) return 'through';
  return state.playerBounce ? 'solid' : 'through';
}
