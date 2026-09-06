import type { EffectGraph, EffectNode } from './document';

/** Recovered MainType-0/SubType-10 material motion. Rates are UV units per SSX animation tick; timing
 * values are seconds. Native mode 0 (and unknown fallback values) moves linearly, mode 1 eases each leg,
 * and mode 2 moves each leg at constant speed. Modes 1/2 reverse after every active interval. */
export interface UvScrollEffect {
  mode: number;
  uPerTick: number;
  vPerTick: number;
  activeDuration: number;
  pauseDuration: number;
  lifetime: number;
}

/** Recovered MainType-0/SubType-11 material flipbook playback. `speed` is the native SSF value, and it is
 * the on-screen frame rate directly: retail steps the phase by speed / 60 per tick on a 60 Hz list, so an
 * ordinary flipbook runs at `speed` frames per second. A non-zero direction plays backwards. */
export interface TextureFlipEffect {
  direction: number;
  speed: number;
  /**
   * Node lifetime in seconds, and the split between the two kinds of flip.
   *
   * Zero is an always-on flipbook that runs for as long as its prop is loaded. Above zero the node is a
   * one-shot a graph constructs, advances for this long, and then destroys; retail's node draws through a
   * private material override table that is freed with it, so the placed material — frame zero — comes back.
   * The Tokyo Megaplex ride-over buttons are the authored example: green until a rider crosses, a red pulse,
   * green again ([Trailmap: 410-texture-animation]).
   */
  length: number;
  dwell: boolean;
  /** Stable per-instance salt. Native dwell flipbooks randomise independently after their first hold. */
  seed?: number;
}

/** A finite lifetime makes the node a one-shot rather than ambient motion, so it advances only while a graph
 *  is running it and never on the world clock. */
export function isTextureFlipPulse(effect: TextureFlipEffect | null | undefined): boolean {
  return !!effect && effect.length > 0;
}

/** Recovered MainType-0/SubType-256 model-clip player. Frame values use the model's native 30 fps clock;
 * `rate` is therefore clip frames advanced per real second (30 = real time). */
export interface AnimObjectEffect {
  loopMode: number;
  startFrame: number;
  endFrame: number;
  rate: number;
  randomRateUpper: number;
  randomStart: boolean;
  reverse: boolean;
}

/** What an AnimCombo does once its triggered segment reaches the end, decoded from the sign of the payload's
 * last word: zero resumes the idle loop and can be triggered again, positive latches the node with the idle
 * pose frozen, negative latches it holding the last combo frame [Trailmap: 230-level-ssf type 0 sub 258]. */
export type AnimComboEnd = 'resume' | 'freeze' | 'hold-combo';

/**
 * Recovered MainType-0/SubType-258 model-clip player: an AnimObject carrying a SECOND window of the same clip
 * that a control message triggers.
 *
 * The idle half is the inherited AnimObject law and behaves exactly like sub 256. What sub 258 adds is a
 * reaction: on command 3 the node snapshots the pose every animated part is currently holding, runs the combo
 * window once, and draws each part as `snapshot x comboPose` — so the segment is applied RELATIVE to wherever
 * the prop had got to, not from the clip's origin. Aloha's `Mdl_BarrierDynamic_SideToSide_*` is the authored
 * example and shows why that matters: the idle window slides the barrier +/-430 cm and the combo window
 * rotates it flat with its own translation authored at zero, so composition is what keeps the barrier
 * knocking over WHERE IT STANDS instead of teleporting to the middle first.
 */
export interface AnimComboEffect extends AnimObjectEffect {
  /** First frame of the triggered window. Negative falls back to the idle window's end. */
  comboStartFrame: number;
  /** Last frame of the triggered window. Negative falls back to the whole clip length. */
  comboEndFrame: number;
  /** Triggered-window rate in clip frames per real second (30 = real time). */
  comboRate: number;
  comboEnd: AnimComboEnd;
}

/** The material properties one prop instance's graphs install. Most are always-on; a `textureFlip` carrying a
 * `length` is the exception, a one-shot that rests until a graph runs it. Crowd boxes use the shared cd00-cd15
 * texture bank rather than the material's own TextureFlipbook list. */
export interface MaterialWorldEffects {
  uvScroll?: UvScrollEffect;
  textureFlip?: TextureFlipEffect;
  crowd?: boolean;
}

/** Receiver identity matters for MainType-3/9: the same command number is dispatched to whichever persistent
 * property is installed on the bound instance. These are the material receivers whose retail controls are
 * currently proven. */
export type MaterialControlReceiver = 'uv-scroll' | 'texture-flip';

/** The material property one graph installs on its bound object, and the law it installs it with. */
export interface MaterialControl {
  receiver: MaterialControlReceiver;
  effect: MaterialWorldEffects;
}

