import * as THREE from 'three';
import {
  createUvScrollPlayback,
  createTextureFlipPlayback,
  editorUvScrollVPhase,
  isTextureFlipPulse,
  materialWorldEffectsKey,
  selectTextureFlipPlaybackFrame,
  startTextureFlipPulse,
  stepUvScrollPlayback,
  stepTextureFlipPlayback,
  type MaterialControlReceiver,
  type MaterialWorldEffects,
  type TextureFlipPlayback,
  type UvScrollPlayback,
} from '../../core/effects/world-effects';
import { CUSTOM_TEX_LEVEL, makeTexRef } from '../../core/paint/textures';
import type { PropInstance } from '../../core/reference/props';
import type { PropAlphaMode } from '../../core/reference/props';
import { textureUrl } from '../net/asset-paths';
import {
  asTextureArrayImage, buildTextureArrayBank, canPackTextureArrays, materialTextureArray,
  planTextureArrayBank, useTextureArray,
  type TextureArrayBank, type TextureArraySlot,
} from '../viewport/mesh/texture-array';
import {
  analyzeTextureImage, applyTextureAlphaMode, invalidateTextureAlphaLevel, resolvePropAlphaMode,
  type TextureAlphaAnalysis, type TextureAlphaPolicy,
} from './texture-alpha';

/** Preview buckets for a prop's ground light (see `PropTextures.groundLit`). 12 keeps the step under what a
 *  viewer can pick out while bounding how many materials a prop-heavy mountain allocates. */
const GROUND_LIGHT_STEPS = 12;
const NATIVE_LIGHT_TEXELS = 7;

/** Store a reference instance id in Three's existing per-instance RGB channel. Native materials consume it
 * as a lookup key rather than a diffuse tint; 24 bits covers every practical PBD instance table. */
export function propLightIndexColor(sourceIndex: number, out = new THREE.Color()): THREE.Color {
  const index = Math.max(0, Math.min(0xffffff, Math.trunc(sourceIndex)));
  return out.setRGB((index & 0xff) / 255, ((index >>> 8) & 0xff) / 255, ((index >>> 16) & 0xff) / 255);
}

function emptyNativeLightTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Rewrite a Lambert fragment shader so the back-face normal flip becomes switchable at `uPs2Normals`
 * (0 = three.js's flip, 1 = the hardware's: use the normal as stored). Exported for the check below.
 *
 * It patches the `#include` rather than the chunk body because `onBeforeCompile` runs BEFORE three.js
 * resolves includes (WebGLRenderer calls it, then WebGLProgram calls resolveIncludes) — matching on the
 * body would silently no-op and the preview would go on quietly lying about inside-out meshes.
 */
export function ps2NormalShader(fragmentShader: string): string {
  const patched = THREE.ShaderChunk.normal_fragment_begin
    .replace('normal *= faceDirection;', 'normal *= mix( faceDirection, 1.0, uPs2Normals );');
  return fragmentShader
    .replace('void main() {', 'uniform float uPs2Normals;\nvoid main() {')
    .replace('#include <normal_fragment_begin>', patched);
}

/** Does the rewrite still bite? Both anchors are three.js source strings, so a three upgrade that renames
 *  either would otherwise revert prop shading to the flip with nothing to notice it. */
export function ps2NormalShaderApplies(): boolean {
  return THREE.ShaderChunk.normal_fragment_begin.includes('normal *= faceDirection;')
    && ps2NormalShader('#include <normal_fragment_begin>\nvoid main() {}').includes('uPs2Normals');
}

/**
 * Rewrite a Lambert fragment shader so the DIRECTIONAL contribution alone scales by `uKeyScale` — the light
 * on the ground the prop stands on (docs/032 · lighting).
 *
 * Only the key, never the fill: that is the shape of the record the export ships, where
 * `key = sun × the ground's baked light` while `ambient = ambient × AO`. Scaling the whole prop instead
 * would darken it in shade far past what the hardware does — and shade is precisely the case this exists to
 * show. Tinting `material.color` would have been simpler and would have made exactly that mistake, since
 * Lambert multiplies it into both terms.
 *
 * Every directional light in the shader is scaled, which is exact here because prop lighting drives this:
 * with the authored sun on, `propKey` is the only directional light props see, and with it off the scale is
 * left at 1 for the studio rig.
 *
 * Patches the `#include` rather than the chunk body for the same reason as `ps2NormalShader` —
 * `onBeforeCompile` runs before three.js resolves includes.
 */
export function propKeyScaleShader(fragmentShader: string): string {
  const patched = THREE.ShaderChunk.lights_fragment_begin
    .replace('getDirectionalLightInfo( directionalLight, directLight );',
      'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= mix( 1.0, uKeyScale, uPs2Normals );')
    .replace('vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
      'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );\n\tirradiance *= mix( 1.0, uFillScale, uPs2Normals );');
  return fragmentShader
    .replace('void main() {', 'uniform float uKeyScale;\nuniform float uFillScale;\nvoid main() {')
    .replace('#include <lights_fragment_begin>', patched);
}

/** Carry the model-local stored normal to the fragment shader. Retail's instance light vectors live in this
 * exact frame, so transforming both through Three's world/view matrices would reintroduce the yaw error the
 * native records already solved. */
export function ps2ObjectNormalVertexShader(vertexShader: string): string {
  return vertexShader
    .replace('void main() {', 'attribute vec3 ps2StoredNormal;\nvarying vec3 vPs2ObjectNormal;\nvoid main() {')
    .replace('#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\nvPs2ObjectNormal = normalize( ps2StoredNormal );');
}

export function ps2ObjectNormalVertexShaderApplies(): boolean {
  const patched = ps2ObjectNormalVertexShader('#include <beginnormal_vertex>\nvoid main() {}');
  return patched.includes('attribute vec3 ps2StoredNormal;')
    && patched.includes('vPs2ObjectNormal = normalize( ps2StoredNormal );');
}

/** As above: a three upgrade that renames the anchor would silently flatten every prop back to one uniform
 *  key, which looks plausible and is exactly the bug this preview exists to rule out. */
export function propKeyScaleShaderApplies(): boolean {
  return THREE.ShaderChunk.lights_fragment_begin.includes('getDirectionalLightInfo( directionalLight, directLight );')
    && propKeyScaleShader('#include <lights_fragment_begin>\nvoid main() {}').includes('uKeyScale');
}

