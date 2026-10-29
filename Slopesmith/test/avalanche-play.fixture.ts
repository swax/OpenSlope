import * as THREE from 'three';
import {
  buildReferenceMesh,
  insetReferenceUnitTile,
  reconstructPathLine,
  type RawPatch,
  type CoursePathFile,
} from '../src/core/reference/terrain';
import { createRideModel } from '../src/app/ride/physics';
import { referencePatchContact } from '../src/app/ride/patch-contact';
import { lightPublicReference } from '../src/app/public/lighting';
import { localMapData } from '../src/app/public/local-map-data';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { decodeProps, type LevelProps } from '../src/core/reference/props';
import { readNativeSky } from '../src/shared/map-sky';
import { readLevelPatches } from '../src/shared/map-levels';
import { createRangeCull } from '../src/app/viewport/scene/range-cull';
import { RAW_TO_EDITOR } from '../src/app/viewport/constants';
import { resolvePropDefaults } from '../src/core/props/defaults';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createPropsLayer } from '../src/app/viewport/scene/props';
import { decodeMusicLink, type ReferenceMusicGraph, type ReferenceMusicIndex } from '../src/core/reference/music';
import { resolveMusicSampleNode } from '../src/app/audio/ride-music';

/** The actual public player's cache adapter, graph walk and browser WAV decoder. */
export async function verifyAvalancheMusic(course: string, count: number) {
  const data = await localMapData([course]);
  try {
    const index = (await (
      await fetch(data.resolveAsset(`/api/reference-music?level=${course}`))
    ).json()) as ReferenceMusicIndex;
    if (index.songs.length !== count) throw new Error('Public player lost soundtrack choices');
    const song = index.songs[0];
    const graph = (await (
      await fetch(data.resolveAsset(`/api/reference-music?level=${course}&song=${song.id}`))
    ).json()) as ReferenceMusicGraph;
    if (resolveMusicSampleNode(graph, 0, 80) !== 1 || decodeMusicLink(graph.Nodes.at(-1)!.LinkRaw[0]).target !== 1)
      throw new Error('Soundtrack graph must enter its first chunk and loop after the last');
    const url = data.resolveAsset(`/api/reference-music-sample?level=${course}&song=${song.id}&sample=1`);
    const context = new OfflineAudioContext(2, 48000, 48000);
    const decoded = await context.decodeAudioData(await (await fetch(url)).arrayBuffer());
    if (decoded.sampleRate !== 48000 || decoded.numberOfChannels !== 2 || decoded.length !== graph.Samples[0].Samples)
      throw new Error('Browser music decoder changed the imported stereo frame layout');
    if (!decoded.getChannelData(0).some(value => value !== 0)) throw new Error('Decoded soundtrack is silent');
    return { musicSongs: count, musicFrames: decoded.length };
  } finally {
    data.dispose();
  }
}

/** Verify the geometry/UV corner contract in the mesh actually supplied to WebGL. */
export function verifyAvalancheTerrainUV(patches: RawPatch[]) {
  const mesh = buildReferenceMesh(patches, undefined, 1);
  for (let pi = 0; pi < patches.length; pi++) {
    const uv = patches[pi].UVPoints;
    if (!uv?.length) throw new Error(`Missing source terrain UVs on patch ${pi}`);
    const expected = insetReferenceUnitTile(
      [uv[0], uv[2], uv[1], uv[3]].map(p => [p[0], p[1]]) as [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ],
    );
    for (let corner = 0; corner < 4; corner++)
      for (let axis = 0; axis < 2; axis++)
        if (
          Math.abs(mesh.uvs[(pi * 4 + corner) * 2 + axis] - expected[corner][axis]) >
          2e-6 + Math.abs(expected[corner][axis]) * 1e-7
        )
          throw new Error(`Browser changed the source texture orientation on patch ${pi}`);
  }
  return patches.length;
}

