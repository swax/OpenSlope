import type { V3 } from '../doc/types';
import { collisionSoundEventIds, collisionSoundLabel, collisionSoundSource, resolveCollisionSound } from './collision-sound';
import { FIXED_EXTERNAL_BANKS } from './external-sound-banks.generated';

/**
 * One native ADL `Sounds.ExternalSounds` record, decoded without throwing away the type-specific tail.
 * `params` starts at native U5: type 0 = [radius, curve], type 1/2 = [U5..U11], and type 3 = [radius].
 * Keeping that tail intact gives a future custom-prop editor one stable, round-trippable model while the
 * semantic helpers below expose only fields whose runtime meaning is currently pinned down.
 */
export interface ExternalSoundEmitter {
  type: number;
  /** Global ADL event id (the same id space used by prop collision sounds). */
  sound: number;
  /** World-axis offset from the owning instance, native centimetres. */
  offset: V3;
  /** Type-specific native values beginning with U5. */
  params: number[];
}

/**
 * The **interactive ambient class**: three ordinary group-2 events whose placed emitters are hit-gated rather
 * than proximity-only — 16 on cars, 28 on fire hydrants, 57 on police cars. A placed record carrying one of
 * these is SILENT until the rider first hits its owning instance, and then sounds for the rest of the run.
 * Membership is engine-fixed, not authored: every other placed event, the floodlight hum (68) included, plays
 * on listener proximity alone. [Trailmap: 420-interactive-ambient]
 */
const INTERACTIVE_AMBIENT_EVENTS: ReadonlySet<number> = new Set([16, 28, 57]);

/** Whether an emitter event is hit-gated rather than heard on proximity alone. */
export const isInteractiveAmbientEvent = (eventId: number): boolean =>
  INTERACTIVE_AMBIENT_EVENTS.has(Math.trunc(eventId));

/**
 * The three ids in the order a mountain CLAIMS them for its own uploaded loops.
 *
 * There are three because the engine's classifier is three literal compares against these values — not a
 * table, not a flag on the record, and nothing a level can extend. So a custom WAV becomes hit-gated only by
 * taking over one of these ids, which also takes over the course-bank slot that id resolves to.
 * [Trailmap: 420-interactive-ambient]
 */
export const HIT_GATED_EVENT_POOL: readonly number[] = [16, 28, 57];

/**
 * The gated event one uploaded WAV has claimed on this mountain, or -1 for none.
 *
 * The claim IS the ordered list: position 0 takes 16, 1 takes 28, 2 takes 57. Deriving the id from position
 * rather than storing it means the editor and the export allocate identically without coordinating, a file
 * cannot hold two ids, and an id cannot be held by two files.
 *
 * Positions are STABLE: releasing a claim blanks its slot rather than closing the gap, because compacting
 * would slide every later claim onto a different event id — and so onto a different course-bank slot, which
 * silently changes which retail props a still-claimed file overrides.
 */
export function hitGatedEventForFile(file: string | undefined,
  claims: readonly string[] | undefined): number {
  if (!file) return -1;
  const index = claims?.indexOf(file) ?? -1;
  return index >= 0 && index < HIT_GATED_EVENT_POOL.length ? HIT_GATED_EVENT_POOL[index] : -1;
}

/**
 * The event id an authored prop's ambience effectively carries.
 *
 * An uploaded WAV supplies the CLIP; the event supplies the ROUTING. A claimed file therefore keeps its own
 * sound while behaving as the gated event it took over, and an unclaimed one stays on the ordinary reserved
 * pool the export allocates later — which is never gated, because the classifier does not test those ids.
 */
export function authoredAmbientEvent(event: number | undefined, file: string | undefined,
  claims: readonly string[] | undefined): number {
  const claimed = hitGatedEventForFile(file, claims);
  if (claimed >= 0) return claimed;
  return typeof event === 'number' ? event : -1;
}

export type ResolvedExternalSound =
  | { kind: 'course'; slot: number }
  | { kind: 'crowd'; slot: number }
  | { kind: 'fixed'; bank: string; slot: 0 };