/**
 * The Crack property changes the host's material state even though retail does not author a TextureFlip node
 * beside it. The model supplies the states instead: frame 0 is intact and frame 1 is cracked. Renderers use
 * this stationary, private flip only as the per-instance receiver for that implicit engine-owned selection;
 * it is never added to the effect document or exported to the native graph.
 */
export function crackedMaterialControlFromGraph(graph: EffectGraph | null | undefined): MaterialControl | null {
  if (!graph?.nodes.some(node => {
    const type0 = object(node.payload.type0) ? node.payload.type0 : null;
    return node.semanticType === 'property.cracked' || (node.mainType === 0 && type0?.SubType === 14);
  })) return null;
  return { receiver: 'texture-flip', effect: {
    textureFlip: { direction: 0, speed: 0, length: 0, dwell: false },
  } };
}

/** Existing editor/Unity approximation. Retail CrowdBox advances 16 independent cell states every fifth
 * 60 Hz tick, with activity-dependent rests; it is not one uniform-rate flipbook. */
export const CROWD_FRAMES_PER_SECOND = 8;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function decodeUvScrollNode(node: EffectNode, includeStatic: boolean): UvScrollEffect | null {
  const type0 = object(node.payload.type0) ? node.payload.type0 : null;
  if (node.mainType !== 0 || !type0 || (type0.SubType !== 10 && node.semanticType !== 'property.uv-scroll')) return null;
  const raw = object(type0.UVScroll) ? type0.UVScroll : null;
  if (!raw) return null;
  const uPerTick = finite(raw.U1), vPerTick = finite(raw.U2);
  if (!includeStatic && uPerTick === 0 && vPerTick === 0) return null;
  return {
    mode: finite(raw.U0),
    uPerTick,
    vPerTick,
    activeDuration: finite(raw.U3, 1),
    pauseDuration: finite(raw.U4),
    lifetime: finite(raw.U5),
  };
}

/** Decode one visibly moving portable UV-scroll node without depending on its optional semantic label. */
export function uvScrollFromNode(node: EffectNode): UvScrollEffect | null {
  return decodeUvScrollNode(node, false);
}

/** Decode a UVScroll receiver even when its authored rates are zero. Static receivers are used as phase-only
 * material state machines by the Merqury City strike sequence and become visible through command 6. */
export function uvScrollReceiverFromNode(node: EffectNode): UvScrollEffect | null {
  return decodeUvScrollNode(node, true);
}

/**
 * Which MATERIAL of a multi-material prop a node applies to, or null for "all of them".
 *
 * Retail never needed this: a scrolling surface there is its own single-material prop, so an effect
 * attached to the placement can only mean one thing. A prop imported as a GLB is not so tidy — a snow
 * gun's plume scrolls while its bodywork must not — and the two are one prop wearing two materials.
 *
 * It rides in the node's `extensions`, NOT its payload, because it is a Slopesmith concept: the payload
 * has to stay byte-shaped like the native record so it can still be exported as one.
 */
export function nodeMaterialScope(node: EffectNode): number | null {
  const ext = object(node.extensions) ? node.extensions.slopesmith : null;
  const mat = object(ext) ? ext.material : null;
  return typeof mat === 'number' && Number.isInteger(mat) ? mat : null;
}

/** True when a node applies to the material being drawn — either it names no material, or it names this
 *  one. An unscoped node still covers every material, which is what retail's own graphs mean. */
export function nodeAppliesToMaterial(node: EffectNode, mat: number | undefined): boolean {
  const scope = nodeMaterialScope(node);
  return scope === null || scope === mat;
}

/** First active UV-scroll node in graph order, optionally limited to the material being drawn. Retail
 *  material scrollers carry one. */
export function uvScrollFromGraph(graph: EffectGraph | null | undefined,
  mat?: number): UvScrollEffect | null {
  if (!graph) return null;
  for (const node of graph.nodes) {
    if (!nodeAppliesToMaterial(node, mat)) continue;
    const effect = uvScrollFromNode(node);
    if (effect) return effect;
  }
  return null;
}

/** Convert native per-tick scroll into Slopesmith/Three texture-offset space. Prop OBJ UVs are bottom-left
 * while Three's default texture upload flips image Y, so native V must invert; U keeps its sign. The Unity
 * material bundle applies the same conversion when it writes `_ScrollSpeed`. */
export function editorUvScrollDelta(effect: UvScrollEffect, ticks: number): [number, number] {
  return [effect.uPerTick * ticks, -effect.vPerTick * ticks];
}

/** Native UVScroll command 6 writes the current V phase. Convert it through the same V-axis inversion as
 * continuous scrolling and keep the result in one texture repeat. */
export function editorUvScrollVPhase(_effect: UvScrollEffect, value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((-value % 1) + 1) % 1;
}

export interface UvScrollPlayback {
  /** Native U3/U4 phase clock, represented as fixed 60 Hz ticks to avoid boundary drift. */
  phaseTicks: number;
  active: boolean;
  direction: 1 | -1;
  /** Native U5 is converted to a rounded frame countdown; zero means no lifetime limit. */
  remainingTicks: number;
  tickRemainder: number;
  finished: boolean;
}