/** Large source chunks and individual props must survive Play's per-slot distance gate. */
export function verifyAvalancheSceneryProps(props: LevelProps, paths: CoursePathFile) {
  const path = paths.AIPaths?.[paths.StartPosList?.[0] ?? -1];
  if (!path) throw new Error('Missing scenery check start');
  const spawn = new THREE.Vector3(...reconstructPathLine(path)[0]);
  const scene = new THREE.Scene(),
    batches: THREE.BatchedMesh[] = [],
    geometries: THREE.BufferGeometry[] = [];
  const material = new THREE.MeshBasicMaterial();
  try {
    for (const instance of props.instances.filter(instance => instance.visible)) {
      const model = props.models.find(model => model.id === instance.model);
      for (const sub of model?.subs ?? []) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(sub.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(sub.indices, 1));
        geometries.push(geometry);
        const batch = new THREE.BatchedMesh(1, sub.positions.length / 3, sub.indices.length, material);
        const id = batch.addInstance(batch.addGeometry(geometry));
        const pose = new THREE.Matrix4().compose(
          new THREE.Vector3(...instance.loc),
          new THREE.Quaternion(...instance.rot),
          new THREE.Vector3(...instance.scale),
        );
        batch.setMatrixAt(id, new THREE.Matrix4().multiplyMatrices(RAW_TO_EDITOR, pose));
        scene.add(batch);
        batches.push(batch);
      }
    }
    scene.updateMatrixWorld(true);
    const cull = createRangeCull({ scene, chunks: () => [], propMeshes: () => batches, fogColor: () => null });
    cull.setRange(600);
    cull.update(spawn);
    const stats = cull.stats();
    if (!stats.slotsDrawn) throw new Error('Play distance culling discarded all source scenery near the rider');
    return { slots: stats.slots, drawn: stats.slotsDrawn };
  } finally {
    batches.forEach(batch => batch.dispose());
    geometries.forEach(geometry => geometry.dispose());
    material.dispose();
  }
}

export async function verifyAvalancheEnvironment(level: string) {
  const local = await localMapData([level]);
  try {
    const sky = await readNativeSky(local.source, level, local.fileUrl);
    if (!sky?.parts.length) throw new Error('Missing source background');
    let skyTriangles = 0;
    for (const part of sky.parts) {
      if (!part.texture || !part.positions.every(Number.isFinite)) throw new Error('Invalid background geometry');
      const response = await fetch(part.texture);
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/'))
        throw new Error('Missing background art');
      skyTriangles += part.indices.length / 3;
    }
    for (const name of ['spry.png', 'ex06.png', 'ex09.png']) {
      const url = local.resolveAsset(`/api/particle-texture?level=${level}&name=${name}`);
      if (!url.startsWith('blob:')) throw new Error(`Source spray did not resolve: ${name}`);
      const image = await createImageBitmap(await (await fetch(url)).blob());
      if (!image.width) throw new Error('Invalid spray image');
      image.close();
    }
    return { skyTriangles };
  } finally {
    local.dispose();
  }
}

/** Hidden geometry must survive the same local adapter and payload decoder used by public Play. */
export async function verifyAvalancheCollision(level: string) {
  const local = await localMapData([level]);
  try {
    const props = decodeProps(await buildLevelPropsUncached(local.source, level));
    for (const model of props.models) {
      const collision = model.defaults?.nativeCollision;
      if (!collision) throw new Error('Separated source model lost its placement defaults');
      if (
        collision.mode === 1 &&
        (!model.collision?.indices.length || !model.collision.positions.every(Number.isFinite))
      )
        throw new Error('Solid authored copy lost its independent collision hull');
      if (collision.mode === 0 && model.collision) throw new Error('Decorative source model acquired a collider');
    }
    const donor = props.models.find(model => model.collision && /birch|cedar|tree/i.test(model.name));
    if (donor) {
      const assets = createPropAssets();
      assets.registerPropModels({ ...props, models: [donor], materials: new Map() });
      const stage = {
        scene: new THREE.Scene(),
        worldRoot: new THREE.Group(),
        cb: {},
        gizmo: { dragging: false },
        gizmoKind: null,
        attachGizmo() {},
        detachGizmo() {},
      };
      const layer = createPropsLayer(stage as never, assets, {
        authoredRigData: null,
        authoredLightsVisible: false,
        authoredLights: [],
      } as never);
      const copy = {
        id: 'avalanche-tree-copy',
        level,
        model: donor.id,
        name: donor.name,
        pos: [7, 11, 13] as [number, number, number],
        yaw: 37,
        scale: 0.8,
        ...resolvePropDefaults(level, donor.id, props).behaviour,
      };
      layer.setPlacedProps([copy], null);
      const colliders = layer.rideColliders();
      if (colliders.length !== 1 || colliders[0].geometry !== assets.propCollision.get(`${level}:${donor.id}`))
        throw new Error('Authored tree collides against its canopy instead of its trunk hull');
      const x = colliders[0].matrixWorld!.elements[12];
      layer.setPlacedProps([{ ...copy, pos: [17, 11, 13] }], null);
      if (Math.abs(layer.rideColliders()[0].matrixWorld!.elements[12] - x - 10) > 1e-6)
        throw new Error('Moving an authored tree left its hull at the old location');
      layer.setPlacedProps([], null);
      for (const sub of assets.propGeom.get(`${level}:${donor.id}`) ?? []) sub.geometry.dispose();
      assets.propCollision.get(`${level}:${donor.id}`)?.dispose();
    }
    const source = await local.source.readJsonOr<{
      Instances?: { Visable?: boolean; ModelID: number; Location: number[]; InstanceName: string }[];
    }>(`${level}/Instances.json`, {});
    const visible = (source.Instances ?? [])
      .map((instance, index) => ({ instance, index }))
      .filter(({ instance }) => instance.Visable !== false);
    if (props.instances.filter(instance => instance.visible).length !== visible.length)
      throw new Error('Browser merged or discarded source prop placements');
    for (const { instance, index } of visible) {
      const decoded = props.instances.find(prop => prop.sourceIndex === index);
      if (
        !decoded ||
        decoded.model !== instance.ModelID ||
        decoded.name !== instance.InstanceName ||
        decoded.loc.some((value, axis) => Math.abs(value - instance.Location[axis]) > 1e-5)
      )
        throw new Error(`Browser changed source prop placement ${index}`);
    }
    const paths = await local.source.readJsonOr<CoursePathFile>(`${level}/AIP.json`, {});
    verifyAvalancheSceneryProps(props, paths);
    const hidden = props.instances.filter(instance => !instance.visible && instance.contact === 'solid');
    if (!hidden.length) throw new Error('Missing hidden solid world collider');
    let triangles = 0;
    for (const instance of hidden) {
      if (!instance.collisionModels?.length) throw new Error('Missing collision proxy reference');
      for (const id of instance.collisionModels) {
        const mesh = props.collisionMeshes?.get(id);
        if (!mesh?.indices.length || !mesh.positions.every(Number.isFinite))
          throw new Error(`Missing or invalid collision geometry ${id}`);
        triangles += mesh.indices.length / 3;
      }
    }
    return triangles;
  } finally {
    local.dispose();
  }
}

