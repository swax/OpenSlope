import type { RaceMode } from '../doc/race';

/** Which throwaway Play world an interaction belongs to. Authored interactions are already scoped by the
 * project room; a reference also needs its level name because each browser chooses that study world locally. */
export type RideEventTarget =
  | { kind: 'authored' }
  | { kind: 'reference'; level: string };

/** The external roots the Play effects runtime can replay without pretending a remote board collided locally. */
export type RideEventKind = 'collision' | 'trigger' | 'cracked' | 'cracked-heal' | 'cracked-break';

/** A locally accepted world interaction, before the session transport adds its clock sample. */
export interface RideEvent {
  target: RideEventTarget;
  mode: RaceMode;
  kind: RideEventKind;
  /** Stable Play binding key for a trigger, or stable object key for a collision / cracked break. */
  key: string;
  /** Monotonic within one browser tab. Combined with the server session id, this is the event identity. */
  id: number;
  /** The triggering rider's speed, so speed conditions evaluate identically on every recipient. */
  riderSpeed: number;
  /** Collision-only live frame. It keeps remote contact emitters and impact audio at the sender's hit. */
  contact?: { point: [number, number, number]; normal: [number, number, number] };
}

/** Client-to-server spelling. `sentAt` uses the continuously refined session-server clock. */
export interface RideEventMessage extends RideEvent { sentAt: number }

/** Server-to-client spelling. Project and sender identity are facts supplied by the authenticated session. */
export interface SharedRideEvent extends RideEventMessage {
  projectId: string;
  fromSessionId: string;
  serverAt: number;
}

const MODES = new Set<RaceMode>(['race', 'showoff', 'freeride']);
const KINDS = new Set<RideEventKind>(['collision', 'trigger', 'cracked', 'cracked-heal', 'cracked-break']);
const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // eslint-disable-next-line no-control-regex -- rejects control characters in a client-supplied event string
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
};

const finiteVec3 = (value: unknown, maxAbs: number): [number, number, number] | null => {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out = value.map(Number);
  return out.every(component => Number.isFinite(component) && Math.abs(component) <= maxAbs)
    ? out as [number, number, number] : null;
};

/** Validate the deliberately small untrusted event payload before it can be relayed to a room. */
export function sanitizeRideEventMessage(value: unknown, serverNow = Date.now()): RideEventMessage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RideEventMessage>;
  if (!raw.target || typeof raw.target !== 'object') return null;
  let target: RideEventTarget;
  if (raw.target.kind === 'authored') target = { kind: 'authored' };
  else if (raw.target.kind === 'reference') {
    const level = clean(raw.target.level, 64);
    if (!level) return null;
    target = { kind: 'reference', level };
  } else return null;
  const key = clean(raw.key, 512);
  const id = Number(raw.id), riderSpeed = Number(raw.riderSpeed), saidAt = Number(raw.sentAt);
  if (!key || !MODES.has(raw.mode as RaceMode) || !KINDS.has(raw.kind as RideEventKind)
    || !Number.isSafeInteger(id) || id < 0
    || !Number.isFinite(riderSpeed) || riderSpeed < 0 || riderSpeed > 500
    || !Number.isFinite(saidAt)) return null;
  // A skewed clock must not manufacture an event far in the past/future. The server receive time is the safe
  // fallback; healthy clients normally land within a few hundred milliseconds through the same NTP estimate as poses.
  const sentAt = Math.abs(saidAt - serverNow) <= 30_000 ? saidAt : serverNow;
  let contact: RideEvent['contact'];
  if (raw.contact !== undefined) {
    if (raw.kind !== 'collision' || !raw.contact || typeof raw.contact !== 'object') return null;
    const point = finiteVec3(raw.contact.point, 1_000_000);
    const normal = finiteVec3(raw.contact.normal, 1.001);
    const normalLength = normal ? Math.hypot(...normal) : 0;
    if (!point || !normal || normalLength < 0.5 || normalLength > 1.5) return null;
    contact = { point, normal: normal.map(component => component / normalLength) as [number, number, number] };
  }
  return { target, mode: raw.mode as RaceMode, kind: raw.kind as RideEventKind, key, id, riderSpeed,
    ...(contact ? { contact } : {}), sentAt };
}

export function sameRideEventTarget(a: RideEventTarget, b: RideEventTarget): boolean {
  return a.kind === b.kind && (a.kind === 'authored' || (b.kind === 'reference' && a.level === b.level));
}
