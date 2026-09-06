import type * as THREE from 'three';
import { resolveCollisionSound, type CollisionSoundBank } from '../../../core/effects/collision-sound';
import type { PropInstance } from '../../../core/reference/props';
import type { RideObstacleObject } from '../../ride/physics';
import {
  createAmbientSoundLayer,
  type AmbientSoundHooks, type AmbientSoundLayer, type AmbientSoundSource,
} from './ambient-sound';

/**
 * What a PROP sounds, as opposed to what an effect graph sounds.
 *
 * Native SSX keeps both of these channels on the instance record in `Instances.json` — `Sounds.CollisonSound`
 * is the one-shot a contact fires, `Sounds.ExternalSounds` is the continuing ambience the placement carries.
 * Neither is an SSF node: the effect document is a separate file that BINDS to instances. So prop audio is
 * prop data that the effect runtime dispatches into, which is exactly the seam this module draws.
 *
 * Both channels live here together for one specific reason. They are driven by the SAME contact, in an order
 * that matters: retail registers a hit-gated emitter before it resolves the prop's own collision event to a
 * clip, so a prop whose collision row is the silent sentinel — every retail fire hydrant — still starts its
 * spray on a hit that makes no other sound [Trailmap: 420-interactive-gate]. Splitting the channels across
 * two modules would put that ordering back into the caller, where nothing enforces it. `contact` below is
 * the whole of it, and it cannot be got wrong from outside.
 *
 * The audio GRAPH is deliberately not owned here. One listener, one buffer cache and one voice pool serve
 * prop sounds, effect-graph PlaySound nodes and the ride alike; this module borrows them through `hooks` the
 * same way `ambient-sound` does, and keeps only the policy — which clip, how loud, how often, and whether a
 * gated emitter has been armed yet.
 */

/** Retail suppresses further sounds from the same object for currentTick + 50 (50/60 s)
 *  [Trailmap: 420-audio-runtime]. Exported because the collision-GRAPH dispatch in `reference-effects` gates
 *  on the same interval. */
export const COLLISION_SOUND_DEBOUNCE_SECONDS = 50 / 60;

/**
 * Arming identity for a prop, minted here so a contact and a placed emitter always agree on the spelling.
 *
 * Reference and authored props are indexed in disjoint spaces — a native instance index and a document id —
 * and prefixing keeps a reference instance 7 from arming an authored prop that happens to be called "7".
 */
export const referenceOwnerKey = (index: number): string => `ref:${index}`;
export const authoredOwnerKey = (id: string): string => `auth:${id}`;
export const propOwnerKey = (object: RideObstacleObject): string =>
  object.kind === 'reference' ? referenceOwnerKey(object.index) : authoredOwnerKey(object.id);

/**
 * Unity's three prop-contact paths use the same shape with different thresholds: nothing below `minSpeed`,
 * then a linear volume ramp to `fullSpeed`. Playback rate is deliberately untouched — impact speed changes
 * loudness, not pitch (`RideableBoard.PlayImpactSound`, `ContactSound.PlayForSpeed`, `PhysicsProp.Knock`).
 */
export type PropSoundContact = 'solid' | 'through' | 'movable';
const IMPACT_RESPONSE: Record<PropSoundContact, {
  minSpeed: number; fullSpeed: number; volumeFloor: number; volumeRange: number;
}> = {
  // A blocking collider: Unity's board impact path opens from silence at 2 m/s and is full at 16 m/s.
  solid: { minSpeed: 2, fullSpeed: 16, volumeFloor: 0, volumeRange: 1 },
  // A ride-through trigger keeps an audible floor once its gentler 0.5 m/s entry gate has been cleared.
  through: { minSpeed: 0.5, fullSpeed: 12, volumeFloor: 0.35, volumeRange: 0.65 },
  // A knocked physics prop uses the solid threshold but starts at its own 40% audible floor.
  movable: { minSpeed: 2, fullSpeed: 16, volumeFloor: 0.4, volumeRange: 0.6 },
};

