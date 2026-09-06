import * as THREE from 'three';
import { customSoundUrl } from '../../net/asset-paths';
import {
  externalSoundField, externalSoundReach, isInteractiveAmbientEvent, resolveExternalSound,
  type ExternalSoundEmitter, type ExternalSoundPlacement,
} from '../../../core/effects/external-sound';

/**
 * Placed ambience: the continuing voices an instance's `Sounds.ExternalSounds` records carry
 * [Trailmap: 420-audio-runtime].
 *
 * This is the level's ambient bed, and it is a channel of its own — separate from the per-instance collision
 * row `reference-effects.ts` plays as a one-shot on contact. Merquer alone places 99 of them: hydrant spray,
 * idling cars, police radios, crowds, traffic, birds, the subway station. Until this layer existed every one
 * was silent, which read as props whose sound "only played half its clip" — what was actually heard was some
 * unrelated collision one-shot nearby, and the emitter behind the rest of the sound never ran.
 *
 * The authored gain comes from core, measured against the record's own region and falloff curve. The panner
 * is left doing direction only (`rolloffFactor` 0): applying Web Audio's distance model on top would
 * attenuate the field twice and shrink every region well inside the boundary the Props panel draws for it.
 *
 * Not all of the bed is proximity-driven. Events 16/28/57 — cars, fire hydrants, police cars — are hit-gated:
 * silent at any range until the rider hits that instance, then sounding for the rest of the run
 * [Trailmap: 420-interactive-gate]. Merquer places 53 of them, so running the field without the gate put every
 * car alarm and police siren on from the drop gate, which is the opposite error to the one above.
 */

/** One placed emitter, ready for this layer to measure and sound. */
export interface AmbientSoundSource {
  /** Stable per instance + record, so a rebuild can keep a voice playing instead of restarting it. */
  key: string;
  emitter: ExternalSoundEmitter;
  /** Emitter centre. Raw native centimetres by default; editor metres when `space` says so. */
  center: readonly [number, number, number];
  /**
   * Which frame `center` is expressed in. Reference records are already RAW, in the frame the listener is
   * measured against. Authored placements are EDITOR metres and live under a different root — the reference
   * holder carries a placement offset that authored props do not — so they are converted on install rather
   * than assumed to share a frame. Assuming it silenced every authored emitter whenever a reference was
   * loaded with a non-zero offset, because the listener was compared against a centre kilometres away.
   */
  space?: 'raw' | 'editor';
  /**
   * Identity of the prop carrying the record — what `arm` matches, since the interactive class is enabled
   * per instance and hitting one hydrant must not start its neighbours. A STRING because reference and
   * authored props have disjoint id spaces (a native index and a document id) that must not collide;
   * `prop-sound` mints both sides so a contact and a placement always agree on the spelling.
   */
  owner: string;
  /** Source level whose banks this event resolves against. Defaults to the installed level — authored props
   *  carry their own, because a placement keeps the bank of the level its model came from. */
  level?: string;
  /** Uploaded mountain-local WAV played instead of resolving `emitter.sound`. */
  file?: string;
}

export interface AmbientSoundHooks {
  /** The shared listener the effect one-shots use, so the whole mountain mixes through one graph. */
  listener: THREE.AudioListener;
  /** Where voices attach. This must be a world-space (identity) object: positions are written into it raw. */
  root: THREE.Object3D;
  /** Raw native centimetres to world space — the same transform the range gizmo is drawn through. */
  rawToWorld: (raw: readonly [number, number, number]) => THREE.Vector3;
  /** The inverse, for the listener. Measuring the field in raw centimetres transforms one point per scan
   *  instead of every emitter, and keeps the region maths in the units the records are authored in. */
  worldToRaw: (world: THREE.Vector3) => [number, number, number];
  /** Editor metres to the same raw frame `worldToRaw` produces, for placements that are not the reference's. */
  editorToRaw: (editor: readonly [number, number, number]) => [number, number, number];
  /** Decoded buffer for one resolved event URL, cached by the caller. Null when that bank was never extracted. */
  loadBuffer: (url: string) => Promise<AudioBuffer | null>;
}

/** Resolve one placed source to the exact URL the runtime will loop. Exported so level load can decode every
 * used clip before the listener enters its region instead of putting I/O on the first audible scan. */
