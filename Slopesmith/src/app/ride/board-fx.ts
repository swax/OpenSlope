import * as THREE from 'three';
import type { RideGear } from './gear';
import { groundRestDepth, surfaceFor } from './physics-math';
import type { WalkGroundQuery } from './xr/walk';
import { BoardBoostTrail } from './boost-trail';

/**
 * Local-player board feedback: the boost afterimage, carved wake and the retail board's five snow-spray buffers,
 * each rebuilt from the recovered engine model ([Trailmap: boost-trail; 380-carve-effects]).
 *
 * The five buffers, in the engine's own draw order, and what each one is for:
 *
 *  - **carve plume** (64 puffs): one soft `ex06-09` puff per 0.7 m of travel while carving (or on powder,
 *    lean-independent), 1.6 m wide at birth growing to 8 m over its 2 s life, peak alpha `0.2·|lean|`. The broad
 *    haze that hangs behind a carve.
 *  - **spray sheet** (75 columns): the "sheet of snow shooting out the side" — a connected `spry` ribbon whose
 *    four rails launch up-and-out of the turn at 1×/2×/3× a throw speed that ramps with the carve, then curl
 *    down under their own gravity/drag. Committed every 0.25 m, 0.9 s life.
 *  - **surface ring** (40 slots): the per-surface chunks (`blb1` snow / `swp2` off-track / `str3` powder /
 *    `cnf2` ice). Small (≈3.5 cm × the record's "lifetime" column), alpha-blended, and **thrown**: each slot
 *    expands into `count` billboards that fly along a random blend of the board's own velocity and a lateral
 *    throw that tilts from sideways toward straight up as the lean deepens, decelerating over ~0.5 s. A hard
 *    powder carve puts several billboards in one slot at 60 slots/s — the rooster tail. Airborne, the same ring
 *    puffs `swp2` from the tail (70→10 decaying scalar) — the takeoff dust.
 *  - **landing cloud** (30 puffs): big faint `ex06-09` squares (2.4 m → 5 m) that rise up the contact normal over
 *    2 s. Touchdown fires an immediate burst and seeds an activity accumulator that keeps them coming every 2–3
 *    frames for ~1.5 s; hard sideways skids feed the same accumulator. This is the impact dome.
 *  - **powder cloud** (64 puffs): 0.3–0.44 m puffs, count ∝ speed, that ride WITH the board on powder (every puff
 *    is re-placed off the current contact frame each frame, sliding backward at 2 m/s), fading over ~0.45 s.
 *  - **sparks**: on rock/metal and on rails the same ring switches to its hard-surface gate: orange-yellow
 *    `part` dots, each a seven-copy comet trail, thrown up-back-and-sideways off the contact and pulled down
 *    at 20 m/s², about one a frame with a 17-spark flare roughly once a second.
 *
 * This module is deliberately owned by TestRide, not by the shared physics model: AI riders use that model too,
 * and click-dropped opponents must not allocate particle pools or leave wakes behind them.
 */

export interface BoardFxFrame {
  pos: THREE.Vector3;
  fwd: THREE.Vector3;
  vel: THREE.Vector3;
  normal: THREE.Vector3;
  grounded: boolean;
  /** Signed deck-to-surface clearance from the ride probe. Unity lets the wake bridge brief grounded-state
   *  flickers while the snow is still close below, but keeps spray tied to true contact. */
  surfaceGap: number;
  grinding: boolean;
  surf: number;
  lean: number;
  /** The pose that was actually drawn this frame. Boost history must follow flips/bank, not the contact frame. */
  boardPosition: THREE.Vector3;
  boardQuaternion: THREE.Quaternion;
  /** One signal shared by held snow boost, pad boost and Slopesmith's board-pointed air boost. */
  boostActive: boolean;
  boostEnergy: number;
  padBoost: boolean;
  boostDirection: THREE.Vector3;
}

// ---- wake (unchanged: the alpha-blended groove ribbon) ----
const WAKE_MAX = 56;
const WAKE_CROSS = 20;
const WAKE_LIFE = 0.9;
const WAKE_SPACING = 0.28;
const WAKE_RESTART_GAP = 2;
const WAKE_MIN_SPEED = 1;
const WAKE_GROUND_REACH = 0.9;
const WAKE_HEIGHT = 0.03;
const WAKE_DARKEN = 0.06;
const WAKE_SUN_SPLIT = 0.30;
const BOARD_HALF_LENGTH = 1.35 * 0.5;
const BOARD_HALF_WIDTH = 0.40 * 0.5;
const SKI_HALF_LENGTH = 1.70 * 0.5;
const SKI_PAIR_HALF_WIDTH = 0.15;
const SKI_TRACK_HALF_SPAN = 0.105;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_DOWN = new THREE.Vector3(0, -1, 0);
const WAKE_SUN = new THREE.Vector3(-0.533, 0, -0.308).normalize();

// ---- shared spray constants ----
/** The engine ticks its rings at 60 Hz; emission counts below are per tick and are carried across frames. */
const TICK_HZ = 60;
const SPRAY_MIN_SPEED = 1.5;
/** Metres per engine unit. Positions, velocities and the three EE-side sprite sizes are all 100 u = 1 m. */
const U = 0.01;
/**
 * The P6 billboard half-extent: the VU1 microprogram adds `const6.x · size` to the projected centre before its
 * perspective divide, and that resident constant reads (0.924, 1.232) against a projection whose x-scale is 0.528.
 * `size` is the record's *lifetime* column times a per-billboard random in [0.8, 1.2) — the record's "size"
 * column is that buffer's fade TIME. Net: full width ≈ 3.5 cm per lifetime unit (snow 10 cm, powder 27 cm,
 * ice 4 cm), matching the live speck sizes.
 */
const P6_SIZE_SCALE = 2 * 0.924 / 0.528 * U;
/** P6 ages a slot at `r = 5` engine seconds per wall second; its drag curve is written against that clock. */
const P6_RATE = 5;
const P6_CURVE_CLAMP = 2.7;
const P6_GRAVITY = -100 * U / (P6_RATE * P6_RATE); // qw5 = gravity / r², world-down
/** Every additive buffer draws white at GS 128 (= 1.0). Kept as one knob because monitors are not a PS2 on a CRT. */
const SPRAY_BRIGHTNESS = 1.0;

// Sprite atlas: the shared PARTICLE.SSH names each buffer binds, in a 4×3 grid (headless tests keep a 1×1 white).
const BOARD_SPRITE_COLUMNS = 4;
const BOARD_SPRITE_CELL = 128;
const BOARD_SPRITES = [
  'ex06', 'ex07', 'ex08', 'ex09', 'spry', 'blb1', 'swp2', 'str3', 'cnf2', 'part',
] as const;
const BOARD_SPRITE_ROWS = Math.ceil(BOARD_SPRITES.length / BOARD_SPRITE_COLUMNS);
const BOARD_SPRITE = {
  ex06: 0, spry: 4, snow: 5, offTrack: 6, powder: 7, ice: 8, grit: 9,
} as const;

/** The material table's spray columns for the surfaces that spray (rate 0 rows spray nothing at all). */
interface SurfaceSprayRow {
  /** `spray_emit_rate`: sprites per tick per unit of the carve motion scalar. */
  rate: number;
  /** `spray_lifetime_base`: NOT a lifetime — P6 reads it as the billboard size (×[0.8,1.2)). */
  size: number;
  /** `spray_size_max`: NOT a size — the slot's alpha fades to zero over exactly this many seconds. */
  fade: number;
  alpha: number;
  sprite: number;
}
const SURFACE_SPRAY: Readonly<Record<number, SurfaceSprayRow>> = {
  1: { rate: 0.0752, size: 3.008, fade: 0.2425, alpha: 0.401, sprite: BOARD_SPRITE.snow },
  2: { rate: 0.1591, size: 4.323, fade: 0.4518, alpha: 0.4066, sprite: BOARD_SPRITE.offTrack },
  3: { rate: 0.5052, size: 7.852, fade: 0.5816, alpha: 0.2310, sprite: BOARD_SPRITE.powder },
  5: { rate: 0.1999, size: 1.214, fade: 0.2695, alpha: 0.508, sprite: BOARD_SPRITE.ice },
};
/** The airborne/rail puff the same ring emits: `swp2`, size [2,4), 0.6 s fade, alpha 0.25, additive. */
const AIR_SPRAY: SurfaceSprayRow = { rate: 0, size: 3, fade: 0.6, alpha: 0.25, sprite: BOARD_SPRITE.offTrack };
/** Spray sheet per-surface columns: `trail_emit_intensity` (alpha gain) and `trail_motion_scale` (throw). */
const SHEET_ROWS: Readonly<Record<number, { gain: number; throw: number }>> = {
  1: { gain: 0.2514, throw: 1.661 }, 2: { gain: 0.6, throw: 2.0 }, 3: { gain: 0.2586, throw: 3.003 },
  4: { gain: 1.0788, throw: 3.951 }, 5: { gain: 0.00078, throw: 2.0 }, 8: { gain: 0.6, throw: 2.0 },
  15: { gain: 0.6, throw: 2.0 }, 16: { gain: 0.6, throw: 2.0 },
};
const HARD_SURFACES = new Set([9, 13, 18, 19]);
/**
 * The hard-surface spark gate. Its ring slots run a faster particle clock (r = 12), carry seven trail copies per
 * dot (each 0.084 clock units younger, alpha stepping down a seventh), and are pulled down by a real gravity of
 * 2000 u/s². The steady emit scalar is 50 (≈1 dot/frame); a 1-in-60 roll per frame fires the 1050 burst.
 */
