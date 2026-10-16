import * as THREE from 'three';
import type { MapDataSource } from '../../shared/map-data';
import { readModelGeometries } from '../../shared/map-props';
import type { Viewport } from '../viewport/viewport';

/** Native exports the backdrop as ordinary models. Draw those local meshes around the camera. */
export async function installLocalSky(viewport: Viewport, source: MapDataSource, course: string,
  fileUrl: (path: string) => string): Promise<void> {
  const prefix = `${course}/Skybox/`;
  const models = await source.readJsonOr<{ Models?: unknown[] }>(`${prefix}Models.json`, {});
  if (!models.Models?.length) return;
  const skyLevel = 'LocalSky';
  const skySource: MapDataSource = {
    ...source,
    readJsonOr: (path, fallback) => source.readJsonOr(path.replace(`${skyLevel}/`, prefix), fallback),
    readTextOrNull: path => source.readTextOrNull(path.replace(`${skyLevel}/`, prefix)),
  };
  const geometries = await readModelGeometries(skySource, skyLevel, new Set(models.Models.map((_, index) => index)));
  const materials = await source.readJsonOr<{ Materials?: { TexturePath?: string }[] }>(`${prefix}Materials.json`, {});
  const group = new THREE.Group(), loader = new THREE.TextureLoader();
  let top = -Infinity;
  for (const model of geometries.values()) for (const sub of model.subs)
    for (let i = 2; i < sub.positions.length; i += 3) top = Math.max(top, sub.positions[i]);
  const topEdges = new Map<string, { texture: THREE.Texture; v: number }>();
  for (const model of geometries.values()) for (const sub of model.subs) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(sub.positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = -sub.positions[i] / 100; positions[i + 1] = sub.positions[i + 2] / 100; positions[i + 2] = sub.positions[i + 1] / 100;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(sub.uvs, 2)); geometry.setIndex(sub.indices);
    const name = materials.Materials?.[sub.mat]?.TexturePath;
    const texture = name ? await loader.loadAsync(fileUrl(`${prefix}Textures/${name}`)) : null;
    // These are separate sky tiles, so filtering must never sample the opposite edge of a tile.
    if (texture) { texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping; }
    if (texture && name) for (let i = 2; i < sub.positions.length; i += 3) {
      if (Math.abs(sub.positions[i] - top) > 0.001) continue;
      topEdges.set(name, { texture, v: sub.uvs[(i - 2) / 3 * 2 + 1] });
      break;
    }
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false }));
    mesh.renderOrder = -10_000; mesh.frustumCulled = false; group.add(mesh);
  }
  // The native backdrop is an open ring. Match its upper edge when clearing the uncovered zenith.
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })!;
  const total = [0, 0, 0]; let weight = 0;
  for (const { texture, v } of topEdges.values()) {
    const image = texture.image as HTMLImageElement;
    canvas.width = image.naturalWidth; canvas.height = 1;
    const row = Math.round(Math.max(0, Math.min(1, texture.flipY ? 1 - v : v)) * (image.naturalHeight - 1));
    context.drawImage(image, 0, row, image.naturalWidth, 1, 0, 0, canvas.width, 1);
    const pixels = context.getImageData(0, 0, canvas.width, 1).data;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3] / 255; weight += alpha;
      for (let c = 0; c < 3; c++) total[c] += pixels[i + c] * alpha;
    }
  }
  if (weight > 0) viewport.scene.background = new THREE.Color().setRGB(
    total[0] / weight / 255, total[1] / weight / 255, total[2] / weight / 255, THREE.SRGBColorSpace);
  viewport.scene.add(group);
  const old = viewport.scene.onBeforeRender;
  viewport.scene.onBeforeRender = function (...args) {
    old.apply(this, args);
    args[2].getWorldPosition(group.position); group.updateMatrixWorld(true);
  };
}