export function ambientSoundUrl(installedLevel: string, source: AmbientSoundSource): string | null {
  if (source.file) return customSoundUrl(source.file);
  const bankLevel = source.level || installedLevel;
  const resolved = bankLevel ? resolveExternalSound(source.emitter.sound, bankLevel) : null;
  if (!resolved) return null;
  const bank = resolved.kind === 'fixed' ? resolved.bank : resolved.kind;
  return `/api/effect-sound?level=${encodeURIComponent(bankLevel)}&slot=${resolved.slot}`
    + (bank === 'course' ? '' : `&bank=${encodeURIComponent(bank)}`) + '&loop=1';
}

/**
 * How many voices may sound at once. Retail visits one cell of a spatial grid; this keeps the whole list and
 * takes the loudest, which cannot drop a near emitter behind a far one the way a grid cell can. Merquer's
 * densest corner overlaps about nine regions, so this is headroom rather than a real limit.
 */
const MAX_VOICES = 16;
/** Rescan cadence. A rider crosses a 32 m region in roughly three seconds, so this is many updates per pass. */
const SCAN_SECONDS = 0.12;
/** Master trim: a full-gain bed sits under the ride and the prop one-shots rather than over them. */
const AMBIENT_VOLUME = 0.5;

interface Voice {
  sound: THREE.PositionalAudio;
  /**
   * The URL this voice's buffer was decoded from — the identity of the CLIP, as opposed to `key`, which is
   * the identity of the RECORD. They are different things and only the record's is stable: retargeting an
   * authored emitter's event, or uploading a different WAV under the same slot, changes the clip while the
   * key stays put. Keeping only the key meant a retarget kept the old buffer playing until the rider left
   * the region, so the editor showed one sound and the mountain played another.
   */
  url: string;
}

export interface AmbientSoundLayer {
  /** Install a level's emitter list. Voices whose keys survive a same-level rebuild keep playing. */
  setSources(level: string, sources: readonly AmbientSoundSource[]): void;
  /** Gate the whole bed — the World-effects toggle, or an active Test run. */
  setEnabled(on: boolean): void;
  /**
   * Arm the hit-gated emitters owned by one instance, as a rider's impact does. Retail arms on the impact
   * CALL, before the prop's own collision event is resolved to a clip, so a prop whose collision row is the
   * silent sentinel — every retail fire hydrant — still starts its spray on a hit that makes no other sound.
   * Callers therefore pass every contact, not only the ones that sounded. [Trailmap: 420-interactive-ambient]
   */
  arm(owner: string): void;
  /** Forget every arming, as retail's full audio reset does — a world reset or a fresh Test run. */
  disarmAll(): void;
  /** Whether an instance's hit-gated emitters have been armed — diagnostics, and what pins the arming
   *  contract in tests without needing an audio context to hear a voice. */
  isArmed(owner: string): boolean;
  /** Advance the field against the listener's world position. */
  step(dt: number, listenerWorld: THREE.Vector3): void;
  /** Stop every voice now, keeping the installed source list. */
  stopAll(): void;
  /** What is sounding and how loudly — diagnostics. */
  active(): { key: string; gain: number }[];
  dispose(): void;
}

