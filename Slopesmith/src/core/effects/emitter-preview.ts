import type { V3 } from '../doc/types';
import type { EffectNode, JsonValue } from './document';
import { particleEmitterFields } from './authoring';
import { emitterColorStopsFromNativeArgb, type RgbaColor } from './emitter-colors';

export type { RgbaColor } from './emitter-colors';

/** Safety limits for the editor preview. The native emitter law is decoded below; these only bound pathological
 * authored values and keep a corrupt effect from exhausting the viewport. */
export const PERSISTENT_EMITTER_MAX_RATE = 200;
export const PERSISTENT_EMITTER_SENTINEL_LIFE = 3;
/** A one-shot event and a continuous plume both draw at their authored world size; only opacity distinguishes
 * them. An interactive preview (manual Preview, Play) floors its alpha so a short-lived spark stays legible,
 * while continuous ambient emitters retain their authored relative density and opacity. */
export const EVENT_EMITTER_SIZE_SCALE = 1;
export const INTERACTIVE_EMITTER_ALPHA_FLOOR = 0.45;
/**
 * Authored size (`U4 ± U6/2`) is a HALF-extent in native units, so a drawn sprite is twice as wide: P6 emits
 * each billboard's corners at `center ∓ extent` [Trailmap: 180-particles-data]. The engine hands the renderer
 * that pair unscaled — a live PCSX2 frame of MEGAPLE's exhaust fan carries 7.5/12.5 for an authored
 * `U4`=10, `U6`=5, while scaling the emitter's lifetime by `U3` and its gravity by `1/U3²` in the same record.
 */
export const NATIVE_SIZE_TO_METRES = 2 / 100;

export interface TimerEmitterPreviewLaw {
  count: number;
  trailCopies: number;
  rate: number;
  emissionDuration: number;
  timeScale: number;
  particleLifeCenter: number;
  particleLifeSpan: number;
  sizeCenter: number;
  sizeSpan: number;
  trailStep: number;
  spawnAxes: readonly [V3, V3];
  velocityBase: V3;
  velocityAxes: readonly [V3, V3, V3];
  gravity: V3;
  colors: readonly RgbaColor[];
  spriteIndex: number;
  blendSelector: number;
}

/** Runtime name-table order shared by SSF emitters, board spray, and the extracted PARTICLE.SSH bank.
 * Retail-derived identifier facts, carried as interoperability data; the RETAIL-DERIVED FACTS section
 * of Slopesmith/NOTICE states the scope. */
export const PARTICLE_SPRITE_NAMES = [
  'part', 'snfl', 'clod', 'spry', 'halo', 'brk1', 'brk2', 'brk3',
  'ndl1', 'ndl2', 'swd1', 'swd2', 'swp1', 'swp2', 'cnf1', 'cnf2',
  'blb1', 'blb2', 'str1', 'str2', 'str3', 'nois', 'strk', 'tral',
  'ex06', 'ex07', 'ex08', 'ex09', 'lens', 'blnk', 'mip1', 'mip1',
  'mip2', 'beam', 'fog0', 'spec', 'envr', 'exlm',
] as const;

