import type { PlayerPose, PlayerVec3, PlayerTransform } from './player-pose';

/** Reference worlds can be moved beside an edited mountain. Network poses use the unshifted course frame. */
export function translatePlayerPose(pose: PlayerPose, offset: readonly number[]): PlayerPose {
  const point = (p: PlayerVec3): PlayerVec3 => [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
  const transform = (value: PlayerTransform): PlayerTransform => ({ ...value, p: point(value.p) });
  const gesture = (value: NonNullable<PlayerPose['gesture']>) => ({
    ...value,
    ...(value.target ? { target: point(value.target) } : {}),
  });
  return {
    ...pose,
    body: transform(pose.body),
    ...(pose.head ? { head: transform(pose.head) } : {}),
    ...(pose.hands ? { hands: pose.hands.map(hand => (hand ? transform(hand) : null)) as PlayerPose['hands'] } : {}),
    ...(pose.equipment ? { equipment: { ...pose.equipment, transform: transform(pose.equipment.transform) } } : {}),
    ...(pose.gesture ? { gesture: gesture(pose.gesture) } : {}),
    ...(pose.gestures ? { gestures: pose.gestures.map(gesture) } : {}),
  };
}