/**
 * Three normally decodes an sRGB texture to linear light, applies Lambert there, then encodes the result.
 * The PS2 GS does not: it multiplies the stored texture bytes by the interpolated 8-bit vertex colour, in
 * the texture's byte/sRGB space. At a 0.5 light factor those are visibly different — Three shows a pale
 * snow texel at roughly 0.74 while the game shows it at 0.5.
 *
 * Recover the numerical light factor Three just accumulated, move the decoded diffuse texel back into
 * sRGB, multiply and saturate there, then return to linear for Three's ordinary output transform. The
 * material's self-lit variant has zero diffuse and therefore deliberately stays on its emissive path.
 */
export function ps2ColorModulationShader(fragmentShader: string): string {
  const anchor = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';
  const replacement = `${anchor}

	if ( uPs2Normals > 0.5 && max( max( diffuseColor.r, diffuseColor.g ), diffuseColor.b ) > 0.000001 ) {
		vec3 ps2Light;
		if ( uNativeRecords > 0.5 ) {
			float instanceIndex = ps2NativeInstanceIndex();
			vec3 objectNormal = normalize( vPs2ObjectNormal );
			ps2Light = ps2NativeLightTexel( instanceIndex, 0 ).rgb;
			for ( int key = 0; key < 3; key ++ ) {
				vec3 color = ps2NativeLightTexel( instanceIndex, 1 + key * 2 ).rgb;
				vec3 direction = ps2NativeLightTexel( instanceIndex, 2 + key * 2 ).rgb;
				ps2Light += max( 0.0, dot( objectNormal, direction ) ) * color;
			}
		} else {
			ps2Light = ( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse )
				/ max( diffuseColor.rgb, vec3( 0.000001 ) );
		}
		vec3 ps2Srgb = sRGBTransferOETF( vec4( diffuseColor.rgb, 1.0 ) ).rgb;
		ps2Srgb *= clamp( ps2Light, vec3( 0.0 ), vec3( 1.0 ) );
		outgoingLight = sRGBTransferEOTF( vec4( ps2Srgb, 1.0 ) ).rgb + totalEmissiveRadiance;
	}`;
  const color = THREE.ShaderChunk.color_fragment
    .replace('diffuseColor *= vColor;', 'diffuseColor *= mix( vColor, vec4( 1.0 ), uNativeRecords );')
    .replace('diffuseColor.rgb *= vColor;', 'diffuseColor.rgb *= mix( vColor, vec3( 1.0 ), uNativeRecords );');
  const declarations = `uniform float uNativeRecords;
uniform sampler2D uNativeLightTable;
varying vec3 vPs2ObjectNormal;
float ps2NativeInstanceIndex() {
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	// r185 classifies BatchedMesh's vec4 batching colour as USE_COLOR_ALPHA. RGB still carries the index.
	return dot( floor( vColor.rgb * 255.0 + 0.5 ), vec3( 1.0, 256.0, 65536.0 ) );
#else
	// Authored/custom props do not allocate an instance-colour channel. Their uNativeRecords is zero, but
	// GLSL still compiles both sides of that runtime branch, so vColor must remain behind a compile-time guard.
	return 0.0;
#endif
}
vec4 ps2NativeLightTexel( const in float instanceIndex, const in int field ) {
	int size = textureSize( uNativeLightTable, 0 ).x;
	int texel = int( instanceIndex ) * ${NATIVE_LIGHT_TEXELS} + field;
	return texelFetch( uNativeLightTable, ivec2( texel % size, texel / size ), 0 );
}`;
  return fragmentShader
    .replace('void main() {', `${declarations}\nvoid main() {`)
    .replace('#include <color_fragment>', color)
    .replace(anchor, replacement);
}

/** Guard the exact MeshLambert anchor: a Three upgrade must fail a check rather than silently restoring
 * linear-light modulation and making the preview brighter than the ISO again. */
export function ps2ColorModulationShaderApplies(): boolean {
  const anchor = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';
  const patched = ps2ColorModulationShader(`#include <color_fragment>\n${anchor}\nvoid main() {}`);
  // Three r185 unified vertex/instance colours as vec4; older releases emitted a vec3 path for USE_COLOR.
  // Pin whichever shape the installed ShaderChunk publishes so a future rename still fails this guard.
  const nativeColorBypass = THREE.ShaderChunk.color_fragment.includes('diffuseColor *= vColor;')
    ? 'mix( vColor, vec4( 1.0 ), uNativeRecords )'
    : 'mix( vColor, vec3( 1.0 ), uNativeRecords )';
  return patched.includes('sRGBTransferOETF') && patched.includes('sRGBTransferEOTF')
    && patched.includes('clamp( ps2Light') && patched.includes('ps2NativeLightTexel')
    && patched.includes(nativeColorBypass)
    && patched.includes('#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )')
    && patched.includes('return 0.0;');
}

/** Per-material appearance flags resolved from the source level's data. */
export interface PropMaterialOpts {
  /** Explicit glTF/author/TextureAlpha.overrides verdict. Wins over flags and decoded pixels. */
  alphaMode?: PropAlphaMode;
  /** The material's alpha-pass appearance flag (UnknownInt18 bit 18). Pixel analysis then separates
   *  alpha-test cutouts from genuinely translucent/glow surfaces. */
  blend?: boolean;
  /** The opaque draw-priority bit (UnknownInt18 bit 17). Its binary-mask decals still alpha-test. */
  priority?: boolean;
  /** An authored/imported material whose native flag word is neutral, so its conventional PNG decides. */
  pixelAlpha?: boolean;
  /** The geometry drawn with this material is a single-facing sheet, so it cannot occlude part of itself and
   *  a blend material can drop depth write. Stacked sheets — MESA's river is a fast layer over a slow one —
   *  then composite from either side instead of the nearer one depth-rejecting the farther. */
  sheet?: boolean;
}

/**
 * Does this (effect, frames) pair produce an ANIMATED material — one whose Texture offset or Source changes
 * as it runs? Exactly the condition `PropTextureCache.material` branches on, exported so the array-bank path
 * can ask the question BEFORE building a material, and so the two readings cannot drift apart.
 *
 * It is the line between what can and cannot join a packed bank: a scroller moves `texture.offset` and a
 * flipbook swaps `texture.source`, and neither has any meaning for one slice of a shared array.
 */
