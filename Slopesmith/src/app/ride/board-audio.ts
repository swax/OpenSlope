import {
  BIG_AIR_WIND_SLOT, BOARD_AUDIO_GROUPS, BOARD_BANK, BOARD_BEND_SPAN, BOARD_BOOST_SLOT, BOARD_LAND_SLOT,
  BOARD_OLLIE_SLOT, BOARD_RAIL_GROUP, BOOST_BANK, SPEED_PAD_SLOT, TRICK_PAD_SLOT, bigAirWindActive,
  boardAudioGroup, boardBedFrame, boardCarveSlot, boardGlideSlot, gemChimeSlot,
} from '../../core/audio/board-sound';
import type { BoardSoundMix } from '../../core/doc/types';
import {
  gameAudioDestination, preloadAudio, resumeSharedAudio, sharedAudioBuffer, sharedAudioContext,
} from '../audio/runtime';
import type { RideState } from './physics';

/**
 * The board bed for the test ride (docs/034): the glide and carve loops, the grind scrape, the ollie/landing
 * transients, focused-rider big-air wind, and the held-boost roar — performed from the shared `zboard` /
 * `zbxsfx` banks, so riding your own mountain sounds like riding the game's.
 *
 * Retail establishes the persistent-node, surface-family and live-signal interface
 * [Trailmap: 420-audio-runtime]. `boardBedFrame` supplies an original OpenSlope response over speed, skid and
 * lean; it is not a transcription of the retail SNOW.INF programs. The Unity board uses the same authored
 * curve, so the two runtimes keep the same feel and the mix remains the tuning surface.
 *
 * It also owns the **game-event cues** — the gem chime and the boost/trick pad hits. Those are not sounds in
 * the effect graph: the graph node applies the gameplay and engine code on that apply path plays a fixed
 * MAIN-bank slot, gated to the local human rider [Trailmap: 390-pickups-and-race]. They are the rider's own
 * feedback, so they belong on this bus and not in the effects layer's positional one-shots — the ride hands
 * them here from `applyEffect`, which is the same place the gameplay lands.
 *
 * Everything is 2D: this is the rider's own board under their own feet, not a source out in the world, so it
 * takes its own small AudioContext rather than the effects layer's positional listener.
 */

/** Speed band the glide layer opens across, m/s (RideableBoard glideMinSpeed / glideFullSpeed). */
const GLIDE_MIN_SPEED = 1.5;
const GLIDE_FULL_SPEED = 18;
/** Fast attack keeps a physical event attached to its frame; the gentler release still prevents loop clicks. */
const ATTACK_RATE = 20;
const RELEASE_RATE = 6;
const GRIND_PITCH = [0.9, 1.4] as const;
/** The grind scrape's own level before the transient trim (RideableBoard grindVolume). */
const GRIND_LEVEL = 0.7;
/** Arriving into-surface speed that counts as a slam, m/s (RideableBoard landHardImpact). */
const LAND_HARD_IMPACT = 18;
/** Held boost: punch to full for this long on the engage edge, then hold this fraction while it thrusts. */
const BOOST_PEAK = 0.9;
const BOOST_PUNCH_SECONDS = 0.6;
const BOOST_SUSTAIN_FRAC = 0.5;
/** Game-event cues play at the mixer's own level; the authored `cues` trim is the only thing over them. */
const CUE_LEVEL = 0.9;
const BOOST_RELEASE_RATE = 2.5;
/** Retail performs this voice through its rider/music level driver. OpenSlope keeps that recovered ownership
 * and gate, with a conservative local-rider mix level until the exact level curve is decoded. */
const BIG_AIR_WIND_LEVEL = 0.7;

const boardSoundUrl = (bank: string, slot: number, loop: boolean): string =>
  `/api/board-sound?bank=${encodeURIComponent(bank)}&slot=${slot}${loop ? '&loop=1' : ''}`;

/** Warm every clip the local ride can select. The shared cache survives Stop → Play, so only the page's first
 * Test entry pays these local fetch/decode costs and no gameplay edge ever owns them. */
export function preloadBoardAudio(): void {
  const urls: string[] = [];
  for (let group = 0; group < BOARD_AUDIO_GROUPS.length; group++) {
    urls.push(boardSoundUrl(BOARD_BANK, boardGlideSlot(group), true));
    urls.push(boardSoundUrl(BOARD_BANK, boardCarveSlot(group), true));
  }
  urls.push(
    boardSoundUrl(BOARD_BANK, BOARD_OLLIE_SLOT, false),
    boardSoundUrl(BOARD_BANK, BOARD_LAND_SLOT, false),
    boardSoundUrl(BOOST_BANK, BIG_AIR_WIND_SLOT, true),
    boardSoundUrl(BOOST_BANK, BOARD_BOOST_SLOT, true),
    boardSoundUrl(BOOST_BANK, SPEED_PAD_SLOT, false),
    boardSoundUrl(BOOST_BANK, TRICK_PAD_SLOT, false),
    boardSoundUrl(BOOST_BANK, 116, false),
    boardSoundUrl(BOOST_BANK, 117, false),
    boardSoundUrl(BOOST_BANK, 118, false),
  );
  preloadAudio(urls);
}