/** Resolve the complete context-free ExternalSounds event space: fixed global environment banks first,
 * followed by the ordinary course/crowd event resolver. */
export function resolveExternalSound(eventId: number, level?: string): ResolvedExternalSound | null {
  const id = Math.trunc(eventId);
  const fixedBank = FIXED_EXTERNAL_BANKS[id];
  if (fixedBank) return { kind: 'fixed', bank: fixedBank, slot: 0 };
  const ordinary = resolveCollisionSound(id, level);
  return ordinary ? { kind: ordinary.bank, slot: ordinary.slot } : null;
}

/** Every resolvable ExternalSounds event, ascending — the emitter picker's option list. The fixed global
 * banks are joined by the ordinary course/crowd ids, because an emitter event that names no fixed bank falls
 * through to the same resolver a collision event uses. */
export function externalSoundEventIds(level?: string): number[] {
  return [...new Set([...Object.keys(FIXED_EXTERNAL_BANKS).map(Number), ...collisionSoundEventIds(level)])]
    .sort((a, b) => a - b);
}

/** Short display label for an emitter event: the fixed bank's own name where it has one — these are
 * self-describing, which is what makes them browsable — else the collision resolver's material reading. */
export function externalSoundLabel(eventId: number, level?: string): string {
  const id = Math.trunc(eventId);
  const fixed = FIXED_EXTERNAL_BANKS[id];
  const base = fixed ? `${id} — ${fixed}` : collisionSoundLabel(id, level);
  // Mark the interactive class wherever an event is browsed: picking one of these changes WHEN the loop is
  // heard, not just what it sounds like, and that is not something the id alone tells you.
  return isInteractiveAmbientEvent(id) ? `${base} (hit-gated)` : base;
}

/** Compact extracted WAV path for a native emitter. Snowdream's event 90, for example, resolves to
 * `SNOW/Snowmachine/000.wav` rather than looking in the `snowdream1` course bank. */
export function externalSoundSource(level: string, eventId: number): string | null {
  const sourceLevel = level.trim().toUpperCase();
  if (!sourceLevel) return null;
  const resolved = resolveExternalSound(eventId, sourceLevel);
  if (!resolved) return null;
  if (resolved.kind === 'fixed') return `${sourceLevel}/${resolved.bank}/000.wav`;
  return collisionSoundSource(sourceLevel, eventId);
}

/**
 * What an authored prop's ambience is, in the units and axes the EDITOR works in — metres, and the same
 * axis convention as `prop.pos`.
 *
 * Authoring stops at the region forms whose every parameter has a settled meaning: the point sphere and the
 * axis-aligned ellipsoid, over the full six-curve falloff table. Type 2's angular gate has no stable label
 * yet and type 3 is placed nowhere in retail, so neither is offered — Slopesmith does not author data it
 * cannot also reproduce. [Trailmap: 420-audio-runtime]
 */
export interface AuthoredAmbientSpec {
  /** Global ADL event id, or -1 when an uploaded WAV supplies the clip instead. */
  event: number;
  /** Sphere radius in editor metres. Ignored when `halfExtents` is present. */
  radius: number;
  /** Falloff selector 0..5; linear (2) when absent, which is what the retail crowd emitters use. */
  falloff?: number;
  /** Present = an axis-aligned ellipsoid region (native type 1) with these half-extents in editor metres. */
  halfExtents?: V3;
}

/** Authored ambience is bounded to the same range the radius control has always offered, in metres. */
export const AUTHORED_AMBIENT_MIN_M = 5;
export const AUTHORED_AMBIENT_MAX_M = 250;
export const AUTHORED_AMBIENT_DEFAULT_M = 80;
/** The curve the authored contract has always emitted, and what an unset selector means. */
export const AUTHORED_AMBIENT_DEFAULT_CURVE = 2;

const clampMetres = (value: number | undefined, fallback: number): number =>
  Math.max(AUTHORED_AMBIENT_MIN_M,
    Math.min(AUTHORED_AMBIENT_MAX_M, typeof value === 'number' && Number.isFinite(value) ? value : fallback));

