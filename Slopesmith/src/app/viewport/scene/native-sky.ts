import * as THREE from 'three';
import type { NativeSkyPayload } from '../../../shared/map-sky';

/** Original imported dome, sharing the editor and Play camera/visibility lifecycle. */
export async function createNativeSkyBackdrop(payload: NativeSkyPayload, loader: THREE.TextureLoader) {
  const group = new THREE.Group();
  group.renderOrder = -10_000;
  const urls = [...new Set(payload.parts.flatMap(part => (part.texture ? [part.texture] : [])))];
  const results = await Promise.allSettled(urls.map(url => loader.loadAsync(url)));
  const textures = new Map<string, THREE.Texture>();
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') textures.set(urls[index], result.value);
  });
  if (results.some(result => result.status === 'rejected')) {
    textures.forEach(texture => texture.dispose());
    throw new Error(`Sky textures could not be loaded for ${payload.level}`);
  }
  textures.forEach(texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  });
  const repeats = new Map<string, THREE.Texture>();
  for (const part of payload.parts) {
    if (!part.repeatTexture || !part.texture || repeats.has(part.texture)) continue;
    const texture = textures.get(part.texture)!.clone();
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    repeats.set(part.texture, texture);
  }
  let top = -Infinity;
  for (const part of payload.parts)
    for (let i = 2; i < part.positions.length; i += 3) top = Math.max(top, part.positions[i]);
  const topEdges = new Map<string, { texture: THREE.Texture; v: number }>();
  for (const part of payload.parts) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(part.positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = -part.positions[i] / 100;
      positions[i + 1] = part.positions[i + 2] / 100;
      positions[i + 2] = part.positions[i + 1] / 100;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(part.uvs, 2));
    geometry.setIndex(part.indices);
    const texture = part.texture ? (part.repeatTexture ? repeats : textures).get(part.texture)! : null;
    if (texture && part.texture)
      for (let i = 2; i < part.positions.length; i += 3) {
        if (Math.abs(part.positions[i] - top) > 0.001) continue;
        topEdges.set(part.texture, { texture, v: part.uvs[((i - 2) / 3) * 2 + 1] });
        break;
      }
    // [Trailmap: 529] Every sky tile must precede the world. transparent=true would move alpha tiles
    // after opaque terrain/riders despite renderOrder. Custom blending keeps their alpha on the GPU
    // while leaving them in the early queue; NormalBlending with transparent=false discards that alpha.
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        alphaTest: part.alphaMode === 'cutout' ? 0.5 : 0,
        blending:
          part.alphaMode === 'glow'
            ? THREE.AdditiveBlending
            : part.alphaMode === 'blend'
              ? THREE.CustomBlending
              : THREE.NormalBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    mesh.renderOrder = -10_000;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  const canvas = document.createElement('canvas'),
    context = canvas.getContext('2d', { willReadFrequently: true })!;
  const total = [0, 0, 0];
  let weight = 0;
  for (const { texture, v } of topEdges.values()) {
    const image = texture.image as HTMLImageElement;
    canvas.width = image.naturalWidth;
    canvas.height = 1;
    const row = Math.round(Math.max(0, Math.min(1, texture.flipY ? 1 - v : v)) * (image.naturalHeight - 1));
    context.drawImage(image, 0, row, image.naturalWidth, 1, 0, 0, canvas.width, 1);
    const pixels = context.getImageData(0, 0, canvas.width, 1).data;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3] / 255;
      weight += alpha;
      for (let c = 0; c < 3; c++) total[c] += pixels[i + c] * alpha;
    }
  }
  const topColor =
    weight > 0
      ? new THREE.Color().setRGB(
          total[0] / weight / 255,
          total[1] / weight / 255,
          total[2] / weight / 255,
          THREE.SRGBColorSpace,
        )
      : new THREE.Color('#35507a');
  return {
    group,
    topColor,
    dispose() {
      group.removeFromParent();
      for (const mesh of group.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      textures.forEach(texture => texture.dispose());
      repeats.forEach(texture => texture.dispose());
    },
  };
}