const clamp01 = (v: number): number => v < 0 ? 0 : v > 1 ? 1 : v;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const moveTowards = (from: number, to: number, step: number): number =>
  Math.abs(to - from) <= step ? to : from + Math.sign(to - from) * step;

/** Write a frame's level as a ramp ACROSS the frame rather than a step at its start: a per-frame step on a
 *  gain is audible as zipper noise on a bed this quiet, and the ramps chain frame to frame on their own. */
function rampGain(param: AudioParam, level: number, now: number, dt: number): void {
  param.linearRampToValueAtTime(level, now + Math.max(dt, 1 / 120));
}

/** One continuously running layer: a looping bank slot whose volume and pitch are written every frame. The
 *  slot can change under it (the family the board is riding), which restarts the source with the new clip. */
class LoopLayer {
  private readonly gain: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private slot = -1;
  private generation = 0;
  private level = 0;
  private rate = 1;

  constructor(private readonly host: BoardAudio, destination: AudioNode, private readonly bank = BOARD_BANK) {
    this.gain = host.context.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(destination);
  }

  /** Swap to a bank slot (a no-op while the slot holds). Silent until its buffer arrives. */
  play(slot: number): void {
    if (slot === this.slot) return;
    this.slot = slot;
    const generation = ++this.generation;
    this.stopSource();
    void this.host.buffer(this.bank, slot, true).then(buffer => {
      if (!buffer || generation !== this.generation) return;
      const source = this.host.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.playbackRate.value = this.rate;
      source.connect(this.gain);
      source.start();
      this.source = source;
    });
  }

  /** Ease this frame's volume toward `target` and set the pitch bend. */
  perform(target: number, rate: number, dt: number): void {
    this.level = moveTowards(this.level, target, (target > this.level ? ATTACK_RATE : RELEASE_RATE) * dt);
    rampGain(this.gain.gain, this.level, this.host.context.currentTime, dt);
    this.rate = rate;
    if (this.source) this.source.playbackRate.value = rate;
  }

  /** A retail rider voice is destroyed after its landing fade rather than left looping silently forever. */
  stopWhenSilent(): void {
    if (this.level > 0.001 || this.slot < 0) return;
    this.slot = -1;
    this.generation++;
    this.stopSource();
  }

  dispose(): void {
    this.generation++;
    this.stopSource();
    this.gain.disconnect();
  }

  private stopSource(): void {
    if (!this.source) return;
    try { this.source.stop(); } catch { /* already ended */ }
    this.source.disconnect();
    this.source = null;
  }
}

export class BoardAudio {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly transientGain: GainNode;
  private readonly cueGain: GainNode;
  private readonly glide: LoopLayer;
  private readonly carve: LoopLayer;
  private readonly grind: LoopLayer;
  private readonly bigAir: LoopLayer;
  private readonly boostGain: GainNode;
  private boostSource: AudioBufferSourceNode | null = null;
  private boostLevel = 0;
  private boostHeld = 0;      // seconds the current engage has been thrusting (drives the punch)
  private boosting = false;   // last frame's engage state, for the punch re-arm edge
  private surfaceGroups: number[] | null = null;
  private disposed = false;
  // Edge trackers: the ride state is a snapshot, so the transients are found by watching it change.
  private wasGrounded = true;
  private wasPopping = true;  // suppress the spawn frame's pose from firing an ollie
  private airVelocity: [number, number, number] = [0, 0, 0];

  constructor(private readonly mix: BoardSoundMix, surfaceGroups?: readonly number[]) {
    this.surfaceGroups = surfaceGroups ? [...surfaceGroups] : null;
    this.context = sharedAudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = clamp01(mix.volume);
    this.master.connect(gameAudioDestination());
    // Two buses under the master, split the way the game splits them: board sound out of the board bank, and
    // the code-driven game-event cues out of the MAIN bank.
    this.transientGain = this.context.createGain();
    this.transientGain.gain.value = clamp01(mix.transients);
    this.transientGain.connect(this.master);
    this.cueGain = this.context.createGain();
    this.cueGain.gain.value = clamp01(mix.cues);
    this.cueGain.connect(this.master);
    this.glide = new LoopLayer(this, this.master);
    this.carve = new LoopLayer(this, this.master);
    this.grind = new LoopLayer(this, this.transientGain);
    this.bigAir = new LoopLayer(this, this.cueGain, BOOST_BANK);
    this.boostGain = this.context.createGain();
    this.boostGain.gain.value = 0;
    this.boostGain.connect(this.cueGain);
    resumeSharedAudio();
    if (!surfaceGroups) {
      void fetch('/api/board-audio')
        .then(response => response.ok
          ? response.json() as Promise<{ surfaceGroups?: number[] | null }>
          : Promise.reject(new Error(`HTTP ${response.status}`)))
        .then(body => { this.surfaceGroups = Array.isArray(body.surfaceGroups) ? body.surfaceGroups : null; })
        .catch(() => { /* no local index: the safe PACK fallback remains */ });
    }
    preloadBoardAudio();
  }

