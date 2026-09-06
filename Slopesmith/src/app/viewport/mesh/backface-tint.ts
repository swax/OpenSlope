import * as THREE from 'three';

/** The warning colour a back face tints toward — a saturated magenta nothing else in the viewport wears.
 *  Shared with the Surface view's prop clay (scene/prop-shade.ts) and the legend swatch, so the one hue
 *  that means "you are looking at this from behind its normal" cannot drift between the two surfaces. */
export const BACKFACE_TINT_RGB: readonly [number, number, number] = [0.92, 0.20, 0.74];
export const BACKFACE_TINT_GLSL = `vec3(${BACKFACE_TINT_RGB.join(', ')})`;
export const BACKFACE_TINT_CSS = `rgb(${BACKFACE_TINT_RGB.map(c => Math.round(c * 255)).join(',')})`;
/** Mix over TERRAIN, whose tile art has to stay readable underneath. */
export const BACKFACE_TINT_MIX = 0.15;
const BACKFACE_TINT = BACKFACE_TINT_GLSL;
const BACKFACE_MIX = BACKFACE_TINT_MIX.toFixed(2);
let backfaceTintVisible = true;
const tintedMaterials = new Set<THREE.Material>();

/** Show or hide the magenta normal-direction warning on every material decorated by tintBackfaces. */
export function setBackfaceTintVisible(on: boolean) {
  backfaceTintVisible = on;
  for (const material of tintedMaterials) {
    const uniform = material.userData.backfaceTintVisible as { value: number } | undefined;
    if (uniform) uniform.value = on ? 1 : 0;
  }
}

/**
 * Tint a material's back faces magenta — the face-orientation overlay for a one-sided world. The game's
 * contact acts along the patch's parametric normal treated as outward ([Trailmap: 320]), so a surface is
 * ridable from its front face only and the rider falls straight through the back; the tint makes that dead
 * side visible at a glance (a tube's exterior, an inside-out loft). Front/back here is the DOCUMENT winding,
 * not the on-screen one: the terrain materials are DoubleSide and the worldRoot mirror flips handedness, but
 * the renderer flips `frontFace` for a negative-determinant object, so `gl_FrontFacing` lands back on the
 * data-space winding — the same side `patchNormal` points out of and the export makes the engine's.
 * (That reading holds ONLY under an odd mirror count: prop placements compose worldRoot × RAW_TO_EDITOR —
 * net positive determinant, opposite reading — which is one reason models show orientation with selection
 * normal arrows instead, scene/props.ts.)
 *
 * The injection rides `onBeforeCompile`, after tone mapping so the warning reads the same under every shade
 * mode; the constant cache key keeps the tinted flavours of one material class sharing one program.
 */
export function tintBackfaces<T extends THREE.Material>(material: T): T {
  tintedMaterials.add(material);
  material.onBeforeCompile = shader => {
    const visibleUniform = { value: backfaceTintVisible ? 1 : 0 };
    shader.uniforms.backfaceTintVisible = visibleUniform;
    material.userData.backfaceTintVisible = visibleUniform;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
	if (backfaceTintVisible > 0.5 && !gl_FrontFacing) gl_FragColor.rgb = mix(gl_FragColor.rgb, ${BACKFACE_TINT}, ${BACKFACE_MIX});`,
    );
    shader.fragmentShader = `uniform float backfaceTintVisible;\n${shader.fragmentShader}`;
  };
  material.customProgramCacheKey = () => 'backface-tint';
  return material;
}