export function isAnimatedPropMaterial(effect: MaterialWorldEffects | null | undefined,
  frames: readonly string[]): boolean {
  return !!effect?.uvScroll || !!(effect?.textureFlip && frames.length > 1);
}

/** Every normal within SHEET_MIN_DOT of their mean: a sheet, not a closed shell. Measured across the retail
 *  blend surfaces, the two classes sit far apart — water sheets score +0.95 or better, while the blend-flagged
 *  towers (GARI Radiotower, MediaTower) score -0.5 or worse. Missing normals answer false, keeping depth write. */
const SHEET_MIN_DOT = 0.5;
export function isSingleFacingSheet(normals: ArrayLike<number> | undefined | null): boolean {
  if (!normals || normals.length < 3) return false;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i + 2 < normals.length; i += 3) { mx += normals[i]; my += normals[i + 1]; mz += normals[i + 2]; }
  const len = Math.hypot(mx, my, mz);
  if (len < 1e-6) return false;
  mx /= len; my /= len; mz /= len;
  for (let i = 0; i + 2 < normals.length; i += 3)
    if (normals[i] * mx + normals[i + 1] * my + normals[i + 2] * mz < SHEET_MIN_DOT) return false;
  return true;
}

interface AnimatedPropMaterial {
  material: THREE.MeshLambertMaterial;
  texture: THREE.Texture;
  frameTextures: THREE.Texture[];
  /** Settles with the resting page load (success or failure). Pending clones stay at texture version zero so
   * Three r185 does not retry and warn on the same image-less upload every frame. */
  ready: Promise<void>;
  effect: MaterialWorldEffects;
  uv: UvScrollPlayback | null;
  flip: TextureFlipPlayback | null;
  u: number;
  v: number;
  runtimeControlled: boolean;
  /** Copy-on-write boundary. False keeps frame zero on TextureLoader's Source so its asynchronous completion
   * reaches this draw; the first actual frame change forks a private renderer upload identity. */
  ownsTextureSource: boolean;
  /**
   * Every material drawing this animation: the cache entry itself plus the variants built from it — a
   * native-lit retail draw, a ground-lit or sign-tinted one, a self-lit sign face.
   *
   * A variant shares the entry's Texture OBJECT, which is why UV scrolling reaches it for free. A frame
   * change cannot work that way — it must fork a private Texture (above) — so the fork has to rebind every
   * material in this set. Rebinding only the cache entry leaves each variant sampling a texture that was
   * just disposed, which is a retail flipbook (a Merqury City barrier's lights) frozen on frame zero.
   */
  bound: Set<THREE.Material>;
}

interface PropMaterialAlphaSpec {
  level: string;
  file: string;
  frames: readonly string[];
  opts: PropMaterialOpts;
}

function setAnimatedMaterialFrame(animated: AnimatedPropMaterial, frame: number): void {
  const source = animated.frameTextures[frame]?.source;
  // A missing/failed flipbook page is not a frame. Keeping the last valid Source also avoids asking Three
  // r185 to upload `null` forever ("Texture marked for update but no image data found" on every render).
  if (!source?.data) return;
  if (!animated.ownsTextureSource) {
    // Frame zero must stay attached to TextureLoader's Source until the image finishes loading. Fork only
    // when this material actually selects different pixels; detaching during construction leaves a Source
    // whose version never receives the loader's completion update, so the resting frame is invisible in Edit.
    if (animated.texture.source.data === source.data) return;
    // Do not change Source on an already-uploaded Texture object. Three keys its WebGL allocation bookkeeping
    // by Source; swapping only this field lets the new frame render through the old allocation but leaves the
    // texture's disposal key in a different Source map. Project switching then reaches Three's deallocator and
    // finds no entry (`usedTimes` on undefined). Copy-on-write replaces BOTH renderer identities for ambient
    // flipbooks as well as per-instance controls, while every other draw keeps the resting frame.
    const previous = animated.texture;
    const texture = previous.clone();
    texture.source = new THREE.Source(source.data);
    texture.needsUpdate = true;
    animated.texture = texture;
    for (const material of animated.bound) {
      const lambert = material as THREE.MeshLambertMaterial;
      if (lambert.map === previous) lambert.map = texture;
      if (lambert.emissiveMap === previous) lambert.emissiveMap = texture;
      lambert.needsUpdate = true;
    }
    animated.ownsTextureSource = true;
    previous.dispose();
    return;
  }
  animated.texture.source.data = source.data;
  animated.texture.needsUpdate = true;
}

/**
 * Prop textures + materials, cached by (level, file). Both the reference-props view and the authored placed
 * props texture their meshes through this, from the SAME Textures/ the paint palette reads (served by
 * /api/texture). Textures are lit (MeshLambert, double-sided); their decoded pixels refine the native
 * alpha-pass/priority flags into opaque, depth-writing cutout, blend, or glow state. A material with no
 * texture falls back to neutral clay so untextured props still read as forms. See docs/012-props.md.
 *
 * Prop UVs are the model's raw OBJ vt (bottom-left origin); TextureLoader's default flipY=true matches that
 * (and the Unity import, which restores raw vt via its own 1-v flip), so — unlike the terrain tiles — these
 * are NOT flipped.
 */