const clampCurve = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(5, Math.trunc(value))) : AUTHORED_AMBIENT_DEFAULT_CURVE;

/**
 * The authored spec as an emitter measured in EDITOR metres — what the viewport draws the cyan region from,
 * so the outline is the authored numbers themselves rather than a round trip through native units.
 */
export function authoredAmbientEmitter(spec: AuthoredAmbientSpec): ExternalSoundEmitter {
  const curve = clampCurve(spec.falloff);
  if (spec.halfExtents) {
    const [x, y, z] = spec.halfExtents;
    return {
      type: 1,
      sound: spec.event,
      offset: [0, 0, 0],
      // Axis-aligned by construction, written as the UNIT axis rather than a zero vector. Both read as "no
      // orientation to apply" here — the region maths short-circuits an axis already parallel to local +Z —
      // but retail ships only three type-1 records and every one carries a real axis, so a zero vector is
      // untested territory in an engine that may normalize it. A unit axis costs nothing and stays inside
      // what the shipped data demonstrates.
      params: [clampMetres(x, AUTHORED_AMBIENT_DEFAULT_M), clampMetres(y, AUTHORED_AMBIENT_DEFAULT_M),
        clampMetres(z, AUTHORED_AMBIENT_DEFAULT_M), 0, 0, 1, curve],
    };
  }
  return {
    type: 0,
    sound: spec.event,
    offset: [0, 0, 0],
    params: [clampMetres(spec.radius, AUTHORED_AMBIENT_DEFAULT_M), curve],
  };
}

/**
 * The same spec as the native `Sounds.ExternalSounds` payload the export stamps: raw SSX centimetres, and
 * the native axis order.
 *
 * Editor and native disagree on more than scale — editor `(x, y, z)` is native `(x, z, y)` — which a sphere
 * hides because it is permutation-invariant and an ellipsoid does not. Deriving both readings from one spec
 * here is what keeps the drawn region and the shipped record the same volume.
 */
export function authoredAmbientRecord(spec: AuthoredAmbientSpec): number[] {
  const editor = authoredAmbientEmitter(spec);
  const cm = (metres: number) => Math.round(metres * 100);
  if (editor.type === 1) {
    const [x, y, z] = editor.params;
    // The axis is identity in whichever frame it is read in, so it is written as native +Z rather than
    // carried across from the editor's — a rotation of nothing does not have an axis to convert.
    return [cm(x), cm(z), cm(y), 0, 0, 1, editor.params[6]];
  }
  return [cm(editor.params[0]), editor.params[1]];
}

export type ExternalSoundShape =
  | { kind: 'sphere'; radius: number }
  | { kind: 'ellipsoid'; halfExtents: V3; axis: V3 };

const finitePositive = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The listener-region boundary that is safe to draw from the recovered runtime contract. */
export function externalSoundShape(emitter: ExternalSoundEmitter): ExternalSoundShape | null {
  if (emitter.type === 1) {
    if (!finitePositive(emitter.params[0]) || !finitePositive(emitter.params[1])
      || !finitePositive(emitter.params[2])) return null;
    return {
      kind: 'ellipsoid',
      halfExtents: [emitter.params[0], emitter.params[1], emitter.params[2]],
      axis: [emitter.params[3] ?? 0, emitter.params[4] ?? 0, emitter.params[5] ?? 0],
    };
  }
  // Type 2's directional/cone gate is not fully parameter-labelled yet, but U5 is its pinned radial bound.
  if (emitter.type === 0 || emitter.type === 2 || emitter.type === 3)
    return finitePositive(emitter.params[0]) ? { kind: 'sphere', radius: emitter.params[0] } : null;
  return null;
}

/** Recovered falloff selector, or null for the constant-gain/unknown forms. */
export function externalSoundFalloff(emitter: ExternalSoundEmitter): number | null {
  const raw = emitter.type === 0 ? emitter.params[1] : emitter.type === 1 ? emitter.params[6] : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : null;
}