const SPARK_RATE = 12;
const SPARK_COPIES = 7;
const SPARK_COPY_AGE_STEP = 0.084;
const SPARK_GRAVITY = -2000 * U / (SPARK_RATE * SPARK_RATE);
const SPARK_STEADY = 50;
const SPARK_BURST = 1050;
const SPARK_BURST_CHANCE = 1 / 60;
const SPARK_SPEED_CAP = 1666.67 * U;
const SPARK_SLOTS = 40;

const MAX_BILLBOARDS = 1024;
const SURFACE_SLOTS = 40;
const PLUME_SLOTS = 64;
const LANDING_SLOTS = 30;
const POWDER_SLOTS = 64;
const MAX_SPRY_COLUMNS = 75;
const SPRY_RAILS = 4;
const SPRY_LIFE = 0.9;
const SPRY_COMMIT_SPACING = 0.25;
const SPRY_DRAG = 3.5;
const SPRY_GRAVITY = 2800 * U; // rail i accelerates world-down at this × (0.25·i)²
const SPRY_LAUNCH_TILT = 0.4666; // trail_side_offset: the launch axis is lateral + this × normal
// The port also declared SPRY_MAX_COLUMNS_PER_TICK = 2 and never read it. Kept here as a lead in case it was a
// traced per-tick cap on new spray columns; if it was, the tick below does not yet enforce it.

// ---- records ----
interface WakeRow {
  centre: THREE.Vector3;
  side: THREE.Vector3;
  half: number;
  age: number;
  depth: number;
  gear: RideGear;
}

/** One 40-slot ring entry: P6 fans it into `count` billboards, each with its own stable randoms. */
interface SurfaceSlot {
  count: number;
  age: number;
  pos: THREE.Vector3;
  scatterA: THREE.Vector3;
  scatterB: THREE.Vector3;
  vBase: THREE.Vector3;
  vA: THREE.Vector3;
  vB: THREE.Vector3;
  vC: THREE.Vector3;
  size: number;
  fade: number;
  alpha: number;
  sprite: number;
  additive: boolean;
  /** Six uniform [1,2) draws per billboard: scatter A/B, velocity A/B/C, size. */
  randoms: Float32Array;
}

interface Puff {
  age: number;
  sprite: number;
  flipU: boolean;
  flipV: boolean;
}

interface PlumePuff extends Puff {
  pos: THREE.Vector3;
  up: THREE.Vector3;
  peak: number;
  knee: number;
}

interface LandingPuff extends Puff {
  near: THREE.Vector3;
  normal: THREE.Vector3;
  peak: number;
}

interface PowderPuff extends Puff {
  life: number;
  maxHalf: number;
  grow: number;
  scatterA: number;
  scatterB: number;
}

/** One spark ring entry: `count` dots, each with stable randoms for scatter, velocity, size and tint. */
interface SparkSlot {
  count: number;
  age: number;
  fade: number;
  pos: THREE.Vector3;
  scatterA: THREE.Vector3;
  scatterB: THREE.Vector3;
  vBase: THREE.Vector3;
  vA: THREE.Vector3;
  vB: THREE.Vector3;
  vC: THREE.Vector3;
  /** Eight uniform [1,2) draws per dot: scatter A/B, velocity A/B/C, size, green, blue. */
  randoms: Float32Array;
}

interface SpryColumn {
  points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  velocities: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  age: number;
  alpha: number;
  u: number;
}

/** Unity's trail updater surface table. Zero means no carved wake. */
export function wakeSurfaceDepth(surface: number): number {
  if (surface === 3 || surface === 4) return 1;
  if (surface === 1 || surface === 2 || surface === 15) return 0.85;
  if (surface === 8) return 0.7;
  if (surface === 16) return 0.5;
  if (surface === 5) return 0.4;
  return 0;
}

/** Unity's per-surface widening of the deck footprint. */
export function wakeSurfaceWidth(surface: number): number {
  if (surface === 3) return 2.4;
  if (surface === 4) return 1.85;
  if (surface === 2) return 0.85;
  if (surface === 5) return 0.9;
  return 1;
}

export function isPowderSurface(surface: number): boolean { return surface === 3 || surface === 4; }
export function isSnowFxSurface(surface: number): boolean {
  return surface === 1 || surface === 3 || surface === 4 || surface === 8 || surface === 16;
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-9, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function wakeMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    vertexShader: `
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() { gl_FragColor = vec4(vColor, 1.0); }
    `,
  });
  // Unity's WakeRibbon shader uses Blend DstColor SrcColor: 0.5 leaves the snow untouched, lower values
  // darken the cut wall, and higher values lighten its sun-facing rim.
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.DstColorFactor;
  material.blendDst = THREE.SrcColorFactor;
  return material;
}

interface BoardParticleAtlas {
  texture: THREE.Texture;
}

/**
 * The board systems and authored P6 emitters address the same PARTICLE.SSH name table. Browser rides replace
 * a visible radial fallback with those decoded PNGs as they arrive; headless tests retain the one-pixel white
 * texture, so effect behavior remains testable without a DOM or image decoder.
 */
function createBoardParticleAtlas(): BoardParticleAtlas {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return { texture };
  }
  const canvas = document.createElement('canvas');
  canvas.width = BOARD_SPRITE_COLUMNS * BOARD_SPRITE_CELL;
  canvas.height = BOARD_SPRITE_ROWS * BOARD_SPRITE_CELL;
  const context = canvas.getContext('2d');
  if (context) for (let index = 0; index < BOARD_SPRITES.length; index++) {
    const x = (index % BOARD_SPRITE_COLUMNS) * BOARD_SPRITE_CELL;
    const y = Math.floor(index / BOARD_SPRITE_COLUMNS) * BOARD_SPRITE_CELL;
    const gradient = context.createRadialGradient(x + 64, y + 64, 4, x + 64, y + 64, 62);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.65, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(x, y, BOARD_SPRITE_CELL, BOARD_SPRITE_CELL);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  if (context) BOARD_SPRITES.forEach((name, index) => {
    const image = new Image();
    image.onload = () => {
      const x = (index % BOARD_SPRITE_COLUMNS) * BOARD_SPRITE_CELL;
      const y = Math.floor(index / BOARD_SPRITE_COLUMNS) * BOARD_SPRITE_CELL;
      const scale = Math.min(BOARD_SPRITE_CELL / image.width, BOARD_SPRITE_CELL / image.height);
      const width = image.width * scale, height = image.height * scale;
      context.clearRect(x, y, BOARD_SPRITE_CELL, BOARD_SPRITE_CELL);
      context.drawImage(image, x + (BOARD_SPRITE_CELL - width) * 0.5,
        y + (BOARD_SPRITE_CELL - height) * 0.5, width, height);
      texture.needsUpdate = true;
    };
    image.src = `/api/particle-texture?name=${encodeURIComponent(name)}.png`;
  });
  return { texture };
}

