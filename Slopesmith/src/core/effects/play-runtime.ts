import type { V3 } from '../doc/types';
import type { EffectGraph, EffectNode, JsonObject, JsonValue } from './document';

/** One scheduled graph node. The host and metadata stay generic so the browser Play layer and deterministic
 * test runner execute the same wait/condition/thread ordering without either core module depending on Three.js. */
export interface EffectGraphTask<Host, Meta> {
  at: number;
  host: Host;
  node: EffectNode;
  depth: number;
  meta: Meta;
  thread: { active: boolean };
}

/** Queue a graph exactly as Play does: waits advance the shared thread clock, a failed condition suppresses
 * every later node in that thread, and tasks at the same timestamp retain graph order through stable sorting. */
export function scheduleEffectGraph<Host, Meta>(queue: EffectGraphTask<Host, Meta>[], host: Host,
  graph: Pick<EffectGraph, 'nodes'>, startAt: number, depth: number, meta: Meta): void {
  let at = startAt;
  let added = false;
  const thread = { active: true };
  for (const node of graph.nodes) {
    if (node.mainType === 4) {
      const wait = typeof node.payload.WaitTime === 'number' ? node.payload.WaitTime : 0;
      at += Math.max(0, Math.min(wait, 30));
      continue;
    }
    queue.push({ at, host, node, depth, meta, thread });
    added = true;
  }
  if (added) queue.sort((a, b) => a.at - b.at);
}

/** Drain every task due at `now`, including a due function/instance call queued by another due task. */
export function runScheduledEffectGraphs<Host, Meta>(queue: EffectGraphTask<Host, Meta>[], now: number,
  hooks: {
    condition(host: Host, node: EffectNode, meta: Meta): boolean;
    execute(host: Host, node: EffectNode, depth: number, meta: Meta): void;
  }): void {
  while (queue.length && queue[0].at <= now) {
    const task = queue.shift()!;
    if (!task.thread.active) continue;
    if (task.node.mainType === 5) task.thread.active = hooks.condition(task.host, task.node, task.meta);
    else hooks.execute(task.host, task.node, task.depth, task.meta);
  }
}

const conditionBits = new DataView(new ArrayBuffer(4));
function conditionFloat(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (Number.isInteger(value) && Math.abs(value) > 0x00ffffff) {
    conditionBits.setUint32(0, value >>> 0, true);
    return conditionBits.getFloat32(0, true);
  }
  return value;
}

function conditionWord(value: number): number {
  conditionBits.setFloat32(0, value, true);
  return conditionBits.getUint32(0, true);
}

/** The condition node shared by interactive Play and the deterministic autotest runner. Host motion is a
 * callback because browser Play owns scene objects while the headless runner owns only their observed state. */
export function effectConditionPasses(node: EffectNode, state: {
  riderSpeed: number;
  random?: () => number;
  humanRider?: boolean;
  hostIdle?: boolean;
}): boolean {
  const raw = object(node.payload.type5);
  if (!raw) return true;
  const mode = Math.trunc(finite(raw.U0, -1));
  const selector = finite(raw.U1);
  const value = conditionFloat(raw.U2);
  if (mode === 0) {
    // The board velocity is editor m/s; the native comparison is engine cm/s. Selector zero compares the raw
    // threshold directly, while the bit-exact word 1 takes the traced ×27.7778 branch. Any other selector is
    // the native fall-through (pass), including the tempting but incorrect authored float 1.0.
    const speedCm = state.riderSpeed * 100;
    if (selector === 0) return speedCm <= value;
    if (conditionWord(selector) === 1) return speedCm >= value * 27.7778;
    return true;
  }
  if (mode === 1) {
    const sample = (state.random ?? Math.random)();
    return selector === 0 ? sample <= value : sample > value;
  }
  if (mode === 2) return state.humanRider ?? true;
  if (mode === 3) return state.hostIdle ?? true;
  return true;
}

/** Proven runtime meaning of an effect node that Slopesmith can act on during a test ride. The raw node remains
 * authoritative; this is only the small, typed execution surface shared by the graph runner and its tests. */