export function createAmbientSoundLayer(hooks: AmbientSoundHooks): AmbientSoundLayer {
  let level = '';
  let enabled = false;
  /** Bumped by every teardown so an in-flight buffer load cannot seat a voice from a level already gone. */
  let generation = 0;
  let scanElapsed = SCAN_SECONDS; // the first step does a full pass rather than waiting out the cadence
  /** The emitter list in the shape core measures, rebuilt only when the sources change. */
  let placements: ExternalSoundPlacement[] = [];
  /** Instances whose hit-gated emitters an impact has enabled. Survives `stopAll` and the World-effects
   *  toggle: retail only ever clears this on a full audio reset, so muting the bed must not re-silence a
   *  hydrant the rider already burst. Cleared by `disarmAll` and by a level swap. */
  const armed = new Set<string>();
  /** Gated placements by owning prop, so arming one hydrant touches only its own records. */
  const gatedByOwner = new Map<string, ExternalSoundPlacement[]>();
  const voices = new Map<string, Voice>();
  const gains = new Map<string, number>();
  const byKey = new Map<string, AmbientSoundSource>();
  /**
   * The same placements the field measures, by key — which is what a voice must be SEATED from.
   *
   * `AmbientSoundSource.center` is whatever frame the caller authored in, raw or editor; `placement.center`
   * is that centre converted to raw once. Seating from the source instead put every authored emitter's pan
   * at `rawToWorld(editor metres)` — a hundredfold scale error, through the reference root rather than the
   * world one, so it also picked up the comparison offset. The gain was right the whole time, because gain
   * reads the placement, which is exactly what made it hard to see. One centre, one owner.
   */
  const placementByKey = new Map<string, ExternalSoundPlacement>();
  const loading = new Set<string>();

  /** Where a voice's clip comes from. A continuing voice asks for the slot's BNKl loop region; an uploaded
   *  WAV has none to ask for and is played whole. */
  const sourceUrl = (source: AmbientSoundSource): string | null => ambientSoundUrl(level, source);

  /**
   * Tear a voice down completely, including the gain node's own edge into the listener. Three's `Audio` wires
   * that edge in its constructor and never removes it, so stopping and unparenting alone would leak a live
   * node chain per voice for the life of the page — which a continuously started/stopped bed does constantly.
   */
  function stopVoice(key: string): void {
    const voice = voices.get(key);
    if (!voice) return;
    voices.delete(key);
    gains.delete(key);
    const { sound } = voice;
    sound.onEnded = () => {};
    if (sound.isPlaying) { try { sound.stop(); } catch { /* the context stopped it already */ } }
    try { sound.disconnect(); } catch { /* never connected: nothing to undo */ }
    try { sound.gain.disconnect(); } catch { /* already detached */ }
    sound.removeFromParent();
  }

  function stopAll(): void {
    generation++;
    for (const key of [...voices.keys()]) stopVoice(key);
    gains.clear();
    loading.clear();
  }

  function startVoice(source: AmbientSoundSource, position: THREE.Vector3, gain: number): void {
    const url = sourceUrl(source);
    if (!url || loading.has(source.key)) return;
    const started = generation;
    loading.add(source.key);
    void hooks.loadBuffer(url).then(buffer => {
      loading.delete(source.key);
      if (!buffer || started !== generation || !enabled || voices.has(source.key)) return;
      // The record may have been retargeted while this decode was in flight. `source` is the object captured
      // at the call, so ask the CURRENT one what it now points at — seating a buffer the author has already
      // replaced is the same defect as keeping one, arriving a moment later.
      const current = byKey.get(source.key);
      if (!current || sourceUrl(current) !== url) return;
      const sound = new THREE.PositionalAudio(hooks.listener);
      sound.setBuffer(buffer);
      sound.setLoop(true);
      sound.setDistanceModel('linear');
      sound.setRefDistance(1);
      sound.setRolloffFactor(0); // direction only; the authored curve already owns distance
      sound.setVolume(0);        // ramp up from silence so a voice never pops on at range
      sound.position.copy(position);
      hooks.root.add(sound);
      voices.set(source.key, { sound, url });
      sound.play();
      sound.setVolume(gain * AMBIENT_VOLUME);
    });
  }

  /**
   * Why a placed emitter is not sounding, in one line per scan.
   *
   * Every stage between an authored record and an audible voice fails SILENTLY by design — an unresolvable
   * event, a bank that was never extracted, a listener outside the region, an unarmed gate — so without this
   * the only symptom is silence, and the causes are indistinguishable. Enable with
   * `localStorage['slopesmith:ambience-debug'] = '1'`.
   */
  function debugScan(listenerRaw: [number, number, number], heard: readonly { key: string }[]): void {
    try { if (localStorage.getItem('slopesmith:ambience-debug') !== '1') return; } catch { return; }
    const audible = new Set(heard.map(voice => voice.key));
    console.debug('[Slopesmith ambience]', {
      enabled, level, listenerRaw, placements: placements.length, voices: voices.size,
      sources: placements.map(placement => {
        const source = byKey.get(placement.key);
        return {
          key: placement.key,
          event: placement.emitter.sound,
          gated: isInteractiveAmbientEvent(placement.emitter.sound),
          armed: placement.armed !== false,
          reach: externalSoundReach(placement.emitter),
          url: source ? sourceUrl(source) : null,
          audible: audible.has(placement.key),
          playing: voices.has(placement.key),
        };
      }),
    });
  }

  function rescan(listenerWorld: THREE.Vector3): void {
    if (!enabled) { gains.clear(); return; }
    const listenerRaw = hooks.worldToRaw(listenerWorld);
    const heard = externalSoundField(placements, listenerRaw, MAX_VOICES);
    debugScan(listenerRaw, heard);
    gains.clear();
    for (const voice of heard) gains.set(voice.key, voice.gain);
    for (const key of [...voices.keys()]) if (!gains.has(key)) stopVoice(key);
    for (const entry of heard) {
      const source = byKey.get(entry.key);
      const placement = placementByKey.get(entry.key);
      if (!source || !placement) continue;
      const voice = voices.get(entry.key);
      // Re-seat every audible voice rather than caching its world position: the reference holder moves when
      // a comparison offset is dragged, and a cached centre would leave the pan pointing at where the prop
      // used to be while the gain (measured in raw space through the live matrix) stayed correct.
      const position = hooks.rawToWorld(placement.center);
      if (voice) { voice.sound.position.copy(position); voice.sound.setVolume(entry.gain * AMBIENT_VOLUME); }
      else startVoice(source, position, entry.gain);
    }
  }

  return {
    setSources(nextLevel, nextSources) {
      const swapped = nextLevel !== level;
      level = nextLevel;
      if (swapped) armed.clear(); // a different mountain's instance indices mean nothing here
      byKey.clear();
      gatedByOwner.clear();
      placementByKey.clear();
      for (const source of nextSources) byKey.set(source.key, source);
      placements = nextSources.map(source => {
        const gated = isInteractiveAmbientEvent(source.emitter.sound);
        // Converted ONCE, here, rather than per scan: the whole point of measuring the field in raw
        // centimetres is that a scan transforms the listener alone and never the emitters.
        const center = source.space === 'editor'
          ? hooks.editorToRaw(source.center)
          : [source.center[0], source.center[1], source.center[2]] as [number, number, number];
        const placement: ExternalSoundPlacement = {
          key: source.key,
          emitter: source.emitter,
          center,
          // A same-level rebuild (a dragged comparison offset, a reloaded prop payload) must not re-silence
          // what the rider already hit, so arming is re-applied rather than reset.
          armed: gated ? armed.has(source.owner) : true,
        };
        placementByKey.set(source.key, placement);
        if (gated) {
          const list = gatedByOwner.get(source.owner);
          if (list) list.push(placement); else gatedByOwner.set(source.owner, [placement]);
        }
        return placement;
      });
      if (swapped) stopAll();
      else for (const [key, voice] of [...voices]) {
        // A voice survives a same-level rebuild only if it is still the same RECORD playing the same CLIP.
        // Dropping the second half is what let a retargeted emitter keep sounding its old event: the key
        // matched, so nothing here stopped it, and `rescan` only ever updates position and gain.
        const source = byKey.get(key);
        if (!source || sourceUrl(source) !== voice.url) stopVoice(key);
      }
      scanElapsed = SCAN_SECONDS;
    },
    arm(owner) {
      if (armed.has(owner)) return;
      armed.add(owner);
      const gated = gatedByOwner.get(owner);
      if (!gated) return; // the instance carries no interactive record; nothing to start
      for (const placement of gated) placement.armed = true;
      scanElapsed = SCAN_SECONDS; // sound it on the next step rather than waiting out the cadence
    },
    isArmed: owner => armed.has(owner),
    disarmAll() {
      if (!armed.size) return;
      armed.clear();
      for (const [, gated] of gatedByOwner)
        for (const placement of gated) {
          placement.armed = false;
          stopVoice(placement.key);
        }
    },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (on) scanElapsed = SCAN_SECONDS;
      else stopAll();
    },
    step(dt, listenerWorld) {
      if (!enabled) return;
      scanElapsed += dt;
      if (scanElapsed < SCAN_SECONDS) return;
      scanElapsed = 0;
      rescan(listenerWorld);
    },
    stopAll,
    active: () => [...gains].map(([key, gain]) => ({ key, gain })).filter(entry => voices.has(entry.key)),
    dispose() {
      stopAll();
      placements = [];
      byKey.clear();
      placementByKey.clear();
      armed.clear();
      gatedByOwner.clear();
    },
  };
}

export { AMBIENT_VOLUME, MAX_VOICES, SCAN_SECONDS };