/**
 * Camera-facing world-sized quads, instanced: the GS SPRITE both the VU1 program (P6) and the EE-side sprite
 * entry produce. `THREE.Points` is not equivalent — WebGL clamps gl_PointSize, which collapses the 8 m plume and
 * 5 m landing squares. The engine draws two blend modes: the surface chunks alpha-over (their record's blend
 * enum 3) and every other buffer additive (enum 5), so the same material is built twice.
 */
function particleMaterial(atlas: THREE.Texture, blending: THREE.Blending): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      particleAtlas: { value: atlas },
      particleAtlasGrid: { value: new THREE.Vector2(BOARD_SPRITE_COLUMNS, BOARD_SPRITE_ROWS) },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending,
    toneMapped: false,
    vertexShader: `
      attribute vec3 instancePosition;
      attribute vec3 instanceColor;
      attribute vec2 instanceSize;
      attribute float instanceAlpha;
      attribute float instanceSprite;
      attribute vec2 instanceFlip;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vSprite;
      varying vec2 vUv;
      void main() {
        vec4 centre = modelViewMatrix * vec4(instancePosition, 1.0);
        centre.xy += position.xy * instanceSize;
        vColor = instanceColor;
        vAlpha = instanceAlpha;
        vSprite = instanceSprite;
        vUv = abs(instanceFlip - uv);
        gl_Position = projectionMatrix * centre;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      varying float vSprite;
      varying vec2 vUv;
      uniform sampler2D particleAtlas;
      uniform vec2 particleAtlasGrid;
      void main() {
        float sprite = clamp(floor(vSprite + 0.5), 0.0,
          particleAtlasGrid.x * particleAtlasGrid.y - 1.0);
        vec2 cell = vec2(mod(sprite, particleAtlasGrid.x), floor(sprite / particleAtlasGrid.x));
        vec4 texel = texture2D(particleAtlas, (cell + vUv) / particleAtlasGrid);
        if (texel.a <= 0.001) discard;
        gl_FragColor = vec4(texel.rgb * vColor, texel.a * vAlpha);
      }
    `,
  });
}

function spryMaterial(atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      particleAtlas: { value: atlas },
      particleAtlasGrid: { value: new THREE.Vector2(BOARD_SPRITE_COLUMNS, BOARD_SPRITE_ROWS) },
      particleSprite: { value: BOARD_SPRITE.spry },
      brightness: { value: SPRAY_BRIGHTNESS },
    },
    // The engine primes the sheet with its always-pass depth state, so the ground rail draws over the snow
    // instead of being clipped until the upper rails rise clear.
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: `
      attribute float particleAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vAlpha = particleAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying float vAlpha;
      uniform sampler2D particleAtlas;
      uniform vec2 particleAtlasGrid;
      uniform float particleSprite;
      uniform float brightness;
      void main() {
        vec2 cell = vec2(mod(particleSprite, particleAtlasGrid.x),
          floor(particleSprite / particleAtlasGrid.x));
        vec2 tileUv = vec2(fract(vUv.x), vUv.y);
        vec4 texel = texture2D(particleAtlas, (cell + tileUv) / particleAtlasGrid);
        if (texel.a <= 0.001) discard;
        gl_FragColor = vec4(texel.rgb * brightness, texel.a * vAlpha);
      }
    `,
  });
}

class BillboardBatch {
  readonly geometry = new THREE.InstancedBufferGeometry();
  readonly mesh: THREE.Mesh;
  private readonly position = new Float32Array(MAX_BILLBOARDS * 3);
  private readonly color = new Float32Array(MAX_BILLBOARDS * 3);
  private readonly size = new Float32Array(MAX_BILLBOARDS * 2);
  private readonly alpha = new Float32Array(MAX_BILLBOARDS);
  private readonly sprite = new Float32Array(MAX_BILLBOARDS);
  private readonly flip = new Float32Array(MAX_BILLBOARDS * 2);
  count = 0;