const finite = (fields: Record<string, JsonValue>, key: string, fallback = 0): number => {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

/** How a layer's particles reach the framebuffer. `darken` is a real third case, not a dim alpha: the engine
 *  multiplies the framebuffer toward black by the particle's alpha and ignores its colour entirely, which is
 *  what makes a lit road flare stream near-black smoke [Trailmap: 180-particles-data]. */
export type EmitterBlendMode = 'additive' | 'alpha' | 'darken';

/** The engine remaps the authored `U50` selector through this table before configuring the GS blend state; it is
 * the same table snowknife carries in `SsfLogic.BlendMode()` for the Unity bundle, kept here so the editor
 * preview and the imported world agree on what a layer does. */
const BLEND_REMAP = [5, 3, 2, 1, 4, 0, 6, 7] as const;

/** Classify an authored blend selector the way the importer does: remapped GS mode 4 darkens, 3 alpha-blends,
 * and every other mode draws additively. */
export function emitterBlendMode(blendSelector: number): EmitterBlendMode {
  const selector = Math.max(0, Math.round(Number.isFinite(blendSelector) ? blendSelector : 0));
  const mode = selector < BLEND_REMAP.length ? BLEND_REMAP[selector] : 5;
  return mode === 4 ? 'darken' : mode === 3 ? 'alpha' : 'additive';
}

/** Whether a layer's authored RGB reaches the framebuffer at all. A darkening layer's does not — the mode
 * multiplies toward black by the particle's alpha and ignores colour — so a renderer packs those particles
 * black and lets alpha alone say how far the frame darkens. The Unity importer drops the same colour. */
export const emitterBlendKeepsColor = (blend: EmitterBlendMode): boolean => blend !== 'darken';

/** The inspector's name for an authored selector. Only the three selectors the corpus authors are named; any
 * other value keeps its number rather than claiming a behaviour the data has not shown. */
export function emitterBlendLabel(blendSelector: number): string {
  const selector = Math.max(0, Math.round(Number.isFinite(blendSelector) ? blendSelector : 0));
  return selector === 0 ? 'Additive' : selector === 1 ? 'Alpha blend'
    : selector === 4 ? 'Darkening' : `Unnamed mode ${selector}`;
}

/** Decode timer- or collision-emitter fields into the renderer-neutral law evaluated by VU program P6. Raw
 * vectors stay in SSX units so the owning instance can transform them with w=0 at the viewport boundary. */
export function timerEmitterPreviewLaw(node: EffectNode): TimerEmitterPreviewLaw | null {
  const fields = particleEmitterFields(node);
  if (!fields) return null;
  const count = Math.max(1, Math.round(finite(fields, 'U0', 12)));
  const vector = (i: number): V3 =>
    [finite(fields, `U${i}`), finite(fields, `U${i + 1}`), finite(fields, `U${i + 2}`)];
  const particleLifeCenter = finite(fields, 'U5');
  const particleLifeSpan = Math.max(0, finite(fields, 'U7'));
  const occupancyWindow = Math.max(0.05, particleLifeCenter + particleLifeSpan * 0.5);
  const colors = emitterColorStopsFromNativeArgb(fields);
  return {
    count,
    trailCopies: Math.max(1, Math.min(10, Math.round(finite(fields, 'U1', 1)))),
    rate: Math.max(2, Math.min(PERSISTENT_EMITTER_MAX_RATE, count / occupancyWindow)),
    emissionDuration: finite(fields, 'U2', 0.6),
    timeScale: finite(fields, 'U3', 1),
    particleLifeCenter,
    particleLifeSpan,
    sizeCenter: finite(fields, 'U4', 100),
    sizeSpan: Math.max(0, finite(fields, 'U6')),
    trailStep: Math.max(0, finite(fields, 'U8')),
    spawnAxes: [vector(12), vector(15)],
    velocityBase: vector(18),
    velocityAxes: [vector(21), vector(24), vector(27)],
    gravity: [finite(fields, 'U30'), finite(fields, 'U31'), finite(fields, 'U32')],
    colors,
    spriteIndex: Math.max(0, Math.round(finite(fields, 'U49'))),
    blendSelector: Math.max(0, Math.round(finite(fields, 'U50'))),
  };
}

/** P6 gives each particle a life in U5 +/- U7/2. U2 is the window over which the U0 particles start and is not
 * added to their individual lifetime; its SIGN selects the mode — negative streams without end, non-negative
 * releases the count once over those seconds ([Trailmap: 180-particles-data]). */
export function timerEmitterPreviewLifetime(law: TimerEmitterPreviewLaw, persistent: boolean,
  random01 = 0.5): number {
  if (persistent && law.particleLifeCenter <= 0 && law.particleLifeSpan <= 0)
    return PERSISTENT_EMITTER_SENTINEL_LIFE * (0.8 + Math.max(0, Math.min(1, random01)) * 0.4);
  const random = Math.max(0, Math.min(1, random01));
  const duration = law.particleLifeCenter + (random - 0.5) * law.particleLifeSpan;
  return Math.max(0.05, Math.min(10, duration));
}

export interface TimerEmitterParticleSample { spawnOffset: V3; velocity: V3 }

/** MainType-2/SubType-2 does not preserve the authored base-velocity direction. Its constructor takes only
 * the vector's length, then points that speed along the live outward contact normal. The three variation
 * axes are applied later and remain authored, so callers replace only `velocityBase` with this result. */
export function collisionEmitterContactVelocityBase(authoredBase: readonly number[],
  contactNormal: readonly number[]): V3 {
  const speed = Math.hypot(authoredBase[0] ?? 0, authoredBase[1] ?? 0, authoredBase[2] ?? 0);
  const length = Math.hypot(contactNormal[0] ?? 0, contactNormal[1] ?? 0, contactNormal[2] ?? 0);
  if (length < 1e-9 || speed < 1e-9) return [0, 0, 0];
  return [contactNormal[0] / length * speed, contactNormal[1] / length * speed,
    contactNormal[2] / length * speed];
}

/** Reproduce the constructor's two centered spawn axes and base-plus-three-axis velocity box. The VU RNG emits
 * [1,2); the constructor subtracts 1.5 of each axis up front, which is exactly a [-0.5,+0.5] coefficient here. */
export function timerEmitterPreviewSample(law: TimerEmitterPreviewLaw,
  random: () => number = Math.random): TimerEmitterParticleSample {
  const centered = () => Math.max(0, Math.min(1, random())) - 0.5;
  const sa = centered(), sb = centered();
  const va = centered(), vb = centered(), vc = centered();
  const spawnOffset: V3 = [0, 0, 0];
  const velocity: V3 = [...law.velocityBase];
  for (let component = 0; component < 3; component++) {
    spawnOffset[component] = law.spawnAxes[0][component] * sa + law.spawnAxes[1][component] * sb;
    velocity[component] += law.velocityAxes[0][component] * va
      + law.velocityAxes[1][component] * vb + law.velocityAxes[2][component] * vc;
  }
  return { spawnOffset, velocity };
}

/** Physical start delay for particle i. P6 subtracts (U2*U3/U0) from its internal age for each particle; age
 * itself advances by U3, so U3 cancels and the authored-world delay is i*U2/U0 seconds. */
export function timerEmitterPreviewStartDelay(law: TimerEmitterPreviewLaw, index: number): number {
  if (law.emissionDuration <= 0) return 0;
  return law.emissionDuration * Math.max(0, index) / Math.max(1, law.count);
}

/** P6's shared parametric trajectory, before the owning instance transforms it. The constructor stores gravity
 * divided by U3^2 and velocity divided by U3; P6 evaluates the same -0.73t+0.113t^2 curve for every effect. */
export function timerEmitterPreviewTrajectoryOffset(law: TimerEmitterPreviewLaw, velocity: V3,
  ageSeconds: number): V3 {
  const timeScale = Math.abs(law.timeScale) < 1e-6 ? 1 : law.timeScale;
  const age = Math.max(0, ageSeconds) * timeScale;
  const curvedAge = Math.min(2.7, age);
  const curve = -0.73 * curvedAge + 0.113 * curvedAge * curvedAge;
  const result: V3 = [0, 0, 0];
  for (let component = 0; component < 3; component++) {
    const gravity = law.gravity[component] / (timeScale * timeScale);
    result[component] = gravity * age + (gravity - velocity[component] / timeScale) * curve;
  }
  return result;
}

/** World-space sprite-width range for the CPU preview. A continuous plume is already readable through repeated
 * emission; a one-shot event needs a small visibility boost so short-lived sparks survive perspective scaling. */
export function timerEmitterPreviewSizeRange(law: TimerEmitterPreviewLaw, hostSizeScale = 1,
  continuous = false): { min: number; max: number } {
  const visibilityScale = continuous ? 1 : EVENT_EMITTER_SIZE_SCALE;
  const min = Math.max(0.03, (law.sizeCenter - law.sizeSpan * 0.5) * NATIVE_SIZE_TO_METRES * hostSizeScale)
    * visibilityScale;
  const max = Math.max(min, (law.sizeCenter + law.sizeSpan * 0.5) * NATIVE_SIZE_TO_METRES * hostSizeScale
    * visibilityScale);
  return { min, max };
}

/** Preserve authored alpha for ambient scenery, but keep a manually previewed or Play-triggered event legible.
 * Lifetime fading is applied separately by the renderer, so interactive particles still fade in and out. */
export function timerEmitterPreviewOpacity(authoredAlpha: number, interactive: boolean): number {
  const alpha = Number.isFinite(authoredAlpha) ? Math.max(0, authoredAlpha) : 0;
  return interactive ? Math.max(INTERACTIVE_EMITTER_ALPHA_FLOOR, alpha) : alpha;
}
