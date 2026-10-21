import * as THREE from 'three';
import type { RiderLight } from '../../core/lighting/rider-light';

export type RiderLightSource = (position: THREE.Vector3) => RiderLight | null;
export const RIDER_LIGHT_SOURCE = 'riderLightSource';
export const RIDER_LIGHT_ANCHOR = 'riderLightAnchor';

export function riderLightVertexShader(source: string): string {
  return source
    .replace(
      'void main() {',
      `uniform vec3 riderAmbient;
uniform vec3 riderKeyColors[12];
uniform vec3 riderKeyDirections[12];
varying vec3 riderIllumination;
void main() {`,
    )
    .replace(
      '#include <defaultnormal_vertex>',
      `#include <defaultnormal_vertex>
vec3 riderNormal = inverseTransformDirection(normalize(transformedNormal), viewMatrix);
riderIllumination = riderAmbient;
for(int i=0;i<12;i++) riderIllumination += max(0.0,dot(riderNormal,riderKeyDirections[i]))*riderKeyColors[i];
riderIllumination = clamp(riderIllumination,0.0,1.0);`,
    );
}

export function riderLightFragmentShader(source: string): string {
  return source
    .replace('void main() {', 'uniform float riderLightActive;\nvarying vec3 riderIllumination;\nvoid main() {')
    .replace(
      '#include <opaque_fragment>',
      `if(riderLightActive>0.5) {
  vec3 displayBase=sRGBTransferOETF(vec4(diffuseColor.rgb,1.0)).rgb;
  outgoingLight=sRGBTransferEOTF(vec4(displayBase*riderIllumination,1.0)).rgb+totalEmissiveRadiance;
}
#include <opaque_fragment>`,
    );
}

/** Each body owns its uniforms/materials; texture maps (including scrolling
 * emissive masks) remain shared. Update once per render, including stereo eyes. */
export function prepareRiderLighting(root: THREE.Object3D, owner: THREE.Object3D, cloneMaterials = false): () => void {
  const materials = new Map<THREE.Material, THREE.Material>();
  const colors = Array.from({ length: 12 }, () => new THREE.Vector3());
  const directions = Array.from({ length: 12 }, () => new THREE.Vector3());
  const uniforms = {
    riderLightActive: { value: 0 },
    riderAmbient: { value: new THREE.Vector3() },
    riderKeyColors: { value: colors },
    riderKeyDirections: { value: directions },
  };
  const position = new THREE.Vector3();
  let lastFrame = -1;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const originals = Array.isArray(object.material) ? object.material : [object.material];
    const next = originals.map(original => {
      if (!(
        original instanceof THREE.MeshLambertMaterial ||
        original instanceof THREE.MeshStandardMaterial ||
        original instanceof THREE.MeshPhongMaterial
      ))
        return original;
      let material = materials.get(original);
      if (material) return material;
      material = cloneMaterials ? original.clone() : original;
      const beforeCompile = original.onBeforeCompile;
      const cacheKey = original.customProgramCacheKey();
      material.onBeforeCompile = function (shader, renderer) {
        beforeCompile.call(this, shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = riderLightVertexShader(shader.vertexShader);
        shader.fragmentShader = riderLightFragmentShader(shader.fragmentShader);
      };
      material.customProgramCacheKey = () => `${cacheKey}:rider-light-v1`;
      material.needsUpdate = true;
      materials.set(original, material);
      return material;
    });
    object.material = Array.isArray(object.material) ? next : next[0];
    const beforeRender = object.onBeforeRender;
    object.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
      beforeRender.call(this, renderer, scene, camera, geometry, material, group);
      if (lastFrame === renderer.info.render.frame) return;
      lastFrame = renderer.info.render.frame;
      const source = scene.userData[RIDER_LIGHT_SOURCE] as RiderLightSource | undefined;
      const anchor = owner.userData[RIDER_LIGHT_ANCHOR] as THREE.Vector3 | undefined;
      if (anchor) owner.localToWorld(position.copy(anchor));
      else owner.getWorldPosition(position);
      const light = source?.(position);
      uniforms.riderLightActive.value = light ? 1 : 0;
      if (!light) return;
      uniforms.riderAmbient.value.fromArray(light.ambient);
      for (let i = 0; i < 12; i++) {
        colors[i].set(0, 0, 0);
        directions[i].set(0, 0, 0);
        const key = light.keys[i];
        if (key) {
          colors[i].fromArray(key.color);
          directions[i].fromArray(key.direction);
        }
      }
    };
  });
  return () => {
    if (cloneMaterials) for (const material of materials.values()) material.dispose();
  };
}