  constructor(name: string, atlas: THREE.Texture, blending: THREE.Blending, renderOrder: number) {
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
    ], 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const instance = (array: Float32Array, itemSize: number) =>
      new THREE.InstancedBufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('instancePosition', instance(this.position, 3));
    this.geometry.setAttribute('instanceColor', instance(this.color, 3));
    this.geometry.setAttribute('instanceSize', instance(this.size, 2));
    this.geometry.setAttribute('instanceAlpha', instance(this.alpha, 1));
    this.geometry.setAttribute('instanceSprite', instance(this.sprite, 1));
    this.geometry.setAttribute('instanceFlip', instance(this.flip, 2));
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, particleMaterial(atlas, blending));
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  begin() { this.count = 0; }

  /** One camera-facing quad of the given world HALF-extents. Alpha at or below zero is skipped outright. */
  push(position: THREE.Vector3, halfX: number, halfY: number, alpha: number, r: number, g: number, b: number,
    sprite: number, flipU = false, flipV = false) {
    if (this.count >= MAX_BILLBOARDS || alpha <= 0.0005) return;
    const i = this.count++, at = i * 3, at2 = i * 2;
    this.position[at] = position.x; this.position[at + 1] = position.y; this.position[at + 2] = position.z;
    this.color[at] = r * SPRAY_BRIGHTNESS; this.color[at + 1] = g * SPRAY_BRIGHTNESS; this.color[at + 2] = b * SPRAY_BRIGHTNESS;
    this.size[at2] = halfX; this.size[at2 + 1] = halfY;
    this.alpha[i] = Math.min(1, alpha);
    this.sprite[i] = sprite;
    this.flip[at2] = flipU ? 1 : 0; this.flip[at2 + 1] = flipV ? 1 : 0;
  }

  end() {
    for (const name of ['instancePosition', 'instanceColor', 'instanceSize', 'instanceAlpha', 'instanceSprite',
      'instanceFlip'])
      (this.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.instanceCount = this.count;
  }

  dispose() {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class BoardFx {
  readonly group = new THREE.Group();
  private readonly wakeGeometry = new THREE.BufferGeometry();
  private readonly wakePosition = new Float32Array((WAKE_MAX + 1) * WAKE_CROSS * 3);
  private readonly wakeColor = new Float32Array((WAKE_MAX + 1) * WAKE_CROSS * 3);
  private readonly wakeMesh: THREE.Mesh;
  private readonly particleAtlas = createBoardParticleAtlas();
  /** Every additive buffer (plume, landing cloud, powder cloud, airborne puffs, grit). */
  private readonly additive: BillboardBatch;
  /** The surface ring's per-surface chunks: the engine draws those alpha-over, not additive. */
  private readonly chunks: BillboardBatch;
  private readonly spryGeometry = new THREE.BufferGeometry();
  private readonly spryPosition = new Float32Array(MAX_SPRY_COLUMNS * SPRY_RAILS * 3);
  private readonly spryUv = new Float32Array(MAX_SPRY_COLUMNS * SPRY_RAILS * 2);
  private readonly spryAlpha = new Float32Array(MAX_SPRY_COLUMNS * SPRY_RAILS);
  private readonly spryMesh: THREE.Mesh;
  private readonly boostTrail = new BoardBoostTrail();

  private readonly rows: WakeRow[] = [];
  private readonly surfaceSlots: SurfaceSlot[] = [];
  private readonly plume: PlumePuff[] = [];
  private readonly landing: LandingPuff[] = [];
  private readonly powder: PowderPuff[] = [];
  private readonly sparks: SparkSlot[] = [];
  private readonly spryColumns: SpryColumn[] = [];

  private readonly lastPosition = new THREE.Vector3();
  private readonly lastVelocity = new THREE.Vector3();
  private readonly lastPlumePosition = new THREE.Vector3();
  private readonly lastSpryCommit = new THREE.Vector3();
  private readonly spryDirection = new THREE.Vector3();
  private haveFrame = false;
  private wasOnSnow = false;
  private airTime = 0;
  private havePlumePosition = false;
  private tickCarry = 0;
  /** The surface ring's airborne emit scalar (70 on leaving the snow, ×0.9467/tick toward a floor of 10). */
  private airBurst = 0;
  private airLatched = false;
  /** Landing-cloud activity `A` and cadence `B` — the engine's two leaky accumulators. */
  private landingA = 0;
  private landingB = 0;
  /** Spray-sheet state: the armed flag, the throw-speed and alpha low-passes, the random-walk jitter. */
  private spryArmed = false;
  private spryThrow = 0;
  private spryAlphaLp = 0;
  private spryJitter = 0;
  private spryCounter = 0;
  private sprySide = 0;
  private rng = 0x91e10da5;

  // Per-frame contact frame, rebuilt at the top of every update.
  private readonly n = new THREE.Vector3();
  private readonly travel = new THREE.Vector3();
  private readonly travelDir = new THREE.Vector3();
  private readonly facing = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly contact = new THREE.Vector3();
  private speed = 0;
  private slipFraction = 0;

  constructor(private readonly scene: THREE.Object3D, private readonly ground?: WalkGroundQuery) {
    this.group.name = 'PlayerBoardFx';
    this.group.matrixAutoUpdate = false; // every vertex is already in world space

    const wakePos = new THREE.BufferAttribute(this.wakePosition, 3).setUsage(THREE.DynamicDrawUsage);
    const wakeCol = new THREE.BufferAttribute(this.wakeColor, 3).setUsage(THREE.DynamicDrawUsage);
    this.wakeGeometry.setAttribute('position', wakePos);
    this.wakeGeometry.setAttribute('color', wakeCol);
    const wakeIndex = new Uint16Array(WAKE_MAX * (WAKE_CROSS - 1) * 6);
    let wi = 0;
    for (let row = 0; row < WAKE_MAX; row++) {
      const a = row * WAKE_CROSS, b = (row + 1) * WAKE_CROSS;
      for (let col = 0; col < WAKE_CROSS - 1; col++) {
        wakeIndex[wi++] = a + col; wakeIndex[wi++] = a + col + 1; wakeIndex[wi++] = b + col;
        wakeIndex[wi++] = b + col; wakeIndex[wi++] = a + col + 1; wakeIndex[wi++] = b + col + 1;
      }
    }
    this.wakeGeometry.setIndex(new THREE.BufferAttribute(wakeIndex, 1));
    this.wakeGeometry.setDrawRange(0, 0);
    this.wakeMesh = new THREE.Mesh(this.wakeGeometry, wakeMaterial());
    this.wakeMesh.name = 'PlayerBoardWake';
    this.wakeMesh.frustumCulled = false;
    this.wakeMesh.renderOrder = 3;

    // Engine order: plume → sheet → chunks → landing → powder, all depth-tested without writing. Additive
    // buffers commute, so one additive batch under the alpha chunks and the sheet on top is the same picture.
    this.additive = new BillboardBatch('PlayerBoardSnowParticles', this.particleAtlas.texture,
      THREE.AdditiveBlending, 4);
    this.chunks = new BillboardBatch('PlayerBoardSnowChunks', this.particleAtlas.texture, THREE.NormalBlending, 5);

    this.spryGeometry.setAttribute('position',
      new THREE.BufferAttribute(this.spryPosition, 3).setUsage(THREE.DynamicDrawUsage));
    this.spryGeometry.setAttribute('uv',
      new THREE.BufferAttribute(this.spryUv, 2).setUsage(THREE.DynamicDrawUsage));
    this.spryGeometry.setAttribute('particleAlpha',
      new THREE.BufferAttribute(this.spryAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    const spryIndex = new Uint16Array((MAX_SPRY_COLUMNS - 1) * (SPRY_RAILS - 1) * 6);
    let si = 0;
    for (let column = 0; column < MAX_SPRY_COLUMNS - 1; column++) {
      const a = column * SPRY_RAILS, b = a + SPRY_RAILS;
      for (let rail = 0; rail < SPRY_RAILS - 1; rail++) {
        spryIndex[si++] = a + rail; spryIndex[si++] = b + rail; spryIndex[si++] = a + rail + 1;
        spryIndex[si++] = a + rail + 1; spryIndex[si++] = b + rail; spryIndex[si++] = b + rail + 1;
      }
    }
    this.spryGeometry.setIndex(new THREE.BufferAttribute(spryIndex, 1));
    this.spryGeometry.setDrawRange(0, 0);
    this.spryMesh = new THREE.Mesh(this.spryGeometry, spryMaterial(this.particleAtlas.texture));
    this.spryMesh.name = 'PlayerBoardSprySheet';
    this.spryMesh.frustumCulled = false;
    this.spryMesh.renderOrder = 6;
    this.group.add(this.wakeMesh, this.boostTrail.mesh, this.additive.mesh, this.chunks.mesh, this.spryMesh);
    this.scene.add(this.group);
  }

  update(frame: BoardFxFrame, dt: number, gear: RideGear) {
    if (!(dt > 0)) return;
    const h = Math.min(dt, 0.1);

    const teleported = this.haveFrame && frame.pos.distanceToSquared(this.lastPosition) > 100;
    if (teleported) this.clear();
    this.buildContactFrame(frame);
    this.age(h);
    this.boostTrail.update({
      position: frame.boardPosition, quaternion: frame.boardQuaternion, velocity: frame.vel,
      active: frame.boostActive, energy: frame.boostEnergy, pad: frame.padBoost, gear,
      thrustDirection: frame.boostDirection,
    }, h);

    const onSnow = frame.grounded && !frame.grinding;
    const airborne = !frame.grounded && !frame.grinding;
    const wakeNearSurface = !frame.grinding && (frame.grounded || frame.surfaceGap <= WAKE_GROUND_REACH);
    if (airborne) this.airTime += h;
    if (this.haveFrame && !this.wasOnSnow && onSnow) {
      // Touchdown: the engine hands the landing to the cloud buffer as an immediate burst plus an activity seed.
      // A real flight or a hard slap counts; the contact probe's bump flicker on a chatter strip does not.
      const impact = Math.max(0, -this.lastVelocity.dot(this.n));
      if (this.airTime > 0.15 || impact > 2) this.touchdown(frame, this.lastVelocity.length());
    }
    if (!airborne) this.airTime = 0;
    if (onSnow) { this.airLatched = false; this.airBurst = 0; }
    this.wasOnSnow = onSnow;

    if (wakeNearSurface) this.updateWake(frame, gear);
    // Emission runs on the engine's 60 Hz tick; each carried tick sees the current frame.
    this.tickCarry += h * TICK_HZ;
    let ticks = Math.min(4, Math.floor(this.tickCarry + 1e-9));
    this.tickCarry -= ticks;
    while (ticks-- > 0) this.tick(frame, onSnow, airborne);
    this.integrateSpry(h);

    this.lastPosition.copy(frame.pos);
    this.lastVelocity.copy(frame.vel);
    this.haveFrame = true;
    this.rebuildWake();
    this.rebuildParticles();
    this.rebuildSpry();
  }

  /** Clear every live visual and transition latch; used on dismount and a live checkbox-off. */
  clear() {
    this.rows.length = 0;
    this.surfaceSlots.length = 0;
    this.plume.length = 0;
    this.landing.length = 0;
    this.powder.length = 0;
    this.sparks.length = 0;
    this.spryColumns.length = 0;
    this.boostTrail.clear();
    this.wakeGeometry.setDrawRange(0, 0);
    this.additive.begin(); this.additive.end();
    this.chunks.begin(); this.chunks.end();
    this.spryGeometry.setDrawRange(0, 0);
    this.haveFrame = false;
    this.wasOnSnow = false;
    this.airTime = 0;
    this.havePlumePosition = false;
    this.tickCarry = 0;
    this.airBurst = 0; this.airLatched = false;
    this.landingA = this.landingB = 0;
    this.spryArmed = false; this.spryThrow = this.spryAlphaLp = this.spryJitter = 0; this.sprySide = 0;
  }

  dispose() {
    this.scene.remove(this.group);
    this.wakeGeometry.dispose();
    (this.wakeMesh.material as THREE.Material).dispose();
    this.additive.dispose();
    this.chunks.dispose();
    this.spryGeometry.dispose();
    (this.spryMesh.material as THREE.Material).dispose();
    this.boostTrail.dispose();
    this.particleAtlas.texture.dispose();
  }

  /** Headless regression seam; production code never branches on these counts. */
  stats() {
    return { wakeRows: this.rows.length, particles: this.surfaceBillboards() + this.puffCount() };
  }

  /** Focused fidelity seam: per-buffer occupancy plus the newest surface slot's throw, for the tests. */
  systemStats() {
    const newest = this.surfaceSlots[this.surfaceSlots.length - 1];
    return {
      surface: this.surfaceBillboards(), surfaceSlots: this.surfaceSlots.length,
      plume: this.plume.length, landing: this.landing.length, powder: this.powder.length,
      sparks: this.sparkDots(), spryColumns: this.spryColumns.length,
      boostSamples: this.boostTrail.stats().samples, boostVertices: this.boostTrail.stats().vertices,
      newestSurface: newest ? {
        count: newest.count, additive: newest.additive, sprite: newest.sprite,
        throw: [newest.vBase.x, newest.vBase.y, newest.vBase.z] as const,
      } : null,
    };
  }

  private surfaceBillboards(): number {
    let count = 0;
    for (const slot of this.surfaceSlots) if (slot.age < slot.fade) count += slot.count;
    return count;
  }

  private puffCount(): number {
    return this.plume.length + this.landing.length + this.powder.length + this.sparkDots();
  }

  private sparkDots(): number {
    let count = 0;
    for (const slot of this.sparks) count += slot.count;
    return count;
  }

  // ---- contact frame ----

  private buildContactFrame(frame: BoardFxFrame) {
    this.n.copy(this.normalized(frame.normal, WORLD_UP));
    this.travel.copy(frame.vel).addScaledVector(this.n, -frame.vel.dot(this.n));
    this.travelDir.copy(this.normalized(this.travel, frame.fwd));
    this.facing.copy(frame.fwd).addScaledVector(this.n, -frame.fwd.dot(this.n));
    this.facing.copy(this.normalized(this.facing, this.travelDir));
    this.side.copy(this.normalized(new THREE.Vector3().crossVectors(this.n, this.facing), new THREE.Vector3(1, 0, 0)));
    const rest = groundRestDepth(surfaceFor(frame.surf), this.n.y);
    this.contact.copy(frame.pos).addScaledVector(this.n, rest + 0.05);
    this.speed = frame.vel.length();
    this.slipFraction = this.speed > 1e-3 ? Math.abs(this.travelDir.dot(this.side)) : 0;
  }

  /**
   * The outside of the turn. The ride's carve slide is `−lean · cross(n, fwd)` "out of the turn", so the
   * outward lateral is that same axis with the lean's sign folded in.
   */
  private outward(lean: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.side).multiplyScalar(lean > 0 ? -1 : 1);
  }

  /**
   * The engine's spray basis is the BOARD's basis, which rolls onto its edge with the lean: at lean 0.19 the
   * lateral axis sits 20° off the snow, at 0.39 ~50°, at 0.58 ~73°, at 0.77+ it points straight up. So the
   * lateral chunk throw rotates from sideways toward vertical as the carve deepens.
   */
  private rolledLateral(lean: number, out: THREE.Vector3): THREE.Vector3 {
    const theta = Math.min(Math.PI / 2, (120 * Math.PI / 180) * Math.abs(lean));
    this.outward(lean, out).multiplyScalar(Math.cos(theta)).addScaledVector(this.n, Math.sin(theta));
    return out.normalize();
  }

  // ---- ageing ----

  private age(h: number) {
    for (const row of this.rows) row.age += h;
    while (this.rows.length && this.rows[0].age >= WAKE_LIFE) this.rows.shift();
    for (const slot of this.surfaceSlots) slot.age += h;
    // The ring never retires a slot by age (only by eviction), but a fully faded slot is invisible: drop it so
    // the draw budget covers live sprites rather than dead ones.
    for (let i = this.surfaceSlots.length - 1; i >= 0; i--)
      if (this.surfaceSlots[i].age >= this.surfaceSlots[i].fade) this.surfaceSlots.splice(i, 1);
    for (let i = this.plume.length - 1; i >= 0; i--) {
      this.plume[i].age += h;
      if (this.plume[i].age >= 2) this.plume.splice(i, 1);
    }
    for (let i = this.landing.length - 1; i >= 0; i--) {
      this.landing[i].age += h;
      if (this.landing[i].age >= 2) this.landing.splice(i, 1);
    }
    for (let i = this.powder.length - 1; i >= 0; i--) {
      this.powder[i].age += h;
      if (this.powder[i].age >= 1) this.powder.splice(i, 1);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      this.sparks[i].age += h;
      if (this.sparks[i].age >= this.sparks[i].fade) this.sparks.splice(i, 1);
    }
    for (let i = this.spryColumns.length - 1; i >= 0; i--) {
      this.spryColumns[i].age += h;
      if (this.spryColumns[i].age >= SPRY_LIFE) this.spryColumns.splice(i, 1);
    }
  }

  // ---- one 60 Hz emission tick ----

  private tick(frame: BoardFxFrame, onSnow: boolean, airborne: boolean) {
    const lean = Math.abs(frame.lean);
    const speedU = this.speed / U;
    const powder = isPowderSurface(frame.surf);

    // Landing cloud accumulator: a hard sideways skid at speed feeds it; it leaks every tick it is live.
    if (onSnow && this.slipFraction > 0.7 && speedU > 277.78) this.landingA = Math.min(1, this.landingA + 0.05);
    if (this.landingA > 0) {
      if (this.landingB < this.landingA * 0.1 + 0.5) {
        this.spawnLandingPuff(this.contact.clone().addScaledVector(this.travel, this.range(0.1, 0.2)),
          this.landingA * 0.05);
        this.landingB += 1;
      }
      this.landingA -= 1 / TICK_HZ;
    }
    this.landingB *= 2 / 3;

    // Sparks: rails, and rock/metal ridden on the ground. The snow buffers below all stand down on those.
    const onRail = frame.grinding;
    if ((onRail || (onSnow && HARD_SURFACES.has(frame.surf))) && this.speed >= SPRAY_MIN_SPEED) this.tickSparks(frame, onRail);

    if (airborne) {
      // The takeoff puff: the surface ring keeps emitting in the air from the board's tail, off a scalar seeded
      // to 70 on the first airborne tick that decays toward a trickle of 10, scaled down below ~2.8 m/s.
      if (!this.airLatched) { this.airLatched = true; this.airBurst = 70; }
      else if (this.airBurst > 10) this.airBurst *= 0.9467;
      const scalar = this.airBurst * Math.min(1, speedU / 277.78);
      const count = Math.floor(scalar / TICK_HZ + this.random());
      if (count > 0) this.spawnAirSlot(frame, count);
      this.spryArmed = false;
      return;
    }
    if (!onSnow || this.speed < SPRAY_MIN_SPEED || HARD_SURFACES.has(frame.surf)) {
      this.spryArmed = false;
      return;
    }

    // Surface ring: the carve motion scalar times the record rate, dithered to an integer that is both the
    // spawn gate and the slot's billboard count.
    const row = SURFACE_SPRAY[frame.surf];
    if (row) {
      const motion = speedU * 0.006 * (1 + 149 * lean * lean);
      const count = Math.floor(motion * row.rate / TICK_HZ + this.random());
      if (count > 0) this.spawnGroundSlot(frame, row, Math.min(32, count));
    }

    // Carve plume: a travel odometer, one puff per 0.7 m while carving past 0.2 — or on powder regardless.
    if (powder || lean > 0.2) {
      const at = this.contact.clone().addScaledVector(this.travelDir, -0.28);
      if (!this.havePlumePosition || at.distanceToSquared(this.lastPlumePosition) >= 0.7 * 0.7) {
        this.havePlumePosition = true;
        this.lastPlumePosition.copy(at);
        this.spawnPlumePuff(at, powder ? 0.2 : lean * 0.2, powder ? 0 : 0.2);
      }
    }

    // Powder cloud: count per tick from speed alone, powder surfaces only.
    if (powder) {
      let count = Math.max(1, Math.round(speedU / 1270.695));
      while (count-- > 0) this.spawnPowderPuff();
    }

    this.tickSpry(frame);
  }

  // ---- surface ring (P6) ----

  private newSurfaceSlot(count: number, row: SurfaceSprayRow, additive: boolean): SurfaceSlot {
    if (this.surfaceSlots.length >= SURFACE_SLOTS) this.surfaceSlots.shift();
    const randoms = new Float32Array(count * 6);
    for (let i = 0; i < randoms.length; i++) randoms[i] = 1 + this.random();
    const slot: SurfaceSlot = {
      count, age: 0, pos: new THREE.Vector3(), scatterA: new THREE.Vector3(), scatterB: new THREE.Vector3(),
      vBase: new THREE.Vector3(), vA: new THREE.Vector3(), vB: new THREE.Vector3(), vC: new THREE.Vector3(),
      size: row.size, fade: row.fade, alpha: row.alpha, sprite: row.sprite, additive, randoms,
    };
    this.surfaceSlots.push(slot);
    return slot;
  }

  /**
   * The grounded throw. The engine seeds the slot with the board velocity plus a lateral term `lean·1.1·speed`
   * along the rolled lateral axis (soft-clamped past 4.5 m/s), then pre-biases the P6 lanes so that every
   * billboard ends up with `V = V0·u + T·(lat' + spread·(w − 0.5))`, u and w uniform in [0,1): somewhere between
   * standing still and the full board speed forward, thrown out of the turn by the lateral term ± half its spread.
   */
  private spawnGroundSlot(frame: BoardFxFrame, row: SurfaceSprayRow, count: number) {
    const slot = this.newSurfaceSlot(count, row, false);
    const dirA = this.rolledLateral(frame.lean, new THREE.Vector3());
    const dir2 = this.travelDir.clone().multiplyScalar(-1);
    slot.pos.copy(this.contact);
    slot.scatterA.copy(dirA).multiplyScalar(30 * U);
    slot.scatterB.copy(dir2).multiplyScalar(180 * U);

    const v0 = frame.vel;
    const lat = Math.abs(frame.lean) * 1.1 * this.speed;
    const d = v0.dot(dirA) + lat;
    const base = slot.vBase.copy(v0).addScaledVector(dirA, lat);
    let spread: number;
    if (Math.abs(d) >= 4.5) {
      const pulled = Math.sign(d) * (4.5 + 0.5 * (Math.abs(d) - 4.5));
      base.addScaledVector(dirA, pulled - d);
      spread = Math.abs(d) - 1.5;
    } else spread = 3.0;
    const f31 = base.dot(dir2);
    base.addScaledVector(dir2, -0.5 * f31);
    slot.vA.copy(dirA).multiplyScalar(spread);
    slot.vB.set(0, 0, 0);
    slot.vC.copy(dir2).multiplyScalar(f31);
  }

  /** Airborne (takeoff) puffs: full board velocity with ±2 m/s lateral/along scatter and ±0.25 m/s vertical. */
  private spawnAirSlot(frame: BoardFxFrame, count: number) {
    const slot = this.newSurfaceSlot(count, AIR_SPRAY, true);
    const lateral = this.side.clone();
    const backward = this.travelDir.clone().multiplyScalar(-1);
    slot.pos.copy(frame.pos).addScaledVector(this.travelDir, -0.28);
    slot.scatterA.copy(lateral).multiplyScalar(30 * U);
    slot.scatterB.copy(backward).multiplyScalar(180 * U);
    slot.vBase.copy(frame.vel);
    slot.vA.copy(lateral).multiplyScalar(4);
    slot.vB.copy(this.n).multiplyScalar(0.5);
    slot.vC.copy(backward).multiplyScalar(4);
  }

  // ---- the three EE-side puff buffers ----

  private spawnPlumePuff(pos: THREE.Vector3, peak: number, knee: number) {
    if (this.plume.length >= PLUME_SLOTS) this.plume.shift();
    this.plume.push({
      age: 0, sprite: this.randomExSprite(), flipU: this.random() < 0.5, flipV: this.random() < 0.5,
      pos: pos.clone(), up: this.n.clone(), peak, knee,
    });
  }

  private spawnLandingPuff(near: THREE.Vector3, peak: number) {
    if (this.landing.length >= LANDING_SLOTS) this.landing.shift();
    this.landing.push({
      age: 0, sprite: this.randomExSprite(), flipU: this.random() < 0.5, flipV: this.random() < 0.5,
      near, normal: this.n.clone(), peak,
    });
  }

  /**
   * Touchdown: `N = clamp(⌊0.0009·speed_u⌋, 2, 8)` puffs at once, scattered ±0.4 m about the contact at twice the
   * cadence brightness, and the activity accumulator seeded by `1.5·(0.2 + 0.000514·speed_u)` (capped 1.5) so the
   * cadence keeps the cloud building for the next second or so.
   */
  private touchdown(frame: BoardFxFrame, impactSpeed: number) {
    if (!isSnowFxSurface(frame.surf) && frame.surf !== 2 && frame.surf !== 5) return;
    const speedU = impactSpeed / U;
    const bursts = Math.max(2, Math.min(8, Math.floor(0.0009 * speedU)));
    for (let i = 0; i < bursts; i++) {
      const at = this.contact.clone().addScaledVector(this.travelDir, this.range(-0.4, 0.4))
        .addScaledVector(this.side, this.range(-0.4, 0.4));
      this.spawnLandingPuff(at, 0.1);
    }
    this.landingA = Math.min(1.5, this.landingA + 1.5 * (0.2 + 0.000514 * speedU));
    this.landingB = 1;
  }

  private spawnPowderPuff() {
    if (this.powder.length >= POWDER_SLOTS) this.powder.shift();
    const lifeScale = Math.min(1, this.speed / 9.7222);
    this.powder.push({
      age: 0, sprite: this.randomExSprite(), flipU: this.random() < 0.5, flipV: this.random() < 0.5,
      life: Math.max(0.05, this.range(0.8, 1.2) * 0.4465 * lifeScale),
      maxHalf: this.range(0.8, 1.2) * 18.493 * U,
      grow: this.range(0.8, 1.2) * 113.95 * U,
      scatterA: this.range(-44.17, 44.17) * U, scatterB: this.range(-44.17, 44.17) * U,
    });
  }

  /**
   * The spark gate, one tick. Steady state rolls `⌊50/60 + rand⌋` dots (≈1/frame); a 1-in-60 roll instead fires
   * `⌊1050/60 + rand⌋` (17–18) at a 1.5× throw with a longer fade. The throw scale `f` is twice the board speed
   * (three times in a burst), capped at 16.7 m/s: dots leave at `up·0.05f − forward·0.1f` with ±lateral
   * `min(0.35f, 11 m/s)`, ±forward `0.2f` and ±up `0.2f` spread, from the contact 20 ms ahead (40 ms on a rail),
   * scattered over the same ±0.15 × ±0.9 m strip as the snow chunks.
   */
  private tickSparks(frame: BoardFxFrame, onRail: boolean) {
    const burst = this.random() < SPARK_BURST_CHANCE;
    const count = Math.floor((burst ? SPARK_BURST : SPARK_STEADY) / TICK_HZ + this.random());
    if (count <= 0) return;
    if (this.sparks.length >= SPARK_SLOTS) this.sparks.shift();
    const f = (burst ? 3 : 2) * Math.min(this.speed, SPARK_SPEED_CAP);
    const spread = Math.min(0.35 * f, 1111.1 * U);
    const randoms = new Float32Array(count * 8);
    for (let i = 0; i < randoms.length; i++) randoms[i] = 1 + this.random();
    const origin = onRail ? frame.pos.clone() : this.contact.clone();
    origin.addScaledVector(frame.vel, onRail ? 0.04 : 0.02);
    this.sparks.push({
      count, age: 0, fade: burst ? 0.65 : 0.25,
      pos: origin,
      scatterA: this.side.clone().multiplyScalar(30 * U),
      scatterB: this.travelDir.clone().multiplyScalar(-180 * U),
      vBase: this.n.clone().multiplyScalar(0.05 * f).addScaledVector(this.travelDir, -0.1 * f),
      vA: this.side.clone().multiplyScalar(spread),
      vB: this.travelDir.clone().multiplyScalar(0.2 * f),
      vC: this.n.clone().multiplyScalar(0.2 * f),
      randoms,
    });
  }

  // ---- spray sheet (the four-rail spry ribbon) ----

  /**
   * The sheet's launch axis is the outward lateral tilted 25° up the normal, low-passed over ~0.1 s; its throw
   * speed is `trail_motion_scale · speed · |carve|` low-passed over 0.5 s, so a fresh edge builds the sheet up
   * rather than snapping it out. Columns commit every 0.25 m; between commits the newest column re-tracks the
   * board. The alpha seed is `trail_emit_intensity · (|carve| − 0.2)`, and the segment opens at |carve| > 0.3
   * and closes when its alpha decays past 0.02 or the carve changes side.
   */
  private tickSpry(frame: BoardFxFrame) {
    const row = SHEET_ROWS[frame.surf];
    if (!row) { this.spryArmed = false; return; }
    const carve = Math.abs(frame.lean) * (1 - this.slipFraction);
    const sideSign = frame.lean > 0 ? 1 : -1;
    const seed = row.gain * Math.max(0, carve - 0.2);
    const throwSpeed = row.throw * this.speed * carve;

    if (!this.spryArmed) {
      if (carve <= 0.3) return;
      this.spryArmed = true;
      this.sprySide = sideSign;
      this.spryThrow = 0;
      this.spryAlphaLp = seed;
      this.spryColumns.length = 0;
      this.spryDirection.copy(this.outward(frame.lean, new THREE.Vector3()))
        .addScaledVector(this.n, SPRY_LAUNCH_TILT).normalize();
      this.lastSpryCommit.copy(this.contact);
      this.commitSpryColumn(true);
      return;
    }
    if (sideSign !== this.sprySide) { this.spryArmed = false; return; }
    this.spryThrow += (throwSpeed - this.spryThrow) * 0.0333;
    this.spryAlphaLp = seed * 0.3333 + this.spryAlphaLp * 0.6667;
    if (this.spryAlphaLp <= 0.02) { this.spryArmed = false; return; }
    const launch = this.outward(frame.lean, new THREE.Vector3()).addScaledVector(this.n, SPRY_LAUNCH_TILT).normalize();
    this.spryDirection.multiplyScalar(0.8333).addScaledVector(launch, 0.1667).normalize();
    const moved = this.contact.distanceTo(this.lastSpryCommit) > SPRY_COMMIT_SPACING;
    if (moved) {
      this.lastSpryCommit.copy(this.contact);
      this.spryJitter += this.range(-0.1333, 0.1333);
      if (this.spryJitter > 0.3) this.spryJitter = 0.6 - this.spryJitter;
      if (this.spryJitter < -0.3) this.spryJitter = -0.6 - this.spryJitter;
    }
    this.commitSpryColumn(moved);
  }

  private commitSpryColumn(fresh: boolean) {
    const last = this.spryColumns[this.spryColumns.length - 1];
    const column: SpryColumn = fresh || !last ? {
      points: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
      velocities: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
      age: 0, alpha: 0, u: this.spryCounter++ * 0.25,
    } : last;
    if (fresh || !last) {
      if (this.spryColumns.length >= MAX_SPRY_COLUMNS) this.spryColumns.shift();
      this.spryColumns.push(column);
    }
    const throwSpeed = this.spryThrow * (1 + this.spryJitter);
    column.alpha = clamp01(this.spryAlphaLp * (1 + 1.2 * this.spryJitter));
    column.age = 0;
    // Base: half a metre behind the contact along the board's own backward axis; rail i launches at i/4 of the
    // throw and starts one "second of throw at board speed" along it — the same spacing whatever the speed.
    const base = this.contact.clone().addScaledVector(this.travelDir, -0.5);
    const speedMps = Math.max(1, this.speed);
    for (let rail = 0; rail < SPRY_RAILS; rail++) {
      column.velocities[rail].copy(this.spryDirection).multiplyScalar(rail * 0.25 * throwSpeed);
      column.points[rail].copy(base).addScaledVector(column.velocities[rail], 1 / speedMps);
    }
  }

  private integrateSpry(h: number) {
    for (const column of this.spryColumns) {
      for (let rail = 1; rail < SPRY_RAILS; rail++) {
        const velocity = column.velocities[rail];
        column.points[rail].addScaledVector(velocity, h);
        velocity.addScaledVector(velocity, -SPRY_DRAG * h);
        velocity.addScaledVector(WORLD_DOWN, SPRY_GRAVITY * (rail * 0.25) ** 2 * h);
      }
    }
  }

  // ---- wake ----

  private updateWake(frame: BoardFxFrame, gear: RideGear) {
    const depth = wakeSurfaceDepth(frame.surf);
    const speed = frame.vel.length();
    // Retail's wake table keeps powder (3/4) enabled with its widest, most persistent footprint. The dense cloud
    // partially hides it under the board, but dropping the ribbon entirely makes a powder run read disconnected.
    if (!depth || speed < WAKE_MIN_SPEED) return;

    const n = this.n;
    const tdir = this.travelDir;
    const side = this.normalized(new THREE.Vector3().crossVectors(n, tdir), new THREE.Vector3(1, 0, 0));
    const forward = this.facing;
    const boardSide = this.normalized(new THREE.Vector3().crossVectors(n, forward), side);
    const halfLength = gear === 'skis' ? SKI_HALF_LENGTH : BOARD_HALF_LENGTH;
    const halfWidth = gear === 'skis' ? SKI_PAIR_HALF_WIDTH : BOARD_HALF_WIDTH;
    const fAcross = forward.dot(side), fAlong = forward.dot(tdir);
    const sAcross = boardSide.dot(side), sAlong = boardSide.dot(tdir);
    const half = (halfLength * Math.abs(fAcross) + halfWidth * Math.abs(sAcross)) * wakeSurfaceWidth(frame.surf);
    const back = halfLength * Math.abs(fAlong) + halfWidth * Math.abs(sAlong);
    // `surfaceGap` seats the fallback on the probed plane even during a bump-skip. On real terrain, sample the
    // trailing edge itself: concave snow can rise behind the board faster than a tangent-plane projection.
    const centre = frame.pos.clone().addScaledVector(n, -frame.surfaceGap + WAKE_HEIGHT).addScaledVector(tdir, -back);
    const trailGround = this.ground?.(centre.x, centre.z, frame.pos.y + back);
    if (trailGround) centre.y = trailGround.y + WAKE_HEIGHT;

    if (this.rows.length && centre.distanceToSquared(this.rows[this.rows.length - 1].centre) > WAKE_RESTART_GAP ** 2)
      this.rows.length = 0;
    // The newest row is a live head that follows the board every frame; it commits — a fresh head is pushed —
    // once it sits a full spacing past the last COMMITTED row. Measuring against the head itself (the old
    // behaviour) meant any frame that moved less than the spacing dragged the head along and nothing ever
    // committed, so the ribbon vanished below ~17 m/s at 60 fps: exactly the slow, deep-powder case.
    const head = this.rows[this.rows.length - 1];
    const committed = this.rows[this.rows.length - 2];
    if (!head) {
      this.rows.push({ centre, side: side.clone(), half, age: 0, depth, gear });
      return;
    }
    head.centre.copy(centre); head.side.copy(side); head.half = half; head.depth = depth; head.gear = gear;
    head.age = 0;
    if (!committed || committed.centre.distanceToSquared(centre) >= WAKE_SPACING ** 2) {
      if (this.rows.length >= WAKE_MAX) this.rows.shift();
      this.rows.push({ centre: centre.clone(), side: side.clone(), half, age: 0, depth, gear });
    }
  }

  private rebuildWake() {
    if (this.rows.length < 2) { this.wakeGeometry.setDrawRange(0, 0); return; }
    for (let rowIndex = 0; rowIndex < this.rows.length; rowIndex++) {
      const row = this.rows[rowIndex];
      const fade = clamp01(1 - row.age / WAKE_LIFE);
      const depth = clamp01(row.depth);
      const inner = THREE.MathUtils.lerp(0.82, 0.30, clamp01((depth - 0.4) / 0.5));
      const sunSide = -row.side.dot(WAKE_SUN);
      const columnStep = row.half * 2 / (WAKE_CROSS - 1);
      for (let col = 0; col < WAKE_CROSS; col++) {
        const off = col / (WAKE_CROSS - 1) * 2 - 1;
        const vertex = rowIndex * WAKE_CROSS + col;
        const at = vertex * 3;
        this.wakePosition[at] = row.centre.x + row.side.x * off * row.half;
        this.wakePosition[at + 1] = row.centre.y + row.side.y * off * row.half;
        this.wakePosition[at + 2] = row.centre.z + row.side.z * off * row.half;

        let coverage: number, litness: number;
        if (row.gear === 'skis' && row.half < 0.42) {
          // A pair leaves two narrow cuts. Widen the sampled band enough to survive the fixed 20-column grid.
          const x = off * row.half;
          const centre = Math.min(SKI_TRACK_HALF_SPAN, row.half * 0.62);
          const band = Math.max(columnStep * 0.72, THREE.MathUtils.lerp(0.014, 0.035, depth));
          const local = Math.abs(x) - centre;
          coverage = (1 - smoothstep(band * 0.35, band * 1.35, Math.abs(local))) * fade;
          litness = Math.sign(local || 1) * sunSide;
        } else {
          const abs = Math.abs(off);
          const wall = smoothstep(inner, 0.92, abs);
          const outer = 1 - smoothstep(0.92, 1, abs);
          coverage = wall * outer * fade;
          litness = (off >= 0 ? 1 : -1) * sunSide;
        }
        const value = clamp01(0.5 + coverage * (WAKE_SUN_SPLIT * litness - WAKE_DARKEN));
        this.wakeColor[at] = this.wakeColor[at + 1] = this.wakeColor[at + 2] = value;
      }
    }
    (this.wakeGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.wakeGeometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.wakeGeometry.setDrawRange(0, (this.rows.length - 1) * (WAKE_CROSS - 1) * 6);
  }

  // ---- draw ----

  private rebuildParticles() {
    this.additive.begin();
    this.chunks.begin();
    const at = new THREE.Vector3();

    // Surface ring: P6's frozen scatter plus its drag curve, per billboard, off the slot's stable randoms.
    for (const slot of this.surfaceSlots) {
      const t = slot.age;
      const opacity = slot.alpha * (1 - t / slot.fade);
      if (opacity <= 0) continue;
      const a = P6_RATE * t;
      const ac = Math.min(a, P6_CURVE_CLAMP);
      const c = -0.73 * ac + 0.113 * ac * ac;
      const gravityLift = P6_GRAVITY * (a + c);
      const batch = slot.additive ? this.additive : this.chunks;
      const r = slot.randoms;
      for (let i = 0; i < slot.count; i++) {
        const k = i * 6;
        at.copy(slot.pos)
          .addScaledVector(slot.scatterA, r[k] - 1.5)
          .addScaledVector(slot.scatterB, r[k + 1] - 1.5);
        // V = base + A·(R3−1.5) + B·(R4−1.5) + C·(R5−1.5); P6 displaces by −c·V/r plus the gravity lift.
        const s = -c / P6_RATE;
        at.addScaledVector(slot.vBase, s)
          .addScaledVector(slot.vA, s * (r[k + 2] - 1.5))
          .addScaledVector(slot.vB, s * (r[k + 3] - 1.5))
          .addScaledVector(slot.vC, s * (r[k + 4] - 1.5));
        at.y += gravityLift;
        const half = 0.5 * P6_SIZE_SCALE * slot.size * (0.8 + 0.4 * (r[k + 5] - 1));
        batch.push(at, half, half, opacity, 1, 1, 1, slot.sprite);
      }
    }

    // Sparks: the same P6 flight on a 12× clock with real gravity, seven trail copies per dot, each copy 0.084
    // clock units younger and a seventh dimmer. Tint is (1, 0.5–0.9, ~0) per dot; the fade lifts blue toward
    // pink-white as alpha drops from 0.63 to zero.
    for (const slot of this.sparks) {
      const fade01 = slot.age / slot.fade;
      const alphaNow = 0.625 * (1 - fade01);
      if (alphaNow <= 0) continue;
      const blueLift = 0.7 * fade01;
      const r = slot.randoms;
      for (let i = 0; i < slot.count; i++) {
        const k = i * 8;
        const green = (15 + 50 * r[k + 6]) / 128;
        const blue = Math.max(0, (-75 + 50 * r[k + 7]) / 128) + blueLift;
        const half = 0.5 * P6_SIZE_SCALE * (0.25 + 0.5 * r[k + 5]);
        for (let copy = 0; copy < SPARK_COPIES; copy++) {
          const a = SPARK_RATE * slot.age - copy * SPARK_COPY_AGE_STEP;
          if (a < 0) break;
          const ac = Math.min(a, P6_CURVE_CLAMP);
          const c = -0.73 * ac + 0.113 * ac * ac;
          const s = -c / SPARK_RATE;
          at.copy(slot.pos)
            .addScaledVector(slot.scatterA, r[k] - 1.5)
            .addScaledVector(slot.scatterB, r[k + 1] - 1.5)
            .addScaledVector(slot.vBase, s)
            .addScaledVector(slot.vA, s * (r[k + 2] - 1.5))
            .addScaledVector(slot.vB, s * (r[k + 3] - 1.5))
            .addScaledVector(slot.vC, s * (r[k + 4] - 1.5));
          at.y += SPARK_GRAVITY * (a + c);
          this.additive.push(at, half, half, alphaNow * (1 - copy / SPARK_COPIES), 1, green, blue, BOARD_SPRITE.grit);
        }
      }
    }

    // Carve plume: max(2·age, 0.8) half-extent, lifted half its half-extent up the board's normal.
    for (const puff of this.plume) {
      const half = Math.max(200 * U * puff.age, 80 * U);
      const opacity = puff.age < puff.knee
        ? puff.peak * puff.age / puff.knee
        : puff.peak * (2 - puff.age) / Math.max(0.001, 2 - puff.knee);
      at.copy(puff.pos).addScaledVector(puff.up, half * 0.5);
      this.additive.push(at, half, half, opacity, 1, 1, 1, puff.sprite, puff.flipU, puff.flipV);
    }

    // Landing cloud: the length law 600·age → 120 + 72.2·(age − 0.2) sets both the square's half-extent and how
    // far up the normal it has risen; brightness ramps in over 0.2 s then falls off quadratically to 2 s.
    for (const puff of this.landing) {
      const length = (puff.age < 0.2 ? 600 * puff.age : 120 + 72.22 * (puff.age - 0.2)) * U;
      const brightness = puff.age < 0.2
        ? puff.peak * puff.age / 0.2
        : puff.peak * (2 - puff.age) * 0.5556 * (0.6 + 0.2222 * (2 - puff.age));
      at.copy(puff.near).addScaledVector(puff.normal, 0.9 * length);
      this.additive.push(at, length, length, brightness, 1, 1, 1, puff.sprite, puff.flipU, puff.flipV);
    }

    // Powder cloud: every puff re-placed off the CURRENT contact frame — the cloud rides with the board, each
    // puff sliding 2 m/s backward — and lifted half its half-extent so it sits on the snow.
    for (const puff of this.powder) {
      if (puff.age >= puff.life) continue;
      const half = Math.min(puff.grow / puff.life * puff.age, puff.maxHalf);
      const opacity = 0.17 * (1 - puff.age / puff.life);
      at.copy(this.contact)
        .addScaledVector(this.travelDir, puff.scatterA - 200 * U * puff.age)
        .addScaledVector(this.side, puff.scatterB)
        .addScaledVector(this.n, half * 0.5);
      this.additive.push(at, half, half, opacity, 0.7, 0.7, 0.7, puff.sprite, puff.flipU, puff.flipV);
    }

    this.additive.end();
    this.chunks.end();
  }

  private rebuildSpry() {
    if (this.spryColumns.length < 2) { this.spryGeometry.setDrawRange(0, 0); return; }
    const railV = [0.98, 0.66, 0.34, 0.02];
    for (let column = 0; column < this.spryColumns.length; column++) {
      const sample = this.spryColumns[column];
      const alpha = sample.alpha * clamp01((SPRY_LIFE - sample.age) / SPRY_LIFE);
      for (let rail = 0; rail < SPRY_RAILS; rail++) {
        const vertex = column * SPRY_RAILS + rail;
        const p = vertex * 3, uv = vertex * 2;
        this.spryPosition[p] = sample.points[rail].x;
        this.spryPosition[p + 1] = sample.points[rail].y;
        this.spryPosition[p + 2] = sample.points[rail].z;
        this.spryUv[uv] = sample.u;
        this.spryUv[uv + 1] = railV[rail];
        this.spryAlpha[vertex] = alpha;
      }
    }
    for (const name of ['position', 'uv', 'particleAlpha'])
      (this.spryGeometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    this.spryGeometry.setDrawRange(0, (this.spryColumns.length - 1) * (SPRY_RAILS - 1) * 6);
  }

  // ---- helpers ----

  private normalized(value: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
    return value.lengthSq() > 1e-8 ? value.clone().normalize() : fallback.clone().normalize();
  }

  private randomExSprite(): number { return BOARD_SPRITE.ex06 + Math.floor(this.random() * 4); }

  private random(): number {
    let x = this.rng | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 0x1_0000_0000;
  }

  private range(min: number, max: number): number { return min + (max - min) * this.random(); }
}
