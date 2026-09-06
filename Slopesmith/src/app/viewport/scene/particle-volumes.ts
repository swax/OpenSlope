import * as THREE from 'three';
import type { ParticleVolume } from '../../../core/particles/volumes';
import { particleRawFromEditor } from '../../../core/particles/volumes';
import { RAW_TO_EDITOR } from '../constants';
import type { Stage } from '../stage';
import { createParticleBatches, type ParticleBatches } from './particle-batches';

const PUFF_DRAW_DIAMETER = 4; // visible fog0 content fills ~half the quad; native-looking draw is 2r half-width

/** How a fog puff composites, in one place so a measurement of it cannot drift from what ships.
 *
 * These numbers are an AUTHORED GUESS at the PS2 look, not a port of anything measured — the same guess
 * Unity's `OpenSlope/Particle` carries (`_Tint` #b8c7db, `_Alpha` 0.5), which is why the two agree with each other
 * and neither is evidence. `tools/reference-study/fog-opacity.ts` measures what they actually produce, so
 * that the PS2 reading has something to be compared against. */
export const FOG_PUFF_COMPOSITE = {
  color: 0xb8c7d9,
  opacity: 0.48,
  blending: THREE.NormalBlending,
} as const;

interface VolumeDraw {
  volume: ParticleVolume;
  hit: THREE.Mesh;
}

interface FogPuffDraw { x: number; y: number; z: number; size: number }

/** Standalone PBD fog-bank renderer. These are static puff clusters, not SSF timer emitters: World Effects
 * controls their billboards, while Effects mode independently exposes their purple volume bounds for picking. */