  /** Perform one frame of the bed from the live ride state. `boosting` is the board's own held-boost thrust. */
  update(st: RideState, dt: number, boosting: boolean): void {
    if (this.disposed || dt <= 0) return;
    const speed = st.vel.length();
    const speed01 = clamp01((speed - GLIDE_MIN_SPEED) / Math.max(0.1, GLIDE_FULL_SPEED - GLIDE_MIN_SPEED));
    const grinding = st.railIdx >= 0;
    const onSnow = st.grounded && !grinding;

    // Ride bed: the family under the board picks the row; retail silences both layers off the ground, which
    // is what makes a jump go quiet with no explicit stop event.
    const group = boardAudioGroup(st.surf, this.surfaceGroups);
    if (onSnow) {
      this.glide.play(boardGlideSlot(group));
      this.carve.play(boardCarveSlot(group));
    }
    // OpenSlope's authored response crossfades from glide to carve using lateral skid and lean. `open` keeps
    // a parked-but-grounded board silent; boardBedFrame's own smooth speed envelope shapes the approach.
    const frame = boardBedFrame(group, st.slip * 100, Math.abs(st.lean) * 127, speed01);
    const open = clamp01(speed01 * 6);
    this.glide.perform(onSnow ? this.mix.glide * frame.glideVol * open : 0,
      1 + frame.glideBend * BOARD_BEND_SPAN, dt);
    this.carve.perform(onSnow ? this.mix.carve * frame.carveVol * open : 0,
      1 + frame.carveBend * BOARD_BEND_SPAN, dt);

    // Rails answer with the RAIL family's own loop — the one row the terrain mapper never selects.
    if (grinding) this.grind.play(boardGlideSlot(BOARD_RAIL_GROUP));
    this.grind.perform(grinding ? GRIND_LEVEL * speed01 : 0, lerp(GRIND_PITCH[0], GRIND_PITCH[1], speed01), dt);

    // MAIN/032 is the focused rider's big-air wind, not universal ambience. The physics predictor latches the
    // expected total flight at state entry, matching retail's >1.5 s gate; landing releases and destroys it.
    const bigAir = !st.grounded && bigAirWindActive(st.predictedAirTime);
    if (bigAir) this.bigAir.play(BIG_AIR_WIND_SLOT);
    this.bigAir.perform(bigAir ? BIG_AIR_WIND_LEVEL : 0, 1, dt);
    if (!bigAir) this.bigAir.stopWhenSilent();

    // Ollie pop, on the launch edge; the charge that fed the launch sets how hard it reads.
    const popping = st.popTime > 0;
    if (popping && !this.wasPopping) this.oneShot(BOARD_OLLIE_SLOT, clamp01(0.5 + 0.5 * st.popDrive));
    this.wasPopping = popping;

    // Landing thud, on the touchdown edge: quiet on a soft set-down, loud on a slam. The arriving speed is
    // gone by the time the state is readable (the contact model has already answered it), so this measures
    // the last airborne velocity against the contact normal.
    if (onSnow && !this.wasGrounded) { // a rail catch is a grind, not a thud in the snow
      const [vx, vy, vz] = this.airVelocity;
      const n = st.contactN;
      const impact = Math.max(0, -(vx * n.x + vy * n.y + vz * n.z));
      const hardness = clamp01(impact / LAND_HARD_IMPACT);
      if (hardness > 0.05) this.oneShot(BOARD_LAND_SLOT, clamp01(0.25 + 0.75 * hardness));
    }
    this.wasGrounded = st.grounded;
    if (!st.grounded) this.airVelocity = [st.vel.x, st.vel.y, st.vel.z];

    this.updateBoost(boosting, dt);
  }

  /**
   * The gem chime, on the frame a score multiplier is applied. Retail plays it from engine code at the tail
   * of the multiplier apply — not from a sound node in the gem's collision graph, which carries only the
   * score, the sparkle burst and the dead-node kill — picking the tier off the multiplier VALUE
   * [Trailmap: 390-pickups-and-race]. Gated to the local human there; here there is only the one rider.
   */
  gemChime(multiplier: number): void {
    this.cue(gemChimeSlot(multiplier));
  }