export interface PropSoundHooks {
  /** Play a decoded buffer as a positional one-shot on the shared voice pool. */
  playOneShot(buffer: Promise<AudioBuffer | null>, position: THREE.Vector3, volume: number): void;
  /** A course/crowd bank slot's decoded buffer. */
  bankBuffer(level: string, slot: number, bank: CollisionSoundBank): Promise<AudioBuffer | null>;
  /** An uploaded mountain-local WAV's decoded buffer. */
  fileBuffer(file: string): Promise<AudioBuffer | null>;
  /** Fallback impact speed for a contact that does not carry a finite one. */
  riderSpeed(): number;
  /** Passed straight through to the ambient bed. */
  ambient: AmbientSoundHooks;
}

/**
 * One prop that can sound on contact — the placement's own audio row, flattened.
 *
 * Reference instances and authored props reach this in the same shape on purpose: the two differ in where
 * their event id was authored, not in how a hit sounds. `key` is only ever a debounce identity, which is why
 * this carries no host or instance record; the caller keeps those.
 */
export interface PropSoundSource {
  /** Stable per prop, so one prop's debounce cannot silence another's. */
  key: string;
  /** Source level, whose course bank the event resolves against. */
  level: string;
  /** ADL collision event id. Negative or unresolvable is authored-silent — and still arms the ambience. */
  event: number;
  /** Effective collider response, selecting the same speed/volume curve as the corresponding Unity path. */
  contact: PropSoundContact;
  /** Uploaded WAV played instead of `event`, previewing the slot the repacker will inject. */
  file?: string;
}

/**
 * Build the reference registry from the exact payload that built the prop collider. Effects.json also repeats
 * some of these fields, but it loads independently and is optional on imported/custom mountains; making impact
 * audio depend on it leaves a fully working collider with no sound source. `sourceIndex` is the identity the
 * obstacle reports, so this join cannot drift from the geometry it describes.
 */
export function referencePropSoundSources(level: string,
  instances: readonly Pick<PropInstance, 'sourceIndex' | 'collisionSound' | 'contact'>[]): Map<number, PropSoundSource> {
  const sources = new Map<number, PropSoundSource>();
  for (const instance of instances) {
    if (instance.collisionSound < 0) continue;
    sources.set(instance.sourceIndex, {
      key: `reference:${instance.sourceIndex}`,
      level,
      event: instance.collisionSound,
      contact: instance.contact === 'movable' ? 'movable'
        : instance.contact === 'solid' ? 'solid' : 'through',
    });
  }
  return sources;
}

export interface PropSoundLayer {
  /** Reference props that carry a collision row, by native instance index. */
  setReferenceSources(sources: ReadonlyMap<number, PropSoundSource>): void;
  /** Authored props that carry a collision row or an uploaded clip, by prop id. */
  setAuthoredSources(sources: ReadonlyMap<string, PropSoundSource>): void;
  /** Install the level's placed ambience (`Sounds.ExternalSounds`). */
  setPlacedAmbience(level: string, sources: readonly AmbientSoundSource[]): void;
  /** Gate the ambient bed — the World-effects toggle, or an active Test run. */
  setAmbientEnabled(on: boolean): void;
  /** Advance the ambient field against the listener's world position. */
  step(dt: number, listenerWorld: THREE.Vector3): void;
  /**
   * A rider hit this prop. Arms its hit-gated ambience first and unconditionally, then plays the collision
   * one-shot if the prop has one that resolves — the order retail uses, and the reason hydrants spray.
   */
  contact(object: RideObstacleObject, position: THREE.Vector3, impactSpeed: number, elapsed: number,
    contactOverride?: PropSoundContact): void;
  /** A run boundary: drop the debounces and every arming, as retail's full audio reset does. */
  resetRun(): void;
  /** Stop every ambient voice now, keeping the installed sources and their arming. */
  stopAmbient(): void;
  /** What the bed is sounding and how loudly — diagnostics. */
  ambientVoices(): { key: string; gain: number }[];
  /** Whether a contact has armed this prop's hit-gated ambience — diagnostics. Takes an owner key
   *  from `referenceOwnerKey` / `authoredOwnerKey`. */
  isArmed(owner: string): boolean;
  dispose(): void;
}