export function createParticleVolumesLayer(stage: Stage) {
  const authoredVisuals = new THREE.Group(); authoredVisuals.name = 'Authored ambient particles';
  const referenceVisuals = new THREE.Group(); referenceVisuals.name = 'Reference ambient particles';
  const authoredBounds = new THREE.Group(); authoredBounds.name = 'Authored ambient particle bounds';
  const referenceBounds = new THREE.Group(); referenceBounds.name = 'Reference ambient particle bounds';
  stage.worldRoot.add(authoredVisuals, authoredBounds);
  stage.refRoot.add(referenceVisuals, referenceBounds);

  const texture = new THREE.TextureLoader().load('/api/particle-texture?name=fog0.png', loaded => {
    loaded.colorSpace = THREE.SRGBColorSpace;
    loaded.needsUpdate = true;
  });
  const authoredDraws = new Map<string, VolumeDraw>();
  const referenceDraws = new Map<number, VolumeDraw>();
  let authoredBatch: ParticleBatches | null = null;
  let referenceBatch: ParticleBatches | null = null;
  let worldEffectsEnabled = false;
  let inspecting = false;
  let selectedAuthored: string | null = null;
  let selectedReference: number | null = null;

  const raw = new THREE.Matrix4(), edit = new THREE.Matrix4();
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3();
  const drawingBufferSize = new THREE.Vector2();
  const fogColor = new THREE.Color(FOG_PUFF_COMPOSITE.color);

  function volumeMatrix(volume: ParticleVolume): THREE.Matrix4 {
    const loc = particleRawFromEditor(volume.pos);
    raw.compose(pos.set(loc[0], loc[1], loc[2]),
      q.set(...volume.nativeRotation), scale.set(...volume.scale));
    return edit.multiplyMatrices(RAW_TO_EDITOR, raw);
  }

  function build(volume: ParticleVolume, source: 'authored' | 'reference', index: number,
    puffs: FogPuffDraw[]): VolumeDraw {
    const matrix = volumeMatrix(volume).clone();
    const box = new THREE.Box3();
    const radiusScale = Math.max(Math.abs(volume.scale[0]), Math.abs(volume.scale[1]), Math.abs(volume.scale[2]));
    for (const object of volume.objects) for (const puff of object.puffs) {
      const center = new THREE.Vector3(...puff.position).applyMatrix4(matrix);
      const puffScale = Math.max(Math.abs(puff.scale[0]), Math.abs(puff.scale[1]), Math.abs(puff.scale[2]));
      const radius = Math.max(0.01, puff.radius * puffScale * radiusScale / 100);
      puffs.push({ x: center.x, y: center.y, z: center.z, size: radius * PUFF_DRAW_DIAMETER });
      box.expandByPoint(center.clone().addScalar(radius));
      box.expandByPoint(center.clone().addScalar(-radius));
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(...volume.pos), new THREE.Vector3(2, 2, 2));
    const size = box.getSize(new THREE.Vector3()).max(new THREE.Vector3(1, 1, 1));
    const center = box.getCenter(new THREE.Vector3());
    const material = new THREE.MeshBasicMaterial({
      color: 0xb66cff, wireframe: true, transparent: true, opacity: 0.24,
      depthWrite: false, depthTest: true,
    });
    const hit = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
    hit.position.copy(center);
    hit.name = volume.name;
    hit.userData.particleVolumeSource = source;
    hit.userData.particleVolumeIndex = index;
    hit.userData.particleVolumeId = volume.id;
    return { volume, hit };
  }

  function disposeBounds(group: THREE.Group, draws: Iterable<VolumeDraw>) {
    for (const draw of draws) {
      draw.hit.geometry.dispose();
      (draw.hit.material as THREE.Material).dispose();
    }
    group.clear();
  }

  /** One static point-sprite draw replaces one Three Sprite draw per puff. Positions already include the native
   * volume transform; the parent group supplies only authored/reference chirality and comparison placement. */
  function buildBatch(group: THREE.Group, source: 'authored' | 'reference', puffs: readonly FogPuffDraw[],
    previous: ParticleBatches | null): ParticleBatches | null {
    previous?.dispose();
    group.clear();
    if (!puffs.length) return null;
    const batch = createParticleBatches(texture, 1, 1, puffs.length);
    const { position, color, alpha, size, sprite } = batch.buffers;
    for (let i = 0; i < puffs.length; i++) {
      const puff = puffs[i], k = i * 3;
      position[k] = puff.x; position[k + 1] = puff.y; position[k + 2] = puff.z;
      color[k] = fogColor.r; color[k + 1] = fogColor.g; color[k + 2] = fogColor.b;
      alpha[i] = FOG_PUFF_COMPOSITE.opacity;
      size[i] = puff.size;
      sprite[i] = 0;
    }
    batch.setDrawRanges(0, puffs.length);
    batch.alphaPoints.name = `${source === 'reference' ? 'Reference' : 'Authored'} ambient particle batch`;
    batch.alphaPoints.userData.particleVolumeVisualSource = source;
    // The batch's aggregate sphere still rejects a wholly off-screen fog field. Individual off-screen points are
    // cheap vertex work and preferable to restoring dozens of CPU-side draw objects merely for fine culling.
    batch.alphaPoints.geometry.computeBoundingSphere();
    batch.alphaPoints.frustumCulled = true;
    group.add(batch.alphaPoints);
    return batch;
  }

  function setAuthored(volumes: readonly ParticleVolume[]) {
    disposeBounds(authoredBounds, authoredDraws.values()); authoredDraws.clear();
    const puffs: FogPuffDraw[] = [];
    volumes.forEach((volume, index) => {
      const draw = build(volume, 'authored', index, puffs);
      authoredDraws.set(volume.id, draw); authoredBounds.add(draw.hit);
    });
    authoredBatch = buildBatch(authoredVisuals, 'authored', puffs, authoredBatch);
    applyVisibility(); applySelection();
  }

  function setReference(volumes: readonly ParticleVolume[]) {
    disposeBounds(referenceBounds, referenceDraws.values()); referenceDraws.clear();
    const puffs: FogPuffDraw[] = [];
    volumes.forEach((volume, index) => {
      const draw = build(volume, 'reference', index, puffs);
      referenceDraws.set(index, draw); referenceBounds.add(draw.hit);
    });
    referenceBatch = buildBatch(referenceVisuals, 'reference', puffs, referenceBatch);
    applyVisibility(); applySelection();
  }

  /** Point size is derived in the vertex shader from the live eye-buffer height, matching a world-space Sprite. */
  function sync() {
    stage.renderer.getDrawingBufferSize(drawingBufferSize);
    const halfHeight = Math.max(1, drawingBufferSize.y * 0.5);
    if (authoredBatch) authoredBatch.uniforms.halfViewportHeight.value = halfHeight;
    if (referenceBatch) referenceBatch.uniforms.halfViewportHeight.value = halfHeight;
  }

  function applyVisibility() {
    authoredVisuals.visible = worldEffectsEnabled;
    referenceVisuals.visible = worldEffectsEnabled;
    authoredBounds.visible = inspecting;
    referenceBounds.visible = inspecting;
  }

  function applySelection() {
    for (const [id, draw] of authoredDraws) {
      const on = selectedReference === null && id === selectedAuthored;
      const material = draw.hit.material as THREE.MeshBasicMaterial;
      material.opacity = on ? 0.9 : 0.24;
      material.depthTest = !on;
      draw.hit.renderOrder = on ? 14 : 0;
    }
    for (const [index, draw] of referenceDraws) {
      const on = selectedAuthored === null && index === selectedReference;
      const material = draw.hit.material as THREE.MeshBasicMaterial;
      material.opacity = on ? 0.9 : 0.24;
      material.depthTest = !on;
      draw.hit.renderOrder = on ? 14 : 0;
    }
  }

  function setInspecting(on: boolean) { inspecting = on; applyVisibility(); }
  function setWorldEffectsEnabled(on: boolean) { worldEffectsEnabled = on; applyVisibility(); }
  function selectAuthored(id: string | null) { selectedAuthored = id; if (id !== null) selectedReference = null; applySelection(); }
  function selectReference(index: number | null) { selectedReference = index; if (index !== null) selectedAuthored = null; applySelection(); }

  function focus(source: 'authored' | 'reference', key: string | number): THREE.Sphere | null {
    const draw = source === 'authored' ? authoredDraws.get(String(key)) : referenceDraws.get(Number(key));
    if (!draw) return null;
    draw.hit.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(draw.hit);
    return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
  }

  return {
    authoredBounds, referenceBounds,
    setAuthored, setReference, setInspecting, setWorldEffectsEnabled, sync,
    selectAuthored, selectReference, focus,
  };
}

export type ParticleVolumesLayer = ReturnType<typeof createParticleVolumesLayer>;