  /** A boost pad hit: MainType 17 (speed) and 18 (trick) each play their own MAIN-bank slot from the same
   *  code path as the chime. Slopesmith's directional-boost property is deliberately silent — no sound is
   *  traced on it [Trailmap: 390-pickups-and-race]. */
  padCue(kind: 'speed' | 'trick'): void {
    this.cue(kind === 'speed' ? SPEED_PAD_SLOT : TRICK_PAD_SLOT);
  }

  /** Silence the board bed while off-board, optionally retaining the boost roar for active Superman thrust. */
  updateFlightBoost(boosting: boolean, dt: number): void {
    if (this.disposed || dt <= 0) return;
    this.glide.perform(0, 1, dt);
    this.carve.perform(0, 1, dt);
    this.grind.perform(0, 1, dt);
    this.bigAir.perform(0, 1, dt);
    this.bigAir.stopWhenSilent();
    this.updateBoost(boosting, dt);
  }

  /** Fade the whole bed out without touching the edge trackers — a paused ride still holds its state. */
  fadeSilent(dt: number): void { this.updateFlightBoost(false, dt); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.glide.dispose();
    this.carve.dispose();
    this.grind.dispose();
    this.bigAir.dispose();
    this.stopBoost();
    this.boostGain.disconnect();
    this.cueGain.disconnect();
    this.transientGain.disconnect();
    this.master.disconnect();
    // The page-owned context and decoded buffers deliberately survive this run.
  }

  /** Decoded bank slot, fetched once and shared. Null (never a throw) when the bank isn't extracted, so a
   *  missing zboard folder means a silent ride rather than a broken one. */
  buffer(bank: string, slot: number, loop: boolean): Promise<AudioBuffer | null> {
    return sharedAudioBuffer(boardSoundUrl(bank, slot, loop));
  }

  /**
   * The held-boost roar. The clips are flat ~constant roars, so the envelope is the sound: punch to full on
   * the engage edge, decay to a sustain while the boost thrusts, then fade out and stop on release — the
   * shape the Unity board reconstructs for the same reason (Unity docs/015; the retail voice-volume
   * code behind the heard fade isn't traced).
   */
  private updateBoost(boosting: boolean, dt: number): void {
    if (boosting && !this.boosting) this.boostHeld = 0;
    this.boosting = boosting;
    if (boosting) {
      this.boostHeld += dt;
      if (!this.boostSource) this.startBoost();
    }
    const punch = this.boostHeld < BOOST_PUNCH_SECONDS;
    const target = boosting ? BOOST_PEAK * (punch ? 1 : BOOST_SUSTAIN_FRAC) : 0;
    // Rising is punchy (the bed's own slew); falling — the post-punch decay and the release — is smoother.
    const rate = this.boostLevel < target ? ATTACK_RATE : BOOST_RELEASE_RATE;
    this.boostLevel = moveTowards(this.boostLevel, target, rate * dt);
    rampGain(this.boostGain.gain, this.boostLevel, this.context.currentTime, dt);
    if (!boosting && this.boostLevel <= 0.001) this.stopBoost();
  }

  private startBoost(): void {
    void this.buffer(BOOST_BANK, BOARD_BOOST_SLOT, true).then(buffer => {
      if (!buffer || this.disposed || !this.boosting || this.boostSource) return;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this.boostGain);
      source.start();
      this.boostSource = source;
    });
  }

  private stopBoost(): void {
    this.boostLevel = 0;
    const now = this.context.currentTime;
    this.boostGain.gain.cancelScheduledValues(now); // drop any ramp still queued behind the release
    this.boostGain.gain.setValueAtTime(0, now);
    if (!this.boostSource) return;
    try { this.boostSource.stop(); } catch { /* already ended */ }
    this.boostSource.disconnect();
    this.boostSource = null;
  }

  /** A board transient from the board bank, on the transient bus. */
  private oneShot(slot: number, volume: number): void {
    this.play(BOARD_BANK, slot, volume, this.transientGain);
  }

  /** A game-event cue from the MAIN bank, on the cue bus. */
  private cue(slot: number): void {
    this.play(BOOST_BANK, slot, CUE_LEVEL, this.cueGain);
  }

  private play(bank: string, slot: number, volume: number, bus: GainNode): void {
    this.resume();
    void this.buffer(bank, slot, false).then(buffer => {
      if (!buffer || this.disposed) return;
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      gain.gain.value = volume;
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(bus);
      source.onended = () => { source.disconnect(); gain.disconnect(); };
      source.start();
    });
  }

  private resume(): void {
    resumeSharedAudio();
  }
}

/** Build the bed for a run, or null when this mountain's mix has it switched off. */
export function createBoardAudio(mix: BoardSoundMix, surfaceGroups?: readonly number[]): BoardAudio | null {
  return mix.enabled && mix.volume > 0 ? new BoardAudio(mix, surfaceGroups) : null;
}