export type EffectPlayCommand =
  | { kind: 'rider-reset' }
  | { kind: 'hud-message'; text: string; color: [number, number, number]; durationSeconds: number }
  | { kind: 'score-multiplier'; multiplier: number }
  | { kind: 'speed-boost'; amount: number }
  | { kind: 'trick-boost'; seconds: number }
  | { kind: 'teleport'; instance: string | null }
  | { kind: 'directional-boost'; target: number; rate: number; direction: V3 }
  | { kind: 'property-control'; command: number; value: number }
  | { kind: 'instance-hide' }
  | { kind: 'roller'; mass: number; direction: V3 }
  | { kind: 'mesh-throw'; frameStep: number; duration: number; direction: V3; velocityScale: V3; directionScale: number }
  | { kind: 'fence-flex'; amount: number }
  | { kind: 'flag-wave'; variant: number; amplitude: number; wavelength: number }
  | { kind: 'spline-motion'; spline: string | null; endMode: number; orientationMode: number;
      instanceCount: number; speed: number; yawOffset: number;
      /** Optional untextured line drawn over the referenced route. A gondola cable is one use, not its identity. */
      splineLine: { enabled: boolean; color: [number, number, number, number] } };

/**
 * The pickup pop shared with the Unity runtimes: disappear immediately, hold long enough for the rider to
 * clear the trigger, then ease back to full size. Keeping the timing and curve here makes browser Play and
 * its deterministic tests agree without teaching the graph scheduler about renderer state.
 */
export const PICKUP_POP_HOLD_SECONDS = 0.5;
export const PICKUP_GROW_SECONDS = 1.2;
export const PICKUP_POP_SECONDS = PICKUP_POP_HOLD_SECONDS + PICKUP_GROW_SECONDS;
/** Unity's transient-world convergence timers (AnimatedPropU / BreakableLogoU). */
export const ANIMATED_PROP_AUTO_RESET_SECONDS = 8;
export const BREAKABLE_RESPAWN_SECONDS = 12;
/** Shared-world convergence extension: unlike a persistent retail Roller, a knocked Slopesmith prop returns
 * home with the breakable cycle so a missed event or late join cannot leave clients permanently divergent. */
export const MOVABLE_PROP_RESPAWN_SECONDS = BREAKABLE_RESPAWN_SECONDS;

/** Scale of a popped pickup `secondsAfterHit` into its cycle (Unity's Mathf.SmoothStep(0, 1, p)). */
export function pickupPopScale(secondsAfterHit: number): number {
  if (!Number.isFinite(secondsAfterHit) || secondsAfterHit <= PICKUP_POP_HOLD_SECONDS) return 0;
  if (secondsAfterHit >= PICKUP_POP_SECONDS) return 1;
  const p = (secondsAfterHit - PICKUP_POP_HOLD_SECONDS) / PICKUP_GROW_SECONDS;
  return p * p * (3 - 2 * p);
}

export interface SplineMotionStep {
  distance: number;
  direction: number;
  stopped: boolean;
  /** Native end mode 0 marks the mover complete; mode 3 merely holds it at the end. */
  finished: boolean;
}

export const SPLINE_END_MODE_OPTIONS = [
  { value: 0, label: 'One-shot (finish)' },
  { value: 1, label: 'Loop (wrap)' },
  { value: 2, label: 'Ping-pong' },
  { value: 3, label: 'Hold at end' },
] as const;

export const SPLINE_ORIENTATION_MODE_OPTIONS = [
  { value: 0, label: 'Follow yaw + pitch' },
  { value: 1, label: 'Follow yaw, stay level' },
  { value: 2, label: 'Fixed yaw, follow pitch' },
  { value: 3, label: 'Fixed orientation' },
] as const;

export function splineEndModeLabel(mode: number): string {
  const option = SPLINE_END_MODE_OPTIONS.find(candidate => candidate.value === Math.trunc(mode));
  return option?.label ?? `Loop (native fallback from ${Math.trunc(mode)})`;
}

export function splineOrientationModeLabel(mode: number): string {
  const option = SPLINE_ORIENTATION_MODE_OPTIONS.find(candidate => candidate.value === Math.trunc(mode));
  return option?.label ?? `Follow yaw + pitch (native fallback from ${Math.trunc(mode)})`;
}

/** Native modes 2/3 suppress tangent yaw; modes 1/3 suppress tangent pitch. Every other integer aliases mode 0. */
export function splineOrientationAxes(mode: number): { followYaw: boolean; followPitch: boolean } {
  const value = Math.trunc(mode);
  return { followYaw: value !== 2 && value !== 3, followPitch: value !== 1 && value !== 3 };
}