/** Type reading for one placed record, which is the emitter's event as well as its region: a hit-gated event
 *  is still a point region, but calling it "continuing" would misdescribe when it is heard. */
export function externalSoundEmitterTypeLabel(emitter: ExternalSoundEmitter): string {
  return isInteractiveAmbientEvent(emitter.sound) && emitter.type === 0
    ? 'point · hit-gated' : externalSoundTypeLabel(emitter.type);
}

export function externalSoundTypeLabel(type: number): string {
  if (type === 0) return 'point · continuing';
  if (type === 1) return 'oriented ellipsoid · continuing';
  if (type === 2) return 'directional / cone · continuing';
  if (type === 3) return 'point · alternate voice';
  return `unknown type ${type}`;
}

export function externalSoundFalloffLabel(curve: number): string {
  return [
    '1 − d²',
    'rational distance',
    'linear (1 − d)',
    'rational inverse distance',
    '(1 − d)²',
    'flat to 70%, then linear',
  ][curve] ?? `unknown curve ${curve}`;
}

/** The six exact falloff choices over normalized distance `d` [Trailmap: 420-audio-runtime]. Index order and
 * formulas match `externalSoundFalloffLabel` above — they are two readings of the same recovered table. */
const FALLOFF_CURVES: readonly ((d: number) => number)[] = [
  d => 1 - d * d,
  d => 1 - d / (1.5 - 0.5 * d),
  d => 1 - d,
  d => (1 - d) / (1.5 - 0.5 * (1 - d)),
  d => (1 - d) * (1 - d),
  d => (d <= 0.7 ? 1 : (1 - d) / 0.3),
];

/**
 * Undo the emitter's orientation so an ellipsoid can be measured against its own half-extents.
 *
 * The recovered contract exposes one axis, and `soundRangeObject` draws the region by taking local +Z to it
 * through the minimal rotation. This applies that rotation's INVERSE by Rodrigues, so what is heard and what
 * is drawn are the same volume. An axis parallel to −Z is left unrotated on purpose: the true 180° turn maps
 * (x, y, z) to (x, −y, −z), and the normalized distance below squares each component, so the two agree.
 */
function unrotateFromAxis(delta: V3, axis: V3): V3 {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (length < 1e-8) return delta;
  const a: V3 = [axis[0] / length, axis[1] / length, axis[2] / length];
  // Rotation carrying `a` back onto +Z: axis k = normalize(a × z), cos = a·z.
  const cross: V3 = [a[1], -a[0], 0]; // a × (0,0,1)
  const sin = Math.hypot(cross[0], cross[1], cross[2]);
  if (sin < 1e-8) return delta; // already parallel to ±Z
  const k: V3 = [cross[0] / sin, cross[1] / sin, cross[2] / sin];
  const cos = a[2];
  const kCrossV: V3 = [
    k[1] * delta[2] - k[2] * delta[1],
    k[2] * delta[0] - k[0] * delta[2],
    k[0] * delta[1] - k[1] * delta[0],
  ];
  const kDotV = k[0] * delta[0] + k[1] * delta[1] + k[2] * delta[2];
  return [
    delta[0] * cos + kCrossV[0] * sin + k[0] * kDotV * (1 - cos),
    delta[1] * cos + kCrossV[1] * sin + k[1] * kDotV * (1 - cos),
    delta[2] * cos + kCrossV[2] * sin + k[2] * kDotV * (1 - cos),
  ];
}

/**
 * Listener distance normalized against the emitter's own region: 0 at its centre, 1 at its boundary, and
 * greater than 1 outside it. `delta` is listener minus emitter centre in the record's native units
 * (centimetres). Null when the record carries no usable region.
 */
export function externalSoundNormalizedDistance(emitter: ExternalSoundEmitter, delta: V3): number | null {
  const shape = externalSoundShape(emitter);
  if (!shape) return null;
  if (shape.kind === 'sphere') return Math.hypot(delta[0], delta[1], delta[2]) / shape.radius;
  const local = unrotateFromAxis(delta, shape.axis);
  return Math.hypot(
    local[0] / shape.halfExtents[0], local[1] / shape.halfExtents[1], local[2] / shape.halfExtents[2]);
}