/** Exercise the actual browser terrain/contact model against the imported map. */
export async function verifyAvalancheRide(level: string, patches: RawPatch[], paths: CoursePathFile) {
  const local = await localMapData([level]);
  const loaded = await readLevelPatches(local.source, level);
  if (
    loaded.patches.length !== patches.length ||
    loaded.patches.some((patch, index) => patch.LightmapEncoding !== patches[index].LightmapEncoding)
  )
    throw new Error('Public map reader lost imported lightmap encodings');
  const reference = buildReferenceMesh(loaded.patches);
  const lightmapPages = new Set<number>();
  try {
    await lightPublicReference(reference, loaded.patches, id => {
      lightmapPages.add(id);
      const url = local.resolveAsset(`/api/lightmap?level=${level}&id=${id}`);
      if (!url.startsWith('blob:')) throw new Error(`Missing baked lightmap ${id}`);
      return url;
    });
  } finally {
    local.dispose();
  }
  if (!lightmapPages.size || !reference.lightColor?.every(value => Number.isFinite(value) && value >= 0 && value < 2))
    throw new Error('Invalid course lighting');
  const skywardNormals = Array.from(reference.normals).filter((value, index) => index % 3 === 1 && value > 0).length;
  const skywardFraction = skywardNormals / (reference.normals.length / 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(reference.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(reference.indices, 1));
  const terrain = new THREE.Mesh(geometry);
  terrain.updateMatrixWorld(true);
  const path = paths.AIPaths?.[paths.StartPosList?.[0] ?? -1];
  if (!path) throw new Error('Missing Avalanche start path');
  const points = reconstructPathLine(path);
  if (points.length < 2) throw new Error('Avalanche start has no heading');
  const spawn = new THREE.Vector3(...points[0]);
  const heading = new THREE.Vector3(...points[1]).sub(spawn).normalize();
  const model = createRideModel({
    spawn,
    heading,
    terrain,
    patchContact: referencePatchContact(reference) ?? undefined,
    surfaceOf: face => reference.patchSurf[Math.floor(face / reference.facesPerPatch)] ?? 1,
    oobFloorY: -100,
    keys: { left: false, right: false, tuck: false, brake: false, boost: false },
    stick: { active: false, x: 0 },
    onRespawn: () => {},
  });
  model.start();
  let grounded = 0;
  for (let i = 0; i < 180; i++) {
    model.step(1 / 60);
    if (model.st.grounded) grounded++;
  }
  const travelled = model.st.pos.distanceTo(spawn);
  model.respawn();
  const restartDistance = model.st.pos.distanceTo(spawn);
  model.st.pos.y += 100;
  model.resetToCourse();
  for (let i = 0; i < 180; i++) model.step(1 / 60);
  const resetGrounded = model.st.grounded;
  geometry.dispose();
  return {
    grounded,
    travelled,
    resetGrounded,
    restartDistance,
    patches: patches.length,
    skywardFraction,
    lightmapPages: lightmapPages.size,
  };
}