export class PropTextureCache {
  private loader = new THREE.TextureLoader();
  private textures = new Map<string, THREE.Texture>();
  private settled = new Map<string, Promise<void>>();
  private mats = new Map<string, THREE.MeshLambertMaterial>();
  /** The active reference level's packed page bank (mesh/texture-array.ts) and the materials drawing through
   *  it, keyed by appearance class rather than by page. */
  private arrayBank: TextureArrayBank | null = null;
  private arrayBankBuild: { level: string; done: Promise<boolean> } | null = null;
  private arrayMats = new Map<string, THREE.MeshLambertMaterial>();
  private animatedMats = new Map<string, AnimatedPropMaterial>();
  private animatedByMaterial = new WeakMap<THREE.Material, AnimatedPropMaterial>();
  /** Pixel verdicts arrive with TextureLoader. Per-page materials can exist before that; tracking their
   * dependencies lets the load atomically switch the actual framebuffer state from its conservative fallback. */
  private alphaAnalyses = new Map<string, TextureAlphaAnalysis>();
  private alphaSpecs = new WeakMap<THREE.Material, PropMaterialAlphaSpec>();
  private alphaConsumers = new Map<string, Set<THREE.Material>>();
  /** Materials the inspector's ▶ Preview effect is currently running. A material property is a render-layer
   *  clock rather than a scheduled action, so Preview reaches it by ungating that clock for one host instead
   *  of by dispatching anything: the law it runs is the one the placement's own graph installed. */
  private previewMats = new Set<AnimatedPropMaterial>();
  private worldEffectsEnabled = false;
  /**
   * 0 = three.js's ordinary double-sided shading; 1 = the PS2's.
   *
   * Prop meshes are DoubleSide (a prop is arbitrary art and its back faces have to draw), and three.js
   * NEGATES the shading normal on a back face — so a mesh wound inside-out is lit exactly as if it were
   * wound correctly, and the editor can never show it wrong. The hardware does no such thing: it evaluates
   * `ambient + Σ max(0, N·L)·key` against the normal as stored, so an inverted mesh renders ambient-only
   * (a MOUNTAIN39 lollipop, whose 764 triangles all face inward, ships dark for exactly this reason).
   *
   * Suppressing the flip makes the preview agree. It rides a shared uniform rather than a define so the
   * toggle is one assignment across every prop material, with no shader recompile.
   */
  private readonly ps2Normals = { value: 0 };
  // Declared BEFORE `neutral`: that field initialiser runs `lit()`, which resolves the light-scale uniforms.
  private readonly keyScales = new WeakMap<THREE.Material, { value: number }>();
  private readonly fillScales = new WeakMap<THREE.Material, { value: number }>();
  private readonly nativeRecords = new WeakMap<THREE.Material, { value: number }>();
  private readonly nativeLightTable = { value: emptyNativeLightTexture() };
  private readonly groundLitMats = new Map<string, THREE.Material>();
  private readonly nativeMats = new Map<string, THREE.Material>();
  private readonly fullBrightMats = new Map<string, THREE.Material>();
  readonly neutral = this.lit(new THREE.MeshLambertMaterial({ color: 0xc2bbaa, emissive: 0x0d0f12, side: THREE.DoubleSide }));

  private alphaPolicy(opts: PropMaterialOpts): TextureAlphaPolicy {
    return { mode: opts.alphaMode, alphaPass: opts.blend, priority: opts.priority, pixelAlpha: opts.pixelAlpha };
  }

  private alphaMode(spec: PropMaterialAlphaSpec) {
    const files = [...new Set([spec.file, ...spec.frames])];
    return resolvePropAlphaMode(
      files.map(file => this.alphaAnalyses.get(makeTexRef(spec.level, file))), this.alphaPolicy(spec.opts));
  }

  private applyTrackedAlpha(material: THREE.Material): void {
    const spec = this.alphaSpecs.get(material);
    if (spec) applyTextureAlphaMode(material, this.alphaMode(spec), !!spec.opts.sheet);
  }

  private trackAlpha(material: THREE.Material, spec: PropMaterialAlphaSpec): void {
    const tracked: PropMaterialAlphaSpec = { ...spec, frames: [...spec.frames], opts: { ...spec.opts } };
    this.alphaSpecs.set(material, tracked);
    const dependencies = [...new Set([tracked.file, ...tracked.frames])]
      .map(file => makeTexRef(tracked.level, file));
    for (const dependency of dependencies) {
      const consumers = this.alphaConsumers.get(dependency);
      if (consumers) consumers.add(material); else this.alphaConsumers.set(dependency, new Set([material]));
    }
    material.addEventListener('dispose', () => {
      for (const dependency of dependencies) {
        const consumers = this.alphaConsumers.get(dependency);
        consumers?.delete(material);
        if (consumers?.size === 0) this.alphaConsumers.delete(dependency);
      }
    });
    this.applyTrackedAlpha(material);
  }

  private recordAlpha(level: string, file: string, image?: unknown): void {
    const key = makeTexRef(level, file);
    let analysis: TextureAlphaAnalysis = { kind: 'unknown', glow: false };
    try {
      if (image) analysis = analyzeTextureImage(image as CanvasImageSource);
    } catch { /* retain the policy fallback */ }
    this.alphaAnalyses.set(key, analysis);
    for (const material of this.alphaConsumers.get(key) ?? []) this.applyTrackedAlpha(material);
  }

  /** Give a prop material the PS2 normal handling above. Every material this cache hands out goes through
   *  here, INCLUDING the animated clones — `Material.copy` does not carry `onBeforeCompile`, so a clone that
   *  skipped this would silently keep shading a scrolled or flipbooked prop the three.js way. */
  private lit<T extends THREE.Material>(m: T): T {
    const keyScale = this.keyScaleUniform(m);
    const fillScale = this.fillScaleUniform(m);
    const nativeRecords = this.nativeRecordUniform(m);
    m.onBeforeCompile = shader => {
      shader.uniforms.uPs2Normals = this.ps2Normals;   // shared: the flip is a global mode
      shader.uniforms.uKeyScale = keyScale;            // per material: the ground under THIS prop
      shader.uniforms.uFillScale = fillScale;          // per material: native ambient / authored ambient
      shader.uniforms.uNativeRecords = nativeRecords;
      shader.uniforms.uNativeLightTable = this.nativeLightTable;
      shader.vertexShader = ps2ObjectNormalVertexShader(shader.vertexShader);
      shader.fragmentShader = ps2ColorModulationShader(propKeyScaleShader(ps2NormalShader(shader.fragmentShader)));
    };
    return m;
  }

  /** Each material owns its key scale, because that is what varies per prop; `ps2Normals` is shared because
   *  it doesn't. Kept off `userData` so a `Material.copy` can't quietly alias two props onto one value. */
  private keyScaleUniform(m: THREE.Material): { value: number } {
    let u = this.keyScales.get(m);
    if (!u) this.keyScales.set(m, u = { value: 1 });
    return u;
  }

  private fillScaleUniform(m: THREE.Material): { value: number } {
    let u = this.fillScales.get(m);
    if (!u) this.fillScales.set(m, u = { value: 1 });
    return u;
  }

  private nativeRecordUniform(m: THREE.Material): { value: number } {
    let u = this.nativeRecords.get(m);
    if (!u) this.nativeRecords.set(m, u = { value: 0 });
    return u;
  }