export function createUvScrollPlayback(effect: UvScrollEffect): UvScrollPlayback {
  return {
    phaseTicks: 0,
    active: true,
    direction: 1,
    remainingTicks: effect.lifetime > 0 ? Math.max(1, Math.round(effect.lifetime * 60)) : 0,
    tickRemainder: 0,
    finished: false,
  };
}

/** Advance the native fixed-tick UV-scroll state and return the texture-space offset delta. The original
 * routine handles an interval boundary before applying that tick's motion, so mode 2's boundary tick already
 * travels in the reversed direction while mode 1 contributes zero at the endpoint. */
export function stepUvScrollPlayback(state: UvScrollPlayback, effect: UvScrollEffect,
  dtSeconds: number): [number, number] {
  if (state.finished || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return [0, 0];
  state.tickRemainder += dtSeconds * 60;
  const ticks = Math.floor(state.tickRemainder + 1e-9);
  state.tickRemainder = Math.max(0, state.tickRemainder - ticks);
  let nativeU = 0, nativeV = 0;
  const specialMode = effect.mode === 1 || effect.mode === 2;
  // Native durations are compared after adding one fixed tick, so a partial-tick duration rounds up.
  const durationTicks = (seconds: number): number => seconds > 0
    ? Math.max(1, Math.ceil(seconds * 60 - 1e-6))
    : 0;
  const activeTicks = durationTicks(effect.activeDuration);
  const pauseTicks = durationTicks(effect.pauseDuration);

  for (let tick = 0; tick < ticks; tick++) {
    if (state.remainingTicks > 0 && --state.remainingTicks === 0) {
      state.finished = true;
      break;
    }
    if (effect.activeDuration <= 0 && effect.pauseDuration <= 0) continue;

    state.phaseTicks++;
    if (state.active) {
      if (state.phaseTicks >= activeTicks) {
        state.phaseTicks = 0;
        if (pauseTicks > 0) state.active = false;
        if (specialMode) state.direction = state.direction === 1 ? -1 : 1;
      }
      if (!state.active) continue;

      let scale = 1;
      if (effect.mode === 1) {
        if (activeTicks <= 0) continue;
        scale = Math.min(state.phaseTicks, activeTicks - state.phaseTicks) / activeTicks;
      }
      nativeU += effect.uPerTick * state.direction * scale;
      nativeV += effect.vPerTick * state.direction * scale;
    } else if (pauseTicks <= state.phaseTicks && activeTicks > 0) {
      state.phaseTicks = 0;
      state.active = true;
    }
  }
  return [nativeU, -nativeV];
}

/** Decode one texture-flip property without relying on its optional semantic label. */
export function textureFlipFromNode(node: EffectNode): TextureFlipEffect | null {
  const type0 = object(node.payload.type0) ? node.payload.type0 : null;
  if (node.mainType !== 0 || !type0 || (type0.SubType !== 11 && node.semanticType !== 'property.texture-flip')) return null;
  const raw = object(type0.TextureFlip) ? type0.TextureFlip : null;
  if (!raw) return null;
  return {
    direction: finite(raw.Direction),
    speed: Math.max(0, finite(raw.Speed)),
    length: Math.max(0, finite(raw.Length)),
    dwell: finite(raw.U4) !== 0,
  };
}

export function textureFlipFromGraph(graph: EffectGraph | null | undefined): TextureFlipEffect | null {
  if (!graph) return null;
  for (const node of graph.nodes) {
    const effect = textureFlipFromNode(node);
    if (effect) return effect;
  }
  return null;
}

export function crowdBoxFromNode(node: EffectNode): boolean {
  const type0 = object(node.payload.type0) ? node.payload.type0 : null;
  return node.mainType === 0 && !!type0
    && (type0.SubType === 17 || node.semanticType === 'property.crowd-box');
}

export function crowdBoxFromGraph(graph: EffectGraph | null | undefined): boolean {
  return !!graph?.nodes.some(crowdBoxFromNode);
}

/** Decode the model-animation property from its raw portable payload. */
export function animObjectFromNode(node: EffectNode): AnimObjectEffect | null {
  const type0 = object(node.payload.type0) ? node.payload.type0 : null;
  if (node.mainType !== 0 || !type0
    || (type0.SubType !== 256 && node.semanticType !== 'property.anim-object')) return null;
  const raw = object(type0.type0Sub256) ? type0.type0Sub256 : null;
  if (!raw) return null;
  return {
    loopMode: finite(raw.U0),
    startFrame: finite(raw.U1, -1),
    endFrame: finite(raw.U2, -1),
    rate: finite(raw.U3),
    randomRateUpper: finite(raw.U4),
    randomStart: finite(raw.U6) !== 0,
    reverse: finite(raw.U7) === 4,
  };
}

/** Decode the delta-gated variant of the model-animation player. Its payload is layout-compatible with
 * AnimObject, but the clock starts frozen and advances only while control command 2 has granted budget. */
export function animDeltaFromNode(node: EffectNode): AnimObjectEffect | null {
  const type0 = object(node.payload.type0) ? node.payload.type0 : null;
  if (node.mainType !== 0 || !type0
    || (type0.SubType !== 257 && node.semanticType !== 'property.anim-delta')) return null;
  const raw = object(type0.type0Sub257) ? type0.type0Sub257 : null;
  if (!raw) return null;
  return {
    loopMode: finite(raw.U0),
    startFrame: finite(raw.U1, -1),
    endFrame: finite(raw.U2, -1),
    rate: finite(raw.U3),
    randomRateUpper: finite(raw.U4),
    randomStart: finite(raw.U6) !== 0,
    reverse: finite(raw.U7) === 4,
  };
}

/** Decode the combo variant. Its first eight words are the shared AnimObject record — the same fields at the
 * same offsets, read by the same engine init — and the four after them describe the triggered window. */
export function animComboFromNode(node: EffectNode): AnimComboEffect | null {
  const type0 = object(node.payload.type0) ? node.payload.type0 : null;
  if (node.mainType !== 0 || !type0
    || (type0.SubType !== 258 && node.semanticType !== 'property.anim-combo')) return null;
  const raw = object(type0.type0Sub258) ? type0.type0Sub258 : null;
  if (!raw) return null;
  const end = finite(raw.U11);
  return {
    loopMode: finite(raw.U0),
    startFrame: finite(raw.U1, -1),
    endFrame: finite(raw.U2, -1),
    rate: finite(raw.U3),
    randomRateUpper: finite(raw.U4),
    randomStart: finite(raw.U6) !== 0,
    reverse: finite(raw.U7) === 4,
    comboStartFrame: finite(raw.U8, -1),
    comboEndFrame: finite(raw.U9, -1),
    comboRate: finite(raw.U10),
    comboEnd: end === 0 ? 'resume' : end < 0 ? 'hold-combo' : 'freeze',
  };
}

export function animComboFromGraph(graph: EffectGraph | null | undefined): AnimComboEffect | null {
  if (!graph) return null;
  for (const node of graph.nodes) {
    const effect = animComboFromNode(node);
    if (effect) return effect;
  }
  return null;
}

export function animObjectFromGraph(graph: EffectGraph | null | undefined): AnimObjectEffect | null {
  if (!graph) return null;
  for (const node of graph.nodes) {
    const effect = animObjectFromNode(node);
    if (effect) return effect;
  }
  return null;
}

export function animDeltaFromGraph(graph: EffectGraph | null | undefined): AnimObjectEffect | null {
  if (!graph) return null;
  for (const node of graph.nodes) {
    const effect = animDeltaFromNode(node);
    if (effect) return effect;
  }
  return null;
}

export function animObjectEffectKey(effect: AnimObjectEffect | null | undefined): string {
  const combo = effect && isAnimComboEffect(effect)
    ? `:combo:${effect.comboStartFrame}:${effect.comboEndFrame}:${effect.comboRate}:${effect.comboEnd}` : '';
  return effect ? [effect.loopMode, effect.startFrame, effect.endFrame, effect.rate,
    effect.randomRateUpper, effect.randomStart ? 1 : 0, effect.reverse ? 1 : 0].join(':') + combo : 'static';
}

export function isAnimComboEffect(effect: AnimObjectEffect | null | undefined): effect is AnimComboEffect {
  return !!effect && 'comboEnd' in effect;
}

export interface AnimObjectPlayback {
  frame: number;
  direction: 1 | -1;
  framesPerSecond: number;
  startFrame: number;
  endFrame: number;
}

/** A dispatched AnimObject one-shot. In Play, Unity holds a triggered prop at the far end for eight seconds
 * and then plays the same clip backward; inspector Preview retains its existing finish-or-latch behavior. */
export interface TriggeredAnimObjectPlayback {
  effect: AnimObjectEffect;
  playback: AnimObjectPlayback;
  phase: 'outbound' | 'hold' | 'return' | 'done';
  remaining: number;
  outboundSeconds: number;
  holdAtEnd: boolean;
  autoReturnDelay: number | null;
}

export interface TriggeredAnimObjectSample {
  frame: number;
  done: boolean;
}

export interface AnimDeltaPlayback extends AnimObjectPlayback {
  budgetSeconds: number;
}

export interface AnimComboPlayback extends AnimObjectPlayback {
  /** Resolved triggered-window bounds and rate, fixed at construction like the idle window's. */
  comboStart: number;
  comboEnd: number;
  comboFramesPerSecond: number;
  /** Combo clock in clip frames. Only meaningful while `active` or while holding a latched combo pose. */
  comboFrame: number;
  active: boolean;
  /** Set when the combo has run once on a node whose end behaviour latches it. A latched node stops
   *  advancing its idle clip entirely and refuses further triggers, exactly as the engine's does. */
  latched: boolean;
  /** Idle-clip frame the pose snapshot was taken at. The combo pose is drawn composed onto this one. */
  snapshotFrame: number;
}

/** What to draw this tick: the clip frame to sample, and — when the combo is running — the idle frame whose
 *  pose it must be composed onto. `basis` null is an ordinary single-pose sample. */
export interface AnimComboSample {
  frame: number;
  basis: number | null;
}

function playbackRandom(seed: number): number {
  let x = (seed | 0) || 1;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return (x >>> 0) / 0x100000000;
}

/**
 * Resolve negative/full-clip windows and native random start/rate once, as the game does at init.
 *
 * A window that ends at or before it starts is NOT widened to the whole clip. On hardware such a
 * window simply plays nothing — the prop holds at its start frame — and `stepAnimObjectPlayback`
 * reproduces that by refusing to advance a non-positive width. Repairing it here would animate a
 * prop in the editor that stands still on the disc, which is the one failure this player must not
 * hide: it looks like authored intent rather than a dead payload.
 */
export function createAnimObjectPlayback(effect: AnimObjectEffect, clipFrames: number,
  seed = 1): AnimObjectPlayback {
  const clipEnd = Math.max(0, clipFrames);
  const startFrame = effect.startFrame < 0 ? 0 : Math.min(clipEnd, Math.max(0, effect.startFrame));
  const endFrame = effect.endFrame < 0 ? clipEnd : Math.min(clipEnd, Math.max(0, effect.endFrame));
  const baseRate = effect.rate > 0 ? effect.rate : 30;
  const upperRate = effect.randomRateUpper > 0 ? effect.randomRateUpper : baseRate;
  const lo = Math.min(baseRate, upperRate), hi = Math.max(baseRate, upperRate);
  const rateRandom = playbackRandom(seed ^ 0x68bc21eb);
  const phaseRandom = playbackRandom(seed ^ 0x02e5be93);
  const direction: 1 | -1 = effect.reverse ? -1 : 1;
  return {
    frame: effect.randomStart ? startFrame + (endFrame - startFrame) * phaseRandom
      : direction < 0 ? endFrame : startFrame,
    direction,
    framesPerSecond: lo + (hi - lo) * rateRandom,
    startFrame,
    endFrame,
  };
}

/** Construct the bounded player shared by manual Preview and Play-triggered animated props. Auto-return is
 * meaningful only for a play-once window; wrap and ping-pong previews still run one complete cycle. */
export function createTriggeredAnimObjectPlayback(effect: AnimObjectEffect, clipFrames: number, seed: number,
  holdAtEnd: boolean, autoReturnDelay: number | null = null): TriggeredAnimObjectPlayback {
  const playback = createAnimObjectPlayback(effect, clipFrames, seed);
  const width = Math.max(0, playback.endFrame - playback.startFrame);
  const cycleFrames = width * (effect.loopMode === 2 ? 2 : 1);
  const rawDuration = playback.framesPerSecond > 0 ? cycleFrames / playback.framesPerSecond : 0;
  const outboundSeconds = Math.max(1 / 30, Math.min(60, rawDuration || 1 / 30));
  const canReturn = autoReturnDelay !== null && Number.isFinite(autoReturnDelay)
    && autoReturnDelay >= 0 && effect.loopMode !== 1 && effect.loopMode !== 2
    && width > 0 && playback.framesPerSecond > 0;
  return {
    effect, playback, phase: 'outbound', remaining: outboundSeconds, outboundSeconds, holdAtEnd,
    autoReturnDelay: canReturn ? autoReturnDelay : null,
  };
}

/** Advance through outbound -> hold -> reverse-return without losing excess frame time at a phase boundary. */
export function stepTriggeredAnimObjectPlayback(state: TriggeredAnimObjectPlayback,
  seconds0: number): TriggeredAnimObjectSample {
  let seconds = Number.isFinite(seconds0) && seconds0 > 0 ? seconds0 : 0;
  let guard = 0;
  while (state.phase !== 'done' && seconds > 0 && guard++ < 4) {
    if (state.phase === 'hold') {
      if (!Number.isFinite(state.remaining)) break;
      const active = Math.min(seconds, Math.max(0, state.remaining));
      state.remaining -= active;
      seconds -= active;
      if (state.remaining > 1e-9) break;
      state.playback.direction = state.playback.direction > 0 ? -1 : 1;
      state.phase = 'return';
      state.remaining = state.outboundSeconds;
      continue;
    }
    const active = Math.min(seconds, Math.max(0, state.remaining));
    stepAnimObjectPlayback(state.playback, state.effect, active);
    state.remaining -= active;
    seconds -= active;
    if (state.remaining > 1e-9) break;
    if (state.phase === 'outbound') {
      if (state.autoReturnDelay !== null) {
        state.phase = 'hold';
        state.remaining = state.autoReturnDelay;
      } else if (state.holdAtEnd) {
        state.phase = 'hold';
        state.remaining = Number.POSITIVE_INFINITY;
      } else state.phase = 'done';
    } else state.phase = 'done';
  }
  return { frame: state.playback.frame, done: state.phase === 'done' };
}

/** Unity Trigger(): an opening prop ignores another trigger, an open prop extends its hold, and a prop already
 * returning turns around from its current frame instead of snapping to either endpoint. */
export function retriggerTriggeredAnimObjectPlayback(state: TriggeredAnimObjectPlayback): boolean {
  if (state.autoReturnDelay === null || state.phase === 'done') return false;
  if (state.phase === 'outbound') return true;
  if (state.phase === 'hold') {
    state.remaining = state.autoReturnDelay;
    return true;
  }
  state.playback.direction = state.playback.direction > 0 ? -1 : 1;
  const boundary = state.playback.direction > 0 ? state.playback.endFrame : state.playback.startFrame;
  state.remaining = Math.abs(boundary - state.playback.frame) / state.playback.framesPerSecond;
  state.phase = 'outbound';
  return true;
}

export function createAnimDeltaPlayback(effect: AnimObjectEffect, clipFrames: number,
  seed = 1): AnimDeltaPlayback {
  return { ...createAnimObjectPlayback(effect, clipFrames, seed), budgetSeconds: 0 };
}

/**
 * Resolve the triggered window the same way the engine's constructor does, and start idle.
 *
 * The two fallbacks are NOT the same, which is the detail worth keeping: a negative combo START falls back to
 * the IDLE WINDOW'S END — "carry on from where the loop stops" — while a negative combo END falls back to the
 * whole clip. Retail spells both out anyway (61 and 100 against a 100-frame clip), so the defaults are only
 * reached by a document that leaves them blank.
 */
export function createAnimComboPlayback(effect: AnimComboEffect, clipFrames: number,
  seed = 1): AnimComboPlayback {
  const base = createAnimObjectPlayback(effect, clipFrames, seed);
  const clipEnd = Math.max(0, clipFrames);
  const comboStart = effect.comboStartFrame < 0
    ? base.endFrame : Math.min(clipEnd, Math.max(0, effect.comboStartFrame));
  const comboEnd = effect.comboEndFrame < 0
    ? clipEnd : Math.min(clipEnd, Math.max(0, effect.comboEndFrame));
  return {
    ...base,
    comboStart,
    comboEnd,
    comboFramesPerSecond: effect.comboRate > 0 ? effect.comboRate : 30,
    comboFrame: comboStart,
    active: false,
    latched: false,
    snapshotFrame: base.frame,
  };
}

/**
 * Native control command 3. Refuses while the combo is already running or the node has latched — the engine
 * tests both state bytes as one halfword, so a spent one-shot cannot be re-armed — and otherwise snapshots the
 * pose currently on screen and rewinds the combo clock to the window start.
 */
export function triggerAnimComboPlayback(state: AnimComboPlayback): boolean {
  if (state.active || state.latched) return false;
  state.snapshotFrame = state.frame;
  state.comboFrame = state.comboStart;
  state.active = true;
  return true;
}

/**
 * Advance one AnimCombo tick and report what to draw.
 *
 * The idle clock does not run while the combo does: the engine evaluates the base object without stepping it,
 * so a barrier resumes its slide from exactly where it was knocked over. The end of the window is handled in
 * the engine's order — clear `active`, latch if the payload says to, and only THEN decide the pose — which is
 * why a `resume` combo never shows its final frame and a `hold-combo` one shows nothing else ever again.
 */
export function stepAnimComboPlayback(state: AnimComboPlayback, effect: AnimComboEffect,
  dt: number): AnimComboSample {
  if (state.latched) {
    return effect.comboEnd === 'hold-combo'
      ? { frame: state.comboFrame, basis: state.snapshotFrame }
      : { frame: state.frame, basis: null };
  }
  if (!state.active) return { frame: stepAnimObjectPlayback(state, effect, dt), basis: null };

  if (dt > 0 && state.comboFramesPerSecond > 0) state.comboFrame += state.comboFramesPerSecond * dt;
  if (state.comboFrame >= state.comboEnd) {
    state.comboFrame = state.comboEnd;
    state.active = false;
    if (effect.comboEnd !== 'resume') state.latched = true;
    if (effect.comboEnd !== 'hold-combo') return { frame: state.frame, basis: null };
  }
  return { frame: state.comboFrame, basis: state.snapshotFrame };
}

/** Native control command 2 supplies clip frames; the receiver stores them as seconds at 30 fps. */
export function grantAnimDeltaPlayback(state: AnimDeltaPlayback, value: number): number {
  if (Number.isFinite(value) && value > 0) state.budgetSeconds += value / 30;
  return state.budgetSeconds;
}

/** Consume no more real time than remains in the receiver's animation budget, holding the final pose when empty. */
export function stepAnimDeltaPlayback(state: AnimDeltaPlayback, effect: AnimObjectEffect, dt: number): number {
  const active = Math.max(0, Math.min(dt, state.budgetSeconds));
  if (active <= 0) return state.frame;
  state.budgetSeconds = Math.max(0, state.budgetSeconds - active);
  return stepAnimObjectPlayback(state, effect, active);
}

/** Advance native once/wrap/ping-pong playback and return the absolute model clip frame to sample. */
export function stepAnimObjectPlayback(state: AnimObjectPlayback, effect: AnimObjectEffect, dt: number): number {
  const width = state.endFrame - state.startFrame;
  if (dt <= 0 || width <= 0 || state.framesPerSecond <= 0) return state.frame;
  const delta = state.framesPerSecond * dt * state.direction;
  if (effect.loopMode === 1) {
    state.frame = state.startFrame
      + (((state.frame + delta - state.startFrame) % width) + width) % width;
    return state.frame;
  }
  if (effect.loopMode === 2) {
    let remaining = (state.framesPerSecond * dt) % (width * 2);
    while (remaining > 0) {
      const boundary = state.direction > 0 ? state.endFrame : state.startFrame;
      const available = Math.abs(boundary - state.frame);
      if (remaining <= available) {
        state.frame += remaining * state.direction;
        remaining = 0;
      } else {
        state.frame = boundary;
        remaining -= available;
        state.direction = state.direction > 0 ? -1 : 1;
      }
    }
    return state.frame;
  }
  state.frame = Math.min(state.endFrame, Math.max(state.startFrame, state.frame + delta));
  return state.frame;
}

/** Collect every supported always-on material property in graph order. */
export function materialWorldEffectsFromGraph(graph: EffectGraph | null | undefined,
  mat?: number): MaterialWorldEffects | null {
  if (!graph) return null;
  const uvScroll = uvScrollFromGraph(graph, mat) ?? undefined;
  const crowd = crowdBoxFromGraph(graph);
  const textureFlip = crowd
    ? { direction: 0, speed: CROWD_FRAMES_PER_SECOND * 2, length: 0, dwell: false }
    : textureFlipFromGraph(graph) ?? undefined;
  return uvScroll || textureFlip || crowd ? { uvScroll, textureFlip, ...(crowd ? { crowd: true } : {}) } : null;
}

/** The always-on material law ONE node installs. `materialWorldEffectsFromGraph` answers the same question
 * for a whole chain, where a scroll and a flipbook may arrive on different nodes; the graph runner walks the
 * chain itself and so asks per node — which node it is deciding what Preview starts. */
export function materialWorldEffectsFromNode(node: EffectNode): MaterialWorldEffects | null {
  const uvScroll = uvScrollFromNode(node) ?? undefined;
  const crowd = crowdBoxFromNode(node);
  const textureFlip = crowd
    ? { direction: 0, speed: CROWD_FRAMES_PER_SECOND * 2, length: 0, dwell: false }
    : textureFlipFromNode(node) ?? undefined;
  return uvScroll || textureFlip || crowd ? { uvScroll, textureFlip, ...(crowd ? { crowd: true } : {}) } : null;
}

/** Find the material property a graph installs on its bound object. Property construction is last-writer-wins
 * in the native runtime, so graph order — not the command number — selects the receiver. A UVScroll receiver
 * survives authored rates of zero: Merqury City's strike sequence uses one as a phase-only state machine and
 * drives it through command 6. */
export function materialControlFromGraph(graph: EffectGraph | null | undefined): MaterialControl | null {
  if (!graph) return null;
  let receiver: MaterialControlReceiver | null = null;
  let staticUv: UvScrollEffect | null = null;
  for (const node of graph.nodes) {
    const uv = uvScrollReceiverFromNode(node);
    if (uv) { receiver = 'uv-scroll'; staticUv = uv; }
    if (textureFlipFromNode(node)) receiver = 'texture-flip';
  }
  const effect = receiver ? materialWorldEffectsFromGraph(graph)
    ?? (receiver === 'uv-scroll' && staticUv ? { uvScroll: staticUv } : null) : null;
  return receiver && effect ? { receiver, effect } : null;
}

/** Stable renderer/cache identity. Dwell seeds deliberately split instances because their random holds drift. */
export function materialWorldEffectsKey(effect: MaterialWorldEffects | null | undefined): string {
  if (!effect) return 'static';
  const uv = effect.uvScroll;
  const flip = effect.textureFlip;
  return [
    uv ? `uv:${uv.mode}:${uv.uPerTick}:${uv.vPerTick}:${uv.activeDuration}:${uv.pauseDuration}:${uv.lifetime}` : '',
    flip ? `flip:${flip.direction}:${flip.speed}:${flip.length}:${flip.dwell ? 1 : 0}:${flip.seed ?? 0}` : '',
    effect.crowd ? 'crowd' : '',
  ].filter(Boolean).join('|') || 'static';
}

export interface TextureFlipPlayback {
  frame: number;
  phase: number;
  dwellPhase: 'hold' | 'flash';
  remaining: number;
  randomState: number;
  /** Seconds left on a one-shot's node. Zero is the resting state of a pulse flip and the permanent state of
   *  an always-on one, whose frames advance off the world clock instead of a node lifetime. */
  life: number;
}

/** Fresh native-style playback: frame zero, with the first dwell exactly 1 / speed seconds. A pulse flip has
 *  no node until a graph builds one, so it rests on frame zero and advances nothing. */
export function createTextureFlipPlayback(effect: TextureFlipEffect): TextureFlipPlayback {
  return {
    frame: 0,
    phase: 0,
    dwellPhase: 'hold',
    remaining: effect.dwell && effect.speed > 0 ? 1 / effect.speed : 0,
    randomState: ((effect.seed ?? 1) | 0) || 1,
    life: 0,
  };
}

/** Construct the one-shot node a graph's TextureFlip property installs, starting its lifetime. The frame it
 *  shows comes from the paired MainType-3 frame select in the same graph — retail's constructor reads its own
 *  U0, which every authored pulse leaves at the resting frame. Always-on flips build no node and ignore this. */
export function startTextureFlipPulse(state: TextureFlipPlayback, effect: TextureFlipEffect): boolean {
  if (!isTextureFlipPulse(effect)) return false;
  state.life = effect.length;
  state.phase = 0;
  return true;
}

/** Native TextureFlip command 2 selects an absolute flipbook frame. Retail countdown graphs author integral
 * values, but clamping here keeps malformed/custom documents from addressing outside the loaded frame bank. */
export function selectTextureFlipPlaybackFrame(state: TextureFlipPlayback, frameCount: number,
  value: number): boolean {
  if (frameCount <= 0 || !Number.isFinite(value)) return false;
  const frame = Math.min(frameCount - 1, Math.max(0, Math.trunc(value)));
  const changed = state.frame !== frame;
  state.frame = frame;
  state.phase = 0;
  return changed;
}

function nextRandom(state: TextureFlipPlayback): number {
  // Small deterministic xorshift: stable previews/tests, while different prop seeds still drift independently.
  let x = state.randomState | 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  state.randomState = x || 1;
  return (state.randomState >>> 0) / 0x100000000;
}

/**
 * Advance a running one-shot. The node steps its flipbook on the same accumulator as an always-on flip and
 * then dies, handing the instance back to the placed material on frame zero. Retail's authored pulses take an
 * ODD number of steps across a two-frame material, so that hand-off lands on the frame already showing and
 * the death itself is invisible.
 */
function stepTextureFlipPulse(state: TextureFlipPlayback, effect: TextureFlipEffect, frameCount: number,
  dt: number): boolean {
  if (state.life <= 0) return false;
  const active = Math.min(dt, state.life);
  state.life -= active;
  const before = state.frame;
  state.phase += effect.speed * active;
  const steps = Math.floor(state.phase);
  if (steps) {
    state.phase -= steps;
    const direction = effect.direction === 0 ? 1 : -1;
    state.frame = ((state.frame + direction * steps) % frameCount + frameCount) % frameCount;
  }
  if (state.life <= 0) {
    state.life = 0;
    state.phase = 0;
    state.frame = 0;
  }
  return state.frame !== before;
}

/** Advance recovered flipbook timing. Returns true when the visible frame changed. */
export function stepTextureFlipPlayback(state: TextureFlipPlayback, effect: TextureFlipEffect,
  frameCount: number, dt: number): boolean {
  if (frameCount < 2 || effect.speed <= 0 || dt <= 0) return false;
  if (isTextureFlipPulse(effect)) return stepTextureFlipPulse(state, effect, frameCount, dt);
  let changed = false;
  if (!effect.dwell) {
    state.phase += effect.speed * dt;
    const steps = Math.floor(state.phase);
    if (!steps) return false;
    state.phase -= steps;
    const direction = effect.direction === 0 ? 1 : -1;
    state.frame = ((state.frame + direction * steps) % frameCount + frameCount) % frameCount;
    return true;
  }

  // All retail dwell flips found so far are two-frame warning screens. Preserve the exact recovered holds:
  // first frame 1/speed, flash frame 0.1 s (a fixed six ticks), then a randomised (1/speed)/u hold, u in [0.25, 1).
  let remainingDt = dt;
  while (remainingDt >= state.remaining && state.remaining > 0) {
    remainingDt -= state.remaining;
    if (state.dwellPhase === 'hold') {
      state.dwellPhase = 'flash';
      state.frame = Math.min(1, frameCount - 1);
      state.remaining = 0.1;
    } else {
      state.dwellPhase = 'hold';
      state.frame = 0;
      state.remaining = (1 / effect.speed) / (0.25 + nextRandom(state) * 0.75);
    }
    changed = true;
  }
  state.remaining = Math.max(0.000001, state.remaining - remainingDt);
  return changed;
}
