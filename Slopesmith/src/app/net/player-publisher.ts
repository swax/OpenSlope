import type {
  LocalPlayerEquipmentPose, LocalPlayerPose, PlayerEquipmentPose, PlayerPose, PlayerQuat, PlayerTransform,
  PlayerVec3,
} from '../../core/session/player-pose';

const HEARTBEAT_MS = 1_000;
const POSITION_STEP = 0.001;
const VELOCITY_STEP = 0.01;
const QUAT_STEP = 0.0001;
const OWNER_TELEPORT_METRES = 8;

const quantize = (n: number, step: number): number => Math.round(n / step) * step;
const vector = (v: PlayerVec3, step: number): PlayerVec3 =>
  [quantize(v[0], step), quantize(v[1], step), quantize(v[2], step)];
const direction = (v: PlayerVec3): PlayerVec3 => {
  const out = vector(v, QUAT_STEP);
  const length = Math.hypot(...out) || 1;
  return out.map(n => n / length) as PlayerVec3;
};
const quaternion = (q: PlayerQuat): PlayerQuat => {
  const out: PlayerQuat = [
    quantize(q[0], QUAT_STEP), quantize(q[1], QUAT_STEP),
    quantize(q[2], QUAT_STEP), quantize(q[3], QUAT_STEP),
  ];
  const length = Math.hypot(...out) || 1;
  return out.map(n => n / length) as PlayerQuat;
};
const transform = (t: PlayerTransform): PlayerTransform =>
  ({ p: vector(t.p, POSITION_STEP), q: quaternion(t.q) });
const gesture = (source: NonNullable<LocalPlayerPose['gesture']>): NonNullable<LocalPlayerPose['gesture']> => ({
  kind: 'point', hand: source.hand, id: source.id,
  direction: direction(source.direction),
  ...(source.target ? { target: vector(source.target, POSITION_STEP) } : {}),
});
const equipment = (source: LocalPlayerEquipmentPose): LocalPlayerEquipmentPose => ({
  state: source.state,
  transform: transform(source.transform),
  velocity: vector(source.velocity, VELOCITY_STEP),
  epoch: Number.isSafeInteger(source.epoch) && source.epoch >= 0 ? source.epoch : 0,
});

function prepare(source: LocalPlayerPose): LocalPlayerPose {
  return {
    mode: source.mode, vr: source.vr,
    ...(source.gear ? { gear: source.gear } : {}),
    ...(source.stance ? { stance: source.stance } : {}),
    body: transform(source.body), velocity: vector(source.velocity, VELOCITY_STEP),
    ...(source.animation ? { animation: {
      grounded: source.animation.grounded,
      crouch: quantize(source.animation.crouch, QUAT_STEP),
      lean: quantize(source.animation.lean, QUAT_STEP),
      bank: quantize(source.animation.bank, 0.01),
      ...(source.animation.lead ? { lead: source.animation.lead } : {}),
      ...(source.animation.flying ? { flying: true } : {}),
    } } : {}),
    ...(source.gesture ? { gesture: gesture(source.gesture) } : {}),
    ...(source.gestures?.length ? { gestures: source.gestures.map(gesture) } : {}),
    ...(source.head ? { head: transform(source.head) } : {}),
    ...(source.hands ? { hands: source.hands.map(hand => hand ? transform(hand) : null) as LocalPlayerPose['hands'] } : {}),
    ...(source.equipment ? { equipment: equipment(source.equipment) } : {}),
  };
}

/**
 * Turns live scene state into a compact owner sample. Still poses reuse their last timestamp between one-second
 * heartbeats, so an idle editor costs almost nothing; a moving camera/board changes after millimetre quantization
 * and therefore publishes at the room's disposable-state cadence.
 */
export function createPlayerPosePublisher() {
  let seq = 0, teleport = 0;
  let equipmentTeleport = 0, equipmentSourceEpoch: number | null = null, equipmentPresent = false;
  let previous: PlayerPose | null = null;
  let key = '';

  function sample(source: LocalPlayerPose, avatar: string, sampleAt: number): PlayerPose {
    const clean = prepare(source);
    const nextKey = JSON.stringify({ ...clean, avatar });
    if (previous && nextKey === key && sampleAt - previous.sampleAt < HEARTBEAT_MS) return previous;

    if (previous) {
      const dt = Math.max(0, (sampleAt - previous.sampleAt) / 1000);
      const dx = clean.body.p[0] - previous.body.p[0];
      const dy = clean.body.p[1] - previous.body.p[1];
      const dz = clean.body.p[2] - previous.body.p[2];
      const oldSpeed = Math.hypot(...previous.velocity);
      // A real downhill interval may cover several metres. Only movement well beyond what either velocity can
      // explain is a teleport; explicit epochs then snap even short gate/OOB relocations once a caller reports one.
      const plausible = Math.max(OWNER_TELEPORT_METRES, oldSpeed * dt * 1.5 + 2);
      if (Math.hypot(dx, dy, dz) > plausible) teleport++;
    }
    const nextEquipmentPresent = !!clean.equipment;
    if (nextEquipmentPresent !== equipmentPresent
      || (clean.equipment && clean.equipment.epoch !== equipmentSourceEpoch)) equipmentTeleport++;
    equipmentPresent = nextEquipmentPresent;
    equipmentSourceEpoch = clean.equipment?.epoch ?? null;
    const wireEquipment: PlayerEquipmentPose | undefined = clean.equipment ? {
      state: clean.equipment.state, transform: clean.equipment.transform,
      velocity: clean.equipment.velocity, teleport: equipmentTeleport,
    } : undefined;
    const { equipment: _localEquipment, ...cleanPose } = clean;
    const published: PlayerPose = {
      version: 2, seq: seq++, sampleAt, teleport, avatar,
      ...cleanPose, ...(wireEquipment ? { equipment: wireEquipment } : {}),
    };
    previous = published;
    key = nextKey;
    return published;
  }

  return { sample };
}

export type PlayerPosePublisher = ReturnType<typeof createPlayerPosePublisher>;