  /** Install the active reference level's exact per-instance ambient and three directional records. Colours
   * are normalised against the PS2's 256 texture-true value; directions remain signed model-local vectors. */
  setNativeLighting(instances: readonly Pick<PropInstance, 'sourceIndex' | 'lighting'>[] | null): void {
    const maximum = instances?.reduce((value, instance) => Math.max(value, instance.sourceIndex), -1) ?? -1;
    const texels = Math.max(1, (maximum + 1) * NATIVE_LIGHT_TEXELS);
    const size = Math.ceil(Math.sqrt(texels));
    const data = new Float32Array(size * size * 4);
    for (const instance of instances ?? []) {
      if (!instance.lighting || instance.sourceIndex < 0) continue;
      const base = instance.sourceIndex * NATIVE_LIGHT_TEXELS * 4;
      for (let channel = 0; channel < 3; channel++) data[base + channel] = instance.lighting.ambient[channel] / 256;
      for (let key = 0; key < 3; key++) {
        const light = instance.lighting.keys[key];
        if (!light) continue;
        const color = base + (1 + key * 2) * 4;
        const direction = base + (2 + key * 2) * 4;
        for (let channel = 0; channel < 3; channel++) {
          data[color + channel] = light.color[channel] / 256;
          data[direction + channel] = light.direction[channel];
        }
      }
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    this.nativeLightTable.value.dispose();
    this.nativeLightTable.value = texture;
  }

  /** Native retail material: same tile/animation, but the exact instance record supplies the PS2 light. */
  native<T extends THREE.MeshLambertMaterial>(base: T): T {
    let material = this.nativeMats.get(base.uuid) as T | undefined;
    if (!material) {
      material = this.variant(base);
      const animated = this.animatedByMaterial.get(base);
      if (animated?.runtimeControlled) {
        // A native-lit draw is a material variant layered over the per-instance controlled base. Material.copy
        // shares its Texture object, which is normally desirable for ambient animation but is the wrong final
        // ownership boundary for a runtime state such as one cracked pane. Detach the actual draw texture and
        // playback too: changing this native instance can then reach neither the controlled base nor another
        // native-lit instance that happens to use the same model material/frame bank.
        const texture = this.pendingSafeClone(animated.texture, animated.ready);
        material.map = texture;
        if (material.emissiveMap === animated.texture) material.emissiveMap = texture;
        // ...including its membership of the shared entry's bound set: this draw's frames are its own now,
        // and leaving it there would let the ambient animation rebind the map underneath it.
        animated.bound.delete(material);
        const owned: AnimatedPropMaterial = {
          ...animated,
          material,
          texture,
          uv: animated.effect.uvScroll ? createUvScrollPlayback(animated.effect.uvScroll) : null,
          flip: animated.effect.textureFlip && animated.frameTextures.length > 1
            ? createTextureFlipPlayback(animated.effect.textureFlip) : null,
          ownsTextureSource: false,
          bound: new Set<THREE.Material>([material]),
        };
        this.animatedMats.set(`native-runtime:${base.uuid}`, owned);
        this.animatedByMaterial.set(material, owned);
      }
      this.nativeRecordUniform(material).value = 1;
      this.nativeMats.set(base.uuid, material);
    }
    return material;
  }

  isNative(material: THREE.Material): boolean { return this.nativeRecordUniform(material).value > 0.5; }

  /**
   * The material for a prop standing on ground lit to `groundLight` (0 dark .. 1 full sun) — the preview
   * side of the per-instance key the export bakes (docs/032 · lighting).
   *
   * Quantised into `GROUND_LIGHT_STEPS` buckets and cached per (base material, bucket). Props share
   * materials by texture, so a distinct material per placement would multiply draw state across a mountain
   * with hundreds of props; a distinct one per bucket bounds that at 12× the texture count while staying
   * well under the step a viewer can see. The quantisation is preview-only — the export writes the
   * unrounded value.
   */
  groundLit<T extends THREE.MeshLambertMaterial>(base: T, groundLight: number): T {
    const step = Math.round(Math.min(1, Math.max(0, groundLight)) * (GROUND_LIGHT_STEPS - 1));
    if (step === GROUND_LIGHT_STEPS - 1) return base;              // fully lit: the shared material already is
    const k = `${base.uuid}:${step}`;
    let m = this.groundLitMats.get(k) as T | undefined;
    if (!m) {
      m = this.variant(base);
      this.keyScaleUniform(m).value = step / (GROUND_LIGHT_STEPS - 1);
      this.groundLitMats.set(k, m);
    }
    return m;
  }

  /** Shade props the way the hardware will (normals as stored, no back-face flip) or the way three.js
   *  ordinarily does. Driven by the sun preview: with the authored sun on you are asking what ships. */
  setPs2Normals(on: boolean) { this.ps2Normals.value = on ? 1 : 0; }

  /** A private copy of a cached prop material (a ghost's translucent variant, a sign's tinted one) that keeps
   *  the shading above — clone it directly and it silently reverts to three.js's back-face flip. Overlays that
   *  deliberately replace the source framebuffer state pass `followAlpha=false`. */
  variant<T extends THREE.Material>(m: T, followAlpha = true): T {
    const clone = this.lit(m.clone() as T);
    // `lit` ASSIGNS onBeforeCompile, so a variant of an array material has just lost its array sampling and
    // would draw the 1x1 stand-in — a whole batch rendering flat white. Reinstall it over the fresh hook.
    const array = materialTextureArray(m);
    if (array) useTextureArray(clone as unknown as THREE.MeshLambertMaterial, array, `variant:${m.uuid}`);
    this.nativeRecordUniform(clone).value = this.nativeRecordUniform(m).value;
    const animated = this.animatedByMaterial.get(m);
    // A variant draws the same animation, so it joins the bound set: scrolling reaches it through the shared
    // Texture, and a frame change reaches it because the fork rebinds everything in here. The set holds a
    // strong reference, so it leaves on the variant's own dispose — a sign tint is rebuilt with every props
    // rebuild, and a set that only grew would pin one dead material per rebuild forever.
    if (animated) {
      this.animatedByMaterial.set(clone, animated);
      animated.bound.add(clone);
      clone.addEventListener('dispose', () => animated.bound.delete(clone));
    }
    const alpha = this.alphaSpecs.get(m);
    if (alpha && followAlpha) this.trackAlpha(clone, alpha);
    return clone;
  }

  /** Scale the key on a material you already own privately (a sign's tinted variant), where `groundLit`'s
   *  shared bucket would leak one prop's ground light onto every other prop wearing that tint. */
  setKeyScale(m: THREE.Material, groundLight: number): void {
    this.keyScaleUniform(m).value = Math.min(1, Math.max(0, groundLight));
  }

  /**
   * The SELF-LIT variant of a prop material: the texture at full brightness, untouched by any light — a sign
   * face, an LCD screen, a lamp head (`PlacedProp.fullBright`).
   *
   * Done by moving the tile to the EMISSIVE channel and blacking out `color`, rather than by swapping in a
   * `MeshBasicMaterial`. Emissive is added after shading and the black diffuse zeroes the lit term, so the
   * result is exactly the tile — but it keeps the Lambert material this cache already wires up, so a
   * scrolling or flipbooked sign keeps animating and the alpha-test cutout still punches through (alpha
   * still comes from the map). A Basic swap would have needed all of that plumbed a second time.
   */
  fullBright<T extends THREE.MeshLambertMaterial>(base: T): T {
    const k = `fb:${base.uuid}`;
    let m = this.fullBrightMats.get(k) as T | undefined;
    if (!m) {
      m = this.variant(base);
      m.emissiveMap = base.map;          // same Texture object, so UV scroll / frame phase stay in step
      // Untextured, the tile can't carry the colour, so the material's own does — otherwise blacking out
      // `color` below would leave a plain white blob where a clay-coloured prop should be.
      m.emissive.copy(base.map ? new THREE.Color(1, 1, 1) : base.color);
      m.color.setRGB(0, 0, 0);           // no diffuse => the lit term drops out; emissive carries the tile
      this.fullBrightMats.set(k, m);
    }
    return m;
  }

  private key(level: string, file: string, opts?: PropMaterialOpts) {
    return `${makeTexRef(level, file)}`
      + `${opts?.alphaMode ? `:alpha-${opts.alphaMode}` : ''}`
      + `${opts?.blend ? ':alpha-pass' : ''}${opts?.priority ? ':priority' : ''}`
      + `${opts?.pixelAlpha ? ':pixel-alpha' : ''}${opts?.sheet ? ':sheet' : ''}`;
  }

  /** A cached tile texture, kicking off its download the first time (the render loop folds it in on arrival). */
  texture(level: string, file: string): THREE.Texture {
    const k = this.key(level, file);
    let t = this.textures.get(k);
    if (!t) {
      // Settle rather than resolve-on-success: the array bank packs a whole page set at once, so a 404 has to
      // release the wait exactly as an arrival does or one absent page would strand the whole bank.
      let settle = () => { /* replaced below, before any load callback can run */ };
      this.settled.set(k, new Promise<void>(resolve => { settle = resolve; }));
      t = this.loader.load(textureUrl(level, file), loaded => {
        this.recordAlpha(level, file, loaded.image);
        settle();
      }, undefined, () => {
        this.recordAlpha(level, file);
        settle();
      });
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.textures.set(k, t);
    }
    return t;
  }

  /** Resolves once this page has arrived or failed — never rejects. */
  private textureSettled(level: string, file: string): Promise<void> {
    this.texture(level, file);
    return this.settled.get(this.key(level, file)) ?? Promise.resolve();
  }

  /** Texture.clone() eagerly marks its shared Source for upload. That is harmless after an image has arrived,
   * but r185 warns on every render while a TextureLoader request is pending (and forever after a 404). Hold
   * the wrapper at version zero until the loader settles successfully; it still shares the loader Source. */
  private pendingSafeClone(source: THREE.Texture, ready: Promise<void>): THREE.Texture {
    const texture = source.clone();
    if (source.image == null) {
      texture.version = 0;
      let disposed = false;
      texture.addEventListener('dispose', () => { disposed = true; });
      void ready.then(() => {
        if (!disposed && texture.image != null) texture.needsUpdate = true;
      });
    }
    return texture;
  }

  /**
   * Pack a level's prop pages into one WebGL2 array texture so a static batch stops being one draw per page
   * (mesh/texture-array.ts). Returns whether a bank is in place — false leaves every caller on the per-page
   * materials it already had, which is the same picture at more draws.
   *
   * It has to complete BEFORE the prop meshes are built, because which pages share an array is what decides
   * which submeshes can share a `BatchedMesh`; that partition cannot be revised afterwards without rebuilding
   * every batch. Hence the wait, and hence the deadline on it: a page that never answers costs the level its
   * bank, never its props.
   */
  buildPropArrayBank(level: string, files: readonly string[], deadlineMs = 8000): Promise<boolean> {
    // Asked before the pages are requested, not after: a host with no document cannot pack a bank AND cannot
    // fetch an image, so waiting on downloads there would hang the prop build rather than merely skip a bank.
    if (!canPackTextureArrays()) return Promise.resolve(false);
    // One build per level, SHARED: a second caller arriving mid-pack must wait for the same bank rather than
    // see an empty one and build a whole level of props unbanked, only for the first to redo it.
    if (this.arrayBankBuild?.level === level) return this.arrayBankBuild.done;
    this.disposePropArrayBank();
    const done = this.packPropArrayBank(level, files, deadlineMs);
    this.arrayBankBuild = { level, done };
    return done;
  }

  private async packPropArrayBank(level: string, files: readonly string[],
    deadlineMs: number): Promise<boolean> {
    const refs = [...new Set(files.filter(Boolean))];
    if (!refs.length) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, deadlineMs); });
    await Promise.race([Promise.all(refs.map(file => this.textureSettled(level, file))), deadline]);
    clearTimeout(timer);
    if (this.arrayBankBuild && this.arrayBankBuild.level !== level) return false; // a newer level took over
    const image = (file: string) => asTextureArrayImage(this.textures.get(this.key(level, file))?.image);
    const plan = planTextureArrayBank(refs.map(file => {
      const source = image(file);
      return { key: file, width: source?.width ?? 0, height: source?.height ?? 0 };
    }));
    // Prop UVs are raw OBJ vt, which the loader's default flipY=true matches; the bank has to flip while it
    // packs because WebGL2 refuses UNPACK_FLIP_Y_WEBGL on a texImage3D taking an array buffer.
    const built = buildTextureArrayBank(plan, image, { flipY: true, dilateAlpha: true, anisotropy: 4 });
    if (!built) return false;
    this.arrayBank = built;
    console.info(`[prop-array] ${level}: ${built.plan.slots.size}/${refs.length} pages in `
      + `${built.textures.length} array(s) at ${built.plan.width}x${built.plan.height}`
      + (built.plan.excluded.length ? `, ${built.plan.excluded.length} kept separate` : ''));
    return true;
  }

  /** Where a page sits in the level's bank, or undefined when it is not in one (no bank, too large, or it
   *  never loaded) — the caller then takes its ordinary per-page material. */
  propArraySlot(file: string | null | undefined): TextureArraySlot | undefined {
    return file ? this.arrayBank?.plan.slots.get(file) : undefined;
  }

  /**
   * The array material for one appearance class. Everything that used to fork a material per PAGE now forks
   * only on state a draw genuinely cannot share: resolved alpha mode / sheet depth law, and whether the PS2's own
   * per-instance light records drive the shading.
   *
   * Built directly rather than through `variant`, because `variant` re-runs `lit`, which REPLACES
   * `onBeforeCompile` — and with it the array sampling this material exists for.
   */
  propArrayMaterial(array: number, level: string, file: string,
    opts: PropMaterialOpts & { native?: boolean }): THREE.MeshLambertMaterial | null {
    const texture = this.arrayBank?.textures[array];
    if (!texture) return null;
    const mode = this.alphaMode({ level, file, frames: [], opts });
    const k = `${array}|${mode}|${opts.sheet ? 1 : 0}${opts.native ? 1 : 0}`;
    let material = this.arrayMats.get(k);
    if (!material) {
      material = this.lit(new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }));
      applyTextureAlphaMode(material, mode, !!opts.sheet);
      useTextureArray(material, texture, `prop:${k}`);
      if (opts.native) this.nativeRecordUniform(material).value = 1;
      this.arrayMats.set(k, material);
    }
    return material;
  }

  disposePropArrayBank(): void {
    this.arrayBank?.dispose();
    for (const material of this.arrayMats.values()) material.dispose();
    this.arrayMats.clear();
    this.arrayBank = null;
    this.arrayBankBuild = null;
  }

  /** The lit material for a prop texture, optionally as an independently animated variant. Variants clone
   * only the Texture wrapper: decoded image storage stays shared while UV offset and frame phase remain local. */
  material(level: string, file: string | null | undefined, effect?: MaterialWorldEffects | null,
    frames: readonly string[] = [], runtimeKey?: string, opts?: PropMaterialOpts): THREE.MeshLambertMaterial {
    if (!file) return this.neutral;
    const flipFrames = effect?.textureFlip && frames.length > 1 ? [...frames] : [];
    if (isAnimatedPropMaterial(effect, frames)) {
      const activeEffect = effect!; // flipFrames can only be populated from effect.textureFlip
      const k = `${this.key(level, file, opts)}:${materialWorldEffectsKey(activeEffect)}:frames:${flipFrames.map(name => makeTexRef(level, name)).join(',')}`
        + (runtimeKey ? `:runtime:${runtimeKey}` : '');
      let animated = this.animatedMats.get(k);
      if (!animated) {
        const base = this.material(level, file, undefined, [], undefined, opts);
        const ready = this.textureSettled(level, file);
        const texture = this.pendingSafeClone(base.map!, ready); // shares loader Source until a runtime control changes its frame
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.offset.set(0, 0);
        const material = this.lit(base.clone());
        material.map = texture;
        material.needsUpdate = true;
        const frameTextures = flipFrames.map(name => this.texture(level, name));
        const made: AnimatedPropMaterial = {
          material,
          texture,
          frameTextures,
          ready,
          effect: activeEffect,
          uv: activeEffect.uvScroll ? createUvScrollPlayback(activeEffect.uvScroll) : null,
          flip: activeEffect.textureFlip && frameTextures.length > 1
            ? createTextureFlipPlayback(activeEffect.textureFlip) : null,
          u: 0,
          v: 0,
          runtimeControlled: !!runtimeKey,
          ownsTextureSource: false,
          bound: new Set<THREE.Material>([material]),
        };
        this.animatedMats.set(k, made);
        this.animatedByMaterial.set(material, made);
        this.trackAlpha(material, { level, file, frames: flipFrames, opts: opts ?? {} });
        animated = made;
      }
      return animated.material;
    }
    const k = this.key(level, file, opts);
    let m = this.mats.get(k);
    if (!m) {
      // The material may precede its image. `trackAlpha` installs a conservative flag-derived fallback now,
      // then TextureLoader's completion changes it to opaque/cutout/blend/glow from the actual pixels.
      m = this.lit(new THREE.MeshLambertMaterial({ map: this.texture(level, file), side: THREE.DoubleSide }));
      this.trackAlpha(m, { level, file, frames: [], opts: opts ?? {} });
      this.mats.set(k, m);
    }
    return m;
  }

  /** Deliver one receiver-aware property control to a particular material variant. Controlled instances are
   * deliberately given private variants by ReferenceDecor, so selecting a start-light frame cannot change
   * every prop that happens to share its texture. */
  controlMaterial(material: THREE.Material, receiver: MaterialControlReceiver, command: number,
    value: number): boolean {
    const animated = this.animatedByMaterial.get(material);
    if (!animated) return false;
    const flipEffect = animated.effect.textureFlip;
    if (receiver === 'texture-flip' && command === 2 && flipEffect && animated.flip
      && animated.frameTextures.length) {
      // One graph run installs the flip node and selects its frame, so a one-shot's lifetime starts here and
      // the material returns to frame zero when it expires. An always-on flip builds no node and is unmoved.
      startTextureFlipPulse(animated.flip, flipEffect);
      selectTextureFlipPlaybackFrame(animated.flip, animated.frameTextures.length, value);
      setAnimatedMaterialFrame(animated, animated.flip.frame);
      return true;
    }
    if (receiver === 'uv-scroll' && command === 6 && animated.effect.uvScroll) {
      animated.v = editorUvScrollVPhase(animated.effect.uvScroll, value);
      animated.texture.offset.y = animated.v;
      return true;
    }
    return false;
  }

  /** Restore a Play-controlled receiver without disturbing unrelated ambient materials in the shared cache. */
  resetMaterialControl(material: THREE.Material, receiver: MaterialControlReceiver) {
    const animated = this.animatedByMaterial.get(material);
    if (!animated) return;
    if (receiver === 'texture-flip' && animated.effect.textureFlip && animated.frameTextures.length) {
      animated.flip = createTextureFlipPlayback(animated.effect.textureFlip);
      setAnimatedMaterialFrame(animated, 0);
    } else if (receiver === 'uv-scroll' && animated.effect.uvScroll) {
      animated.u = animated.v = 0;
      animated.texture.offset.set(0, 0);
      animated.uv = createUvScrollPlayback(animated.effect.uvScroll);
    }
  }

  /**
   * Run one material's installed motion — a UV scroll, a free-running flipbook — for the Effects inspector's
   * ▶ Preview effect, whatever the top-bar Effects filter says. Restarted from rest each time, so Preview
   * shows the node from its first tick like every other preview player.
   *
   * False when this material carries no such motion; the graph runner then falls back to its diagnostic ring
   * rather than reporting a preview it did not start.
   */
  previewMaterialEffect(material: THREE.Material): boolean {
    const animated = this.animatedByMaterial.get(material);
    if (!animated) return false;
    // A one-shot flip is deliberately excluded: it rests until a graph builds its node, and the frame select
    // that paints it already reaches Preview through `controlMaterial`. Free-running it here would show a
    // ride-over button pulsing on its own, which is the one thing its Length says it does not do.
    const flips = !!animated.effect.textureFlip && !isTextureFlipPulse(animated.effect.textureFlip)
      && animated.frameTextures.length > 1;
    if (!animated.effect.uvScroll && !flips) return false;
    if (!this.previewMats.has(animated)) {
      this.restMaterialEffect(animated);
      this.previewMats.add(animated);
    }
    return true;
  }

  /**
   * Stop every Preview-run material and rest it — offset zero, frame zero, a fresh playback.
   *
   * Unconditionally, including while the Effects filter is on. Rest is where the ambient clock starts from,
   * and a phase a Set-UV-phase command wrote during Preview is a state the filter would never have produced
   * on its own: leaving it behind is Preview declining to hand the material back. The filter's own motion
   * simply resumes from rest on the next tick.
   */
  clearMaterialEffectPreviews(): boolean {
    if (!this.previewMats.size) return false;
    for (const animated of this.previewMats) this.restMaterialEffect(animated);
    this.previewMats.clear();
    return true;
  }

  /** Frame zero, offset zero, a fresh playback: the state a material rests at with nothing driving it. */
  private restMaterialEffect(animated: AnimatedPropMaterial) {
    animated.u = animated.v = 0;
    animated.texture.offset.set(0, 0);
    if (animated.effect.uvScroll) animated.uv = createUvScrollPlayback(animated.effect.uvScroll);
    if (animated.effect.textureFlip && animated.frameTextures.length > 1) {
      animated.flip = createTextureFlipPlayback(animated.effect.textureFlip);
      setAnimatedMaterialFrame(animated, 0);
    }
  }

  /** The top-bar Effects filter controls world material motion without hiding the props themselves. */
  setWorldEffectsEnabled(on: boolean) {
    this.worldEffectsEnabled = on;
    if (!on) for (const animated of this.animatedMats.values()) {
      if (animated.runtimeControlled) continue; // Play owns receiver state until its explicit scene reset
      if (this.previewMats.has(animated)) continue; // a running Preview owns its host until Stop
      this.restMaterialEffect(animated);
    }
  }

  /** Drop textures/materials whose logical bank belongs to the previous mountain. Reference-level entries
   * stay warm; the next project-local request receives a URL carrying the new project id. */
  invalidateProjectAssets(): void {
    const prefix = `${CUSTOM_TEX_LEVEL}/`.toLowerCase();
    invalidateTextureAlphaLevel(CUSTOM_TEX_LEVEL);
    for (const key of [...this.alphaAnalyses.keys()])
      if (key.toLowerCase().startsWith(prefix)) this.alphaAnalyses.delete(key);
    const disposedTextures = new Set<THREE.Texture>();
    const disposedMaterials = new Set<THREE.Material>();
    for (const [key, texture] of this.textures) if (key.toLowerCase().startsWith(prefix)) {
      if (!disposedTextures.has(texture)) { texture.dispose(); disposedTextures.add(texture); }
      this.textures.delete(key);
    }
    for (const [key, material] of this.mats) if (key.toLowerCase().startsWith(prefix)) {
      if (!disposedMaterials.has(material)) { material.dispose(); disposedMaterials.add(material); }
      this.mats.delete(key);
    }
    for (const [key, animated] of this.animatedMats) if (key.toLowerCase().startsWith(prefix)) {
      if (!disposedMaterials.has(animated.material)) { animated.material.dispose(); disposedMaterials.add(animated.material); }
      if (!disposedTextures.has(animated.texture)) { animated.texture.dispose(); disposedTextures.add(animated.texture); }
      this.previewMats.delete(animated);
      this.animatedMats.delete(key);
    }
  }

  /** Advance recovered UV and flipbook timing. Long inactive-tab deltas are capped to avoid a visible jump.
   *  A one-shot flip runs its lifetime out whatever the Effects toggle says: a graph built that node, and
   *  freezing it would strand the material on the pulsed frame. */
  stepWorldEffects(dt: number) {
    if (dt <= 0) return;
    const step = Math.min(dt, 0.1);
    const wrap = (value: number) => ((value % 1) + 1) % 1;
    for (const animated of this.animatedMats.values()) {
      const running = this.worldEffectsEnabled || this.previewMats.has(animated);
      const uv = animated.effect.uvScroll;
      if (running && uv && animated.uv) {
        const [du, dv] = stepUvScrollPlayback(animated.uv, uv, step);
        animated.u = wrap(animated.u + du);
        animated.v = wrap(animated.v + dv);
        animated.texture.offset.set(animated.u, animated.v);
      }
      const flipEffect = animated.effect.textureFlip;
      if (flipEffect && animated.flip && (running || animated.flip.life > 0)
        && stepTextureFlipPlayback(animated.flip, flipEffect, animated.frameTextures.length, step)) {
        setAnimatedMaterialFrame(animated, animated.flip.frame);
      }
    }
  }
}