/** Build the yaw/pitch used by the Three.js preview from a normalized forward path tangent. The native ping-pong
 * return leg adds its direction flip even when tangent yaw is otherwise suppressed. */
export function splineOrientationAngles(tangent: V3, direction: number, endMode: number,
  mode: number, yawOffset: number): { yaw: number; pitch: number } {
  const axes = splineOrientationAxes(mode);
  const travelSign = direction < 0 ? -1 : 1;
  const reverseYaw = endMode === 2 && travelSign < 0 ? Math.PI : 0;
  return {
    yaw: (axes.followYaw ? Math.atan2(tangent[0], tangent[2]) : 0) + reverseYaw - yawOffset,
    pitch: axes.followPitch ? -tangent[1] * travelSign : 0,
  };
}

export const ROLLER_PREVIEW_IMPACT_SPEED = 12;

/** Fixed-strength editor collision proxy; only its horizontal approach direction varies between previews. */
export function rollerPreviewImpact(random: () => number = Math.random): V3 {
  const angle = random() * Math.PI * 2;
  return [Math.cos(angle) * ROLLER_PREVIEW_IMPACT_SPEED, 0, Math.sin(angle) * ROLLER_PREVIEW_IMPACT_SPEED];
}

/** Advance the native spline-animation cursor. At the forward end: 0 finishes, 2 reverses, 3 holds, and every
 * other integer wraps. At the starting end only mode 2 reverses; all other modes clamp there. */
export function stepSplineMotionDistance(distance: number, direction: number, speed: number,
  dt: number, length: number, endMode: number): SplineMotionStep {
  if (!(length > 0)) return { distance: 0, direction, stopped: true, finished: false };
  const travel = Math.abs(speed) * Math.max(0, dt);
  let next = distance + travel * direction;
  let nextDirection = direction;
  if (endMode === 2) {
    const cycle = length * 2;
    const routePhase = direction >= 0 ? distance : cycle - distance;
    const phase = (((routePhase + travel) % cycle) + cycle) % cycle;
    if (phase > length) {
      next = cycle - phase;
      nextDirection = -1;
    } else {
      next = phase;
      nextDirection = 1;
    }
    if (next <= 1e-8) nextDirection = 1;
    else if (next >= length - 1e-8) nextDirection = -1;
    return { distance: next, direction: nextDirection, stopped: false, finished: false };
  }
  if (next < 0) return { distance: 0, direction: nextDirection, stopped: true, finished: false };
  if (next < length) return { distance: next, direction: nextDirection, stopped: false, finished: false };
  if (endMode === 0) return { distance: length, direction: nextDirection, stopped: true, finished: true };
  if (endMode === 3) return { distance: length, direction: nextDirection, stopped: true, finished: false };
  next %= length; // Mode 1 and every value outside 0..3 take the native forward-wrap fallback.
  return { distance: next, direction: nextDirection, stopped: false, finished: false };
}

/** Arc-length positions for the native mover's shared model copies. Copy zero owns the route cursor; every
 * additional copy is offset by total length / count and wraps independently. A cursor exactly at the forward
 * endpoint stays there (not at zero), matching the specified held/finishing pose [Trailmap: 230-level-ssf]. */
export function splineMotionCopyDistances(distance: number, length: number, instanceCount: number): number[] {
  const count = Math.max(1, Math.trunc(instanceCount));
  if (!(length > 0)) return Array.from({ length: count }, () => 0);
  const cursor = Math.max(0, Math.min(length, distance));
  const spacing = length / count;
  return Array.from({ length: count }, (_, index) => {
    let sample = cursor + spacing * index;
    if (sample > length) sample %= length;
    return sample;
  });
}

