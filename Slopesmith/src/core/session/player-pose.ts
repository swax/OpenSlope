import { builtinCharacter } from '../characters/builtins';

/** Disposable world-space state used to draw one participant on another browser. */
export type PlayerMode = 'edit' | 'walk' | 'ride';
/** What a participant is riding on — the wire spelling of `app/ride/gear.ts`'s `RideGear`, which is defined
 *  from this so a peer can never be drawn on kit its owner is not on. */
export type PlayerGear = 'snowboard' | 'skis';
export type PlayerSnowboardStance = 'standard' | 'goofy';
export type PlayerVec3 = [number, number, number];
export type PlayerQuat = [number, number, number, number];

export interface PlayerTransform {
  p: PlayerVec3;
  q: PlayerQuat;
}

export type PlayerEquipmentState = 'mounted' | 'loose' | 'held';

/** The owner's board or skis as an independently moving world object. Unlike the rider root, loose equipment
 * may keep coasting after its owner has stopped, and held equipment follows a tracked hand rather than the body. */
export interface PlayerEquipmentPose {
  state: PlayerEquipmentState;
  transform: PlayerTransform;
  velocity: PlayerVec3;
  /** Owner-local discontinuity epoch, separate from a rider teleport because the equipment can relocate alone. */
  teleport: number;
}

/** Before the publisher converts a session's local lifecycle counter into the wire teleport epoch. */
export interface LocalPlayerEquipmentPose extends Omit<PlayerEquipmentPose, 'teleport'> {
  epoch: number;
}

export interface PlayerPointGesture {
  kind: 'point';
  hand: 'left' | 'right';
  /** Captured world-space ray. It does not continue following the owner's head after the press. */
  direction: PlayerVec3;
  /** Exact world-space surface point under the click. Ray-only points may omit this and replay `direction`. */
  target?: PlayerVec3;
  /** Owner-local hold-generation id, retained for the legacy one-shot field. */
  id: number;
}

/** At most one held point per anatomical hand. */
export type PlayerPointGestures = PlayerPointGesture[];

/**
 * A pose is an owner-authoritative sample, not durable project data. `sampleAt` uses the session server clock,
 * which lets a receiver dead-reckon through both halves of the network trip instead of only the time since the
 * packet happened to arrive locally.
 */
export interface PlayerPose {
  version: 2;
  seq: number;
  sampleAt: number;
  teleport: number;
  mode: PlayerMode;
  vr: boolean;
  avatar: string;
  /** Absent selects the default snowboard appearance; nobody on foot is implied to be mounted on it. */
  gear?: PlayerGear;
  /** The snowboard foot order. Irrelevant while skiing or walking, but carried so mounted peers mirror the body. */
  stance?: PlayerSnowboardStance;
  body: PlayerTransform;
  velocity: PlayerVec3;
  /** Production rider-solver inputs that make crouch, carve and airborne body motion match the owner. */
  animation?: { grounded: boolean; crouch: number; lean: number; bank: number; lead?: 1 | -1; flying?: boolean };
  /** The headset/camera when it is meaningful. A desktop rider leaves this absent: the chase camera is not them. */
  head?: PlayerTransform;
  /** Canonical wrist transforms (+Y fingers, +Z palm). Slots remain unnamed; IK assigns them by shoulder. */
  hands?: [PlayerTransform | null, PlayerTransform | null];
  /** Primary point, retained beside `gestures` for renderers that need only one arm. */
  gesture?: PlayerPointGesture;
  /** Desktop mouse-button holds. Current peers use this plural field so both hands can be up together. */
  gestures?: PlayerPointGestures;
  /** Present throughout Play: mounted under the rider, loose on the mountain, or carried in a VR hand. */
  equipment?: PlayerEquipmentPose;
}

/** A local pose before the publisher adds transport identity and timing. */
export interface LocalPlayerPose extends Omit<PlayerPose,
  'version' | 'seq' | 'sampleAt' | 'teleport' | 'avatar' | 'equipment'> {
  equipment?: LocalPlayerEquipmentPose;
}

const finite = (n: unknown, limit: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit;

function vec3(value: unknown, limit: number): PlayerVec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(n => finite(n, limit))) return null;
  return [value[0], value[1], value[2]];
}

function quat(value: unknown): PlayerQuat | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(n => finite(n, 2))) return null;
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length < 1e-5) return null;
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length];
}

function transform(value: unknown): PlayerTransform | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { p?: unknown; q?: unknown };
  const p = vec3(raw.p, 1_000_000), q = quat(raw.q);
  return p && q ? { p, q } : null;
}

function pointGesture(value: unknown): PlayerPointGesture | null {
  if (!value || typeof value !== 'object') return null;
  const g = value as Partial<PlayerPointGesture>;
  if (g.kind !== 'point' || (g.hand !== 'left' && g.hand !== 'right')
    || !Number.isSafeInteger(g.id) || Number(g.id) < 0) return null;
  const direction = vec3(g.direction, 1);
  const target = g.target === undefined ? undefined : vec3(g.target, 1_000_000);
  if (!direction || (g.target !== undefined && !target)) return null;
  const length = Math.hypot(...direction);
  if (length < 1e-5) return null;
  return {
    kind: 'point', hand: g.hand, id: Number(g.id),
    direction: direction.map(n => n / length) as PlayerVec3,
    ...(target ? { target } : {}),
  };
}

