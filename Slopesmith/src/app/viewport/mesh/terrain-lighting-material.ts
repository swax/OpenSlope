import type * as THREE from 'three';

const decorated = new WeakSet<THREE.Material>();

/** Authored terrain supplies light inputs; reference meshes retain their existing baked vertex colors. */
export function terrainPixelLighting<T extends THREE.MeshBasicMaterial>(
  material: T,
  { surfaceTint = true }: { surfaceTint?: boolean } = {},
): T {
  if (decorated.has(material)) return material;
  decorated.add(material);
  const defaults = material as T & { defaultAttributeValues: Record<string, number[]> };
  defaults.defaultAttributeValues = {
    terrainSun: [0, 0, 0],
    terrainSky: [0, 0, 0],
    terrainGlow: [0, 0, 0],
    terrainAlbedo: [1, 1, 1],
    terrainLightOptions: [0, 0, 0, 0],
  };
  const previous = material.onBeforeCompile,
    cacheKey = material.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    const varying = `
varying vec3 vTerrainNormal;
varying vec3 vTerrainSun;
varying vec3 vTerrainSky;
varying vec3 vTerrainGlow;
varying vec3 vTerrainAlbedo;
varying vec4 vTerrainLightOptions;
`;
    shader.vertexShader = `
attribute vec3 terrainSun;
attribute vec3 terrainSky;
attribute vec3 terrainGlow;
attribute vec3 terrainAlbedo;
attribute vec4 terrainLightOptions;
${varying}${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vTerrainNormal = normal;
vTerrainSun = terrainSun;
vTerrainSky = terrainSky;
vTerrainGlow = terrainGlow;
vTerrainAlbedo = terrainAlbedo;
vTerrainLightOptions = terrainLightOptions;`,
    );
    shader.fragmentShader = `${varying}
vec3 terrainWorkingLight(vec3 displayLight) {
  return mix(pow(displayLight * 0.9478672986 + 0.0521327014, vec3(2.4)),
    displayLight * 0.0773993808, lessThan(displayLight, vec3(0.04045)));
}
vec3 terrainBakedLight(vec3 light) {
  float alpha8 = floor(clamp(max(light.r, max(light.g, light.b)) * 255.0, 0.0, 255.0) + 0.5);
  if (alpha8 < 0.5) return vec3(0.0);
  float k = alpha8 / 128.0;
  vec3 residual = floor(clamp((0.5 - light / k) * 255.0, 0.0, 255.0) + 0.5);
  return clamp((0.5 - residual / 255.0) * k, 0.0, 1.0);
}
${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      `
if (vTerrainLightOptions.w > 0.5) {
  float diffuse = max(0.0, dot(normalize(vTerrainNormal), vTerrainLightOptions.xyz));
  vec3 light = clamp(vTerrainSky + vTerrainSun * diffuse, 0.0, 1.0);
  light = 1.0 - (1.0 - light) * exp(-vTerrainGlow);
  if (vTerrainLightOptions.w > 1.5) light = terrainBakedLight(light);
  diffuseColor.rgb *= ${surfaceTint ? 'vTerrainAlbedo * ' : ''}terrainWorkingLight(light);
} else {
  #include <color_fragment>
}`,
    );
  };
  material.customProgramCacheKey = () => cacheKey + ':terrain-pixel-lighting-v2:' + surfaceTint;
  return material;
}