const object = (value: JsonValue | undefined): JsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
const finite = (value: JsonValue | undefined, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const unit = (value: JsonValue | undefined, fallback = 1): number =>
  Math.max(0, Math.min(1, finite(value, fallback)));
const vec3 = (value: JsonObject | null, keys: readonly string[]): V3 => [
  finite(value?.[keys[0]]), finite(value?.[keys[1]]), finite(value?.[keys[2]]),
];

/** Decode only semantics established by the RE/spec. Unknown, receiver-dependent, and unauthored operations
 * deliberately return null instead of gaining plausible-but-invented behavior. */
export function effectPlayCommand(node: EffectNode): EffectPlayCommand | null {
  const type0 = object(node.payload.type0);
  if (node.mainType === 3 || node.mainType === 9) {
    const control = object(node.mainType === 3 ? node.payload.type3 : node.payload.type9);
    if (control) return {
      kind: 'property-control', command: Math.trunc(finite(control.U0)), value: finite(control.U1),
    };
  }
  switch (node.semanticType) {
    case 'rider.reset': return { kind: 'rider-reset' };
    case 'hud.message': {
      const text = typeof node.payload.HudText === 'string' ? node.payload.HudText.trim() : '';
      if (!text) return null;
      return {
        kind: 'hud-message', text,
        color: [unit(node.payload.HudRed), unit(node.payload.HudGreen), unit(node.payload.HudBlue)],
        // The patched retail HUD owns this lifetime; keeping the preview identical makes an autotest cell
        // legible without turning the debug message into persistent editor state.
        durationSeconds: 2.5,
      };
    }
    case 'score.multiplier': return {
      kind: 'score-multiplier', multiplier: Math.max(1, finite(node.payload.MultiplierScore, 1)),
    };
    case 'rider.boost': return { kind: 'speed-boost', amount: Math.max(0, finite(node.payload.type17)) };
    case 'trick.boost':
    case 'rider.trick-window':
      return { kind: 'trick-boost', seconds: Math.max(0, finite(node.payload.type18)) };
    case 'rider.teleport': return { kind: 'teleport', instance: node.references?.instance ?? null };
    case 'property.breakable-kill': return { kind: 'instance-hide' };
    case 'property.roller': {
      const roller = object(type0?.type0Sub0);
      const mass = finite(roller?.U0);
      if (mass <= 0) return null;
      return {
        kind: 'roller', mass,
        direction: vec3(roller, ['U3', 'U4', 'U5']),
      };
    }
    case 'property.boost': {
      // The node drives speed along a fixed world axis toward a target as a first-order lag, rather than
      // delivering an impulse ([Trailmap: 360-node-apply]). Mode and window govern the node's lifetime, which
      // the test ride does not model — it runs the push straight off a contact — so neither reaches the command.
      const boost = object(type0?.Boost);
      return {
        kind: 'directional-boost',
        target: Math.max(0, finite(boost?.BoostAmount)),
        rate: Math.max(0, finite(boost?.U2)),
        direction: vec3(object(boost?.BoostDir), ['X', 'Y', 'Z']),
      };
    }
    case 'property.mesh-animation': {
      const mesh = object(type0?.type0Sub20);
      return {
        kind: 'mesh-throw',
        frameStep: Math.max(0, finite(mesh?.U1)), duration: Math.max(0, finite(mesh?.U2)),
        direction: vec3(mesh, ['U3', 'U4', 'U5']), velocityScale: vec3(mesh, ['U6', 'U7', 'U8']),
        directionScale: finite(mesh?.U9, 1),
      };
    }
    case 'property.fence': {
      const fence = object(type0?.Fence);
      return { kind: 'fence-flex', amount: Math.max(0, finite(fence?.FlexAmmount)) };
    }
    case 'property.flag': {
      const flag = object(type0?.type0Sub13);
      return {
        kind: 'flag-wave', variant: Math.trunc(finite(flag?.U0)),
        amplitude: finite(flag?.U1), wavelength: finite(flag?.U2),
      };
    }
    case 'spline.animation': {
      const spline = object(object(node.payload.type2)?.SplineAnimation);
      return {
        kind: 'spline-motion', spline: node.references?.spline ?? null,
        endMode: Math.trunc(finite(spline?.U1)), orientationMode: Math.trunc(finite(spline?.U2)),
        instanceCount: Math.max(1, Math.trunc(finite(spline?.InstanceCount, 1))),
        speed: finite(spline?.AnimationSpeed), yawOffset: finite(spline?.U5),
        splineLine: {
          enabled: finite(spline?.U6) !== 0,
          color: [finite(spline?.R), finite(spline?.G), finite(spline?.B), finite(spline?.U7)],
        },
      };
    }
  }
  return null;
}