export function createPropSoundLayer(hooks: PropSoundHooks): PropSoundLayer {
  const ambient: AmbientSoundLayer = createAmbientSoundLayer(hooks.ambient);
  let referenceSources: ReadonlyMap<number, PropSoundSource> = new Map();
  let authoredSources: ReadonlyMap<string, PropSoundSource> = new Map();
  /** Per-prop retrigger gate, keyed by `PropSoundSource.key`. */
  const soundNext = new Map<string, number>();

  /** The one-shot half: an event id resolved to a bank slot, or the uploaded clip that replaces it. Silent
   *  ids simply produce nothing — by then the ambience has already been armed. */
  function impactVolume(contact: PropSoundContact | undefined, impactSpeed: number): number | null {
    const fallback = hooks.riderSpeed();
    const speed = Number.isFinite(impactSpeed) ? Math.max(0, impactSpeed)
      : Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
    // A source map can survive a dev hot-reload (or arrive from an older API response) without the contact
    // discriminator added alongside these curves. Treat that legacy shape as an ordinary blocking impact;
    // malformed runtime data must never turn a harmless prop touch into a render-loop exception.
    const response = IMPACT_RESPONSE[contact ?? 'solid'] ?? IMPACT_RESPONSE.solid;
    if (speed < response.minSpeed) return null;
    const t = Math.min(1, Math.max(0,
      (speed - response.minSpeed) / Math.max(0.01, response.fullSpeed - response.minSpeed)));
    return response.volumeFloor + response.volumeRange * t;
  }

  function playOneShot(source: PropSoundSource, position: THREE.Vector3, volume: number): void {
    if (source.file) { hooks.playOneShot(hooks.fileBuffer(source.file), position, volume); return; }
    const resolved = resolveCollisionSound(source.event, source.level);
    if (!resolved) return; // authored-silent id
    hooks.playOneShot(hooks.bankBuffer(source.level, resolved.slot, resolved.bank), position, volume);
  }

  return {
    setReferenceSources(sources) { referenceSources = sources; },
    setAuthoredSources(sources) { authoredSources = sources; },
    setPlacedAmbience(level, sources) { ambient.setSources(level, sources); },
    setAmbientEnabled(on) { ambient.setEnabled(on); },
    step(dt, listenerWorld) { ambient.step(dt, listenerWorld); },

    contact(object, position, impactSpeed, elapsed, contactOverride) {
      // Arming comes first and is NEVER gated on the prop having an audible collision row, because retail
      // registers the entity before resolving that row to a clip. Both prop kinds arm: an authored placement
      // carrying a gated event is hit-gated in retail exactly as a reference one is, so Test has to be too.
      ambient.arm(propOwnerKey(object));
      const source = object.kind === 'reference'
        ? referenceSources.get(object.index) : authoredSources.get(object.id);
      // The debounce guards the one-shot alone. Arming is permanent and idempotent, so rate-limiting it
      // would only risk dropping the very first contact — the one that has to land.
      if (!source) return;
      // Match Unity's ordering: a sub-threshold graze is not a played sound and therefore must not consume
      // the cooldown. If a real hit follows immediately, it is still eligible.
      const volume = impactVolume(contactOverride ?? source.contact, impactSpeed);
      if (volume === null || elapsed < (soundNext.get(source.key) ?? 0)) return;
      soundNext.set(source.key, elapsed + COLLISION_SOUND_DEBOUNCE_SECONDS);
      playOneShot(source, position, volume);
    },

    resetRun() { soundNext.clear(); ambient.disarmAll(); },
    stopAmbient() { ambient.stopAll(); },
    ambientVoices: () => ambient.active().sort((a, b) => b.gain - a.gain),
    isArmed: owner => ambient.isArmed(owner),
    dispose() { soundNext.clear(); ambient.dispose(); },
  };
}