/**
 * Authored listener gain for one placed emitter, 0 outside its region and 1 at its centre. `delta` is the
 * listener minus the emitter centre in native centimetres [Trailmap: 420-audio-runtime].
 *
 * Type 3 is constant-gain by contract rather than curved. Type 2's radial bound is pinned but the second,
 * angular term of its gate is not, so it sounds across its full radial range instead of guessing a cone —
 * no shipped level in the corpus authors one, so this decides nothing that ships.
 */
export function externalSoundGain(emitter: ExternalSoundEmitter, delta: V3): number {
  const d = externalSoundNormalizedDistance(emitter, delta);
  if (d === null || !Number.isFinite(d) || d >= 1) return 0;
  if (emitter.type === 3) return 1;
  const curve = FALLOFF_CURVES[externalSoundFalloff(emitter) ?? 2] ?? FALLOFF_CURVES[2];
  return Math.max(0, Math.min(1, curve(Math.max(0, d))));
}

/** The furthest a listener can be and still hear this emitter, native centimetres — the cull radius a
 * proximity scan needs. For an ellipsoid that is its longest half-extent, whatever its orientation. */
export function externalSoundReach(emitter: ExternalSoundEmitter): number {
  const shape = externalSoundShape(emitter);
  if (!shape) return 0;
  return shape.kind === 'sphere' ? shape.radius : Math.max(...shape.halfExtents);
}

/** One emitter placed in the level: its record plus the world-space centre that record resolves to. */
export interface ExternalSoundPlacement {
  /** Caller's identity for the emitter — returned as-is so a runtime can match a voice to its source. */
  key: string;
  emitter: ExternalSoundEmitter;
  /** Emitter centre in raw native centimetres: instance location plus the record's own offset. */
  center: V3;
  /**
   * Whether a hit-gated emitter has been armed by an impact on its owning instance. Ignored entirely for the
   * ordinary proximity events, so a caller that never arms anything keeps the old behaviour for all of them
   * and only silences the interactive class. [Trailmap: 420-interactive-ambient]
   */
  armed?: boolean;
}

export interface ExternalSoundVoice {
  key: string;
  /** Authored listener gain, 0 exclusive to 1 inclusive. */
  gain: number;
}

/**
 * Which placed emitters a listener can hear, loudest first.
 *
 * Retail visits one cell of a spatial grid; ranking the whole list by authored gain instead cannot drop a
 * near emitter behind a far one, and `limit` then caps concurrent voices. Ranking by GAIN rather than by
 * distance is the point: a wide quiet region and a tight loud one are not comparable by range, and gain is
 * what a listener actually notices. Everything here is raw native centimetres [Trailmap: 420-audio-runtime].
 */
export function externalSoundField(placements: readonly ExternalSoundPlacement[], listener: V3,
  limit = Number.POSITIVE_INFINITY): ExternalSoundVoice[] {
  const heard: ExternalSoundVoice[] = [];
  for (const placement of placements) {
    // The interactive class is inaudible at any range until its owner has been hit, however close the
    // listener stands [Trailmap: 420-interactive-ambient].
    if (!placement.armed && isInteractiveAmbientEvent(placement.emitter.sound)) continue;
    const reach = externalSoundReach(placement.emitter);
    if (reach <= 0) continue;
    const delta: V3 = [
      listener[0] - placement.center[0],
      listener[1] - placement.center[1],
      listener[2] - placement.center[2],
    ];
    // Cheap sphere reject before the real region: an ellipsoid never extends past its longest half-extent.
    if (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2] >= reach * reach) continue;
    const gain = externalSoundGain(placement.emitter, delta);
    if (gain > 0) heard.push({ key: placement.key, gain });
  }
  heard.sort((a, b) => b.gain - a.gain || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return Number.isFinite(limit) ? heard.slice(0, Math.max(0, limit)) : heard;
}