/** Validate untrusted wire state and normalize every quaternion before it reaches a renderer. */
export function sanitizePlayerPose(value: unknown, serverNow = Date.now()): PlayerPose | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PlayerPose>;
  if (raw.version !== 2 || (raw.mode !== 'edit' && raw.mode !== 'walk' && raw.mode !== 'ride')) return null;
  const body = transform(raw.body), velocity = vec3(raw.velocity, 500);
  const avatar = typeof raw.avatar === 'string' ? raw.avatar : '';
  const builtIn = builtinCharacter(avatar);
  if (!body || !velocity || !avatar
    || (avatar !== 'procedural' && !builtIn && !/^[^/\\]{1,150}\.glb$/i.test(avatar))) return null;
  const seq = Number(raw.seq), teleport = Number(raw.teleport), saidAt = Number(raw.sampleAt);
  if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(teleport) || teleport < 0) return null;
  // A badly skewed/malicious timestamp must not buy minutes of extrapolation. A real client is clock-synced by
  // the channel; its sample is normally within a few hundred ms of the server.
  const sampleAt = Number.isFinite(saidAt) && Math.abs(saidAt - serverNow) <= 30_000 ? saidAt : serverNow;
  const head = raw.head === undefined ? undefined : transform(raw.head);
  if (raw.head !== undefined && !head) return null;
  let equipment: PlayerEquipmentPose | undefined;
  if (raw.equipment !== undefined) {
    const source = raw.equipment as Partial<PlayerEquipmentPose>;
    const equipmentTransform = transform(source.transform);
    const equipmentVelocity = vec3(source.velocity, 500);
    const equipmentTeleport = Number(source.teleport);
    if ((source.state !== 'mounted' && source.state !== 'loose' && source.state !== 'held')
      || !equipmentTransform || !equipmentVelocity
      || !Number.isSafeInteger(equipmentTeleport) || equipmentTeleport < 0) return null;
    equipment = {
      state: source.state, transform: equipmentTransform,
      velocity: equipmentVelocity, teleport: equipmentTeleport,
    };
  }
  // In this protocol a ride always owns visible mounted kit, while edit has no Play-world equipment. Walking
  // may briefly omit it only if a future locomotion owner has no board at all.
  if ((raw.mode === 'ride' && equipment?.state !== 'mounted')
    || (raw.mode !== 'ride' && equipment?.state === 'mounted')
    || (raw.mode === 'edit' && equipment)) return null;
  let hands: PlayerPose['hands'];
  if (raw.hands !== undefined) {
    if (!Array.isArray(raw.hands) || raw.hands.length !== 2) return null;
    const a = raw.hands[0] === null ? null : transform(raw.hands[0]);
    const b = raw.hands[1] === null ? null : transform(raw.hands[1]);
    if ((raw.hands[0] !== null && !a) || (raw.hands[1] !== null && !b)) return null;
    hands = [a, b];
  }
  let animation: PlayerPose['animation'];
  if (raw.animation !== undefined) {
    const a = raw.animation;
    if (!a || typeof a !== 'object' || typeof a.grounded !== 'boolean'
      || !finite(a.crouch, 2) || !finite(a.lean, 2) || !finite(a.bank, 360)
      || (a.lead !== undefined && a.lead !== 1 && a.lead !== -1)
      || (a.flying !== undefined && typeof a.flying !== 'boolean')) return null;
    animation = {
      grounded: a.grounded,
      crouch: Math.max(-1, Math.min(1, a.crouch)),
      lean: Math.max(-1, Math.min(1, a.lean)),
      bank: a.bank,
      ...(a.lead === 1 || a.lead === -1 ? { lead: a.lead } : {}),
      ...(a.flying ? { flying: true } : {}),
    };
  }
  let gesture: PlayerPose['gesture'];
  if (raw.gesture !== undefined) {
    gesture = pointGesture(raw.gesture) ?? undefined;
    if (!gesture) return null;
  }
  let gestures: PlayerPose['gestures'];
  if (raw.gestures !== undefined) {
    if (!Array.isArray(raw.gestures) || raw.gestures.length > 2) return null;
    gestures = [];
    const hands = new Set<'left' | 'right'>();
    for (const value of raw.gestures) {
      const held = pointGesture(value);
      if (!held || hands.has(held.hand)) return null;
      hands.add(held.hand);
      gestures.push(held);
    }
  }
  return {
    version: 2, seq, sampleAt, teleport, mode: raw.mode, vr: raw.vr === true,
    avatar: builtIn?.id ?? avatar, body, velocity,
    ...(raw.gear === 'skis' || raw.gear === 'snowboard' ? { gear: raw.gear } : {}),
    ...(raw.stance === 'standard' || raw.stance === 'goofy' ? { stance: raw.stance } : {}),
    ...(animation ? { animation } : {}),
    ...(gesture ? { gesture } : {}), ...(gestures?.length ? { gestures } : {}),
    ...(head ? { head } : {}), ...(hands ? { hands } : {}), ...(equipment ? { equipment } : {}),
  };
}
