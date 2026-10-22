import * as THREE from 'three';
import { installLocalSky } from '../src/app/public/sky';
import { createSky } from '../src/app/viewport/scene/sky';
import type { Stage } from '../src/app/viewport/stage';
import {
  cacheTransaction,
  cachedIsoCourses,
  needsCollisionSoundUpdate,
  openIsoCache,
  readCachedCourse,
  unloadIsoCourse,
  isoCourseCacheVersion,
  updateCachedCollisionSounds,
  ISO_CACHE_VERSION,
} from '../src/app/public/iso-cache';
import { registerCollisionSoundIndex, resolveCollisionSound } from '../src/core/effects/collision-sound';
import type { CollisionSoundIndex } from '../src/core/effects/collision-sound';
import type { MapDataSource } from '../src/shared/map-data';
import type { Viewport } from '../src/app/viewport/viewport';

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function run() {
  const db = await openIsoCache();
  try {
    const index = {
      Schema: 'openslope-sound-index/v1',
      Level: 'FIXTURE',
      Banks: { 2: 'course', 3: 'crowd' },
      CollisionEvents: {},
      ResolverState: 'Deferred',
    };
    await cacheTransaction(db, 'files', 'readwrite', store => {
      store.put({
        key: 'FIXTURE/audio/soundindex.json',
        course: 'FIXTURE',
        path: 'Audio/SoundIndex.json',
        blob: new Blob([JSON.stringify(index)]),
      });
      store.put({
        key: 'FIXTURE/audio/sfx/course/007.wav',
        course: 'FIXTURE',
        path: 'Audio/SFX/course/007.wav',
        blob: new Blob(['keep this audio']),
      });
    });
    await cacheTransaction(db, 'courses', 'readwrite', store =>
      store.put({ course: 'FIXTURE', version: ISO_CACHE_VERSION, files: 2 }),
    );
    const deferredCourses = ['SSX_SNOW', 'SSX3_A', 'SSXOT_WR2_DAY'];
    await cacheTransaction(db, 'files', 'readwrite', store => {
      for (const course of deferredCourses)
        store.put({
          key: `${course}/audio/soundindex.json`,
          course,
          path: 'Audio/SoundIndex.json',
          blob: new Blob([JSON.stringify({ ...index, Level: course })]),
        });
    });
    for (const course of deferredCourses) {
      check(!(await needsCollisionSoundUpdate([course])), `${course} cannot be repaired by reselecting its ISO`);
    }
    check(await needsCollisionSoundUpdate(['FIXTURE']), 'Old cache must request its missing resolver');
    check(await needsCollisionSoundUpdate([...deferredCourses, 'FIXTURE']), 'Mixed caches must still repair Tricky');
    await updateCachedCollisionSounds(db, ['FIXTURE', 'UNCACHED', ...deferredCourses], {
      SourceExecutable: 'authored.elf',
      CollisionEvents: {
        2: { Group: 2, Slot: 7 },
        3: { Group: 3, Slot: 4 },
        4: { Group: 5, Slot: 8 },
      },
    });
    for (const course of deferredCourses) {
      const deferred = (await readCachedCourse(course)).get('audio/soundindex.json')!;
      check(
        (await deferred.text()) === JSON.stringify({ ...index, Level: course }),
        'Repair must preserve deferred titles',
      );
    }
    check(!(await needsCollisionSoundUpdate(['FIXTURE'])), 'Lookup repair must make the cache playable again');
    const files = await readCachedCourse('FIXTURE');
    check(
      (await files.get('audio/sfx/course/007.wav')!.text()) === 'keep this audio',
      'Repair must preserve cached audio',
    );
    check(
      (await cachedIsoCourses()).join() === 'FIXTURE',
      'Repair must preserve completion markers without adding courses',
    );
    const repaired = JSON.parse(await files.get('audio/soundindex.json')!.text()) as CollisionSoundIndex;
    registerCollisionSoundIndex(repaired);
    check(
      resolveCollisionSound(2, 'FIXTURE')?.slot === 7 && resolveCollisionSound(3, 'FIXTURE')?.bank === 'crowd',
      'Repaired metadata must reach the collision audio resolver',
    );
    check(!repaired.CollisionEvents['4'], 'Groups without a course bank cannot acquire a made-up route');
    await updateCachedCollisionSounds(db, ['FIXTURE'], { SourceExecutable: 'other.elf', CollisionEvents: {} });
    check(
      (await readCachedCourse('FIXTURE')).get('audio/soundindex.json')!.size ===
        files.get('audio/soundindex.json')!.size,
      'Choosing another disc must preserve an already resolved cache',
    );
    await cacheTransaction(db, 'files', 'readwrite', store =>
      store.put({ key: 'OTHER/patches.json', course: 'OTHER', path: 'Patches.json', blob: new Blob(['other course']) }),
    );
    await cacheTransaction(db, 'courses', 'readwrite', store =>
      store.put({ course: 'OTHER', version: ISO_CACHE_VERSION, files: 1 }),
    );
    await unloadIsoCourse('FIXTURE');
    check(
      (await cachedIsoCourses()).join() === 'OTHER' && (await readCachedCourse('FIXTURE')).size === 0,
      'Unloading removes every file and the completion marker for only the selected course',
    );
    check(
      (await (await readCachedCourse('OTHER')).get('patches.json')!.text()) === 'other course',
      'Other courses retain their original bytes',
    );
    await cacheTransaction(db, 'files', 'readwrite', store =>
      store.put({
        key: 'FIXTURE/patches.json',
        course: 'FIXTURE',
        path: 'Patches.json',
        blob: new Blob(['fresh extraction']),
      }),
    );
    await cacheTransaction(db, 'courses', 'readwrite', store =>
      store.put({ course: 'FIXTURE', version: ISO_CACHE_VERSION, files: 1 }),
    );
    const fresh = await readCachedCourse('FIXTURE');
    check(
      fresh.size === 1 && (await fresh.get('patches.json')!.text()) === 'fresh extraction',
      'Reloading an unloaded course has fresh files with no stale audio left over',
    );
    for (const course of ['SSX_ALOHA', 'SSX3_A', 'SSXOT_WR2_DAY']) {
      await cacheTransaction(db, 'courses', 'readwrite', store => store.put({ course, version: 1, files: 1 }));
      check(!(await cachedIsoCourses()).includes(course), 'Corrupted streamed imports must request a reload');
      await cacheTransaction(db, 'courses', 'readwrite', store =>
        store.put({ course, version: isoCourseCacheVersion(course), files: 1 }),
      );
      check((await cachedIsoCourses()).includes(course), 'Repaired streamed imports must stay loaded');
    }
    check((await cachedIsoCourses()).includes('FIXTURE'), 'The streamed format upgrade must preserve Tricky caches');
  } finally {
    db.close();
  }

  const documents: Record<string, unknown> = {
    'FIXTURE/Skybox/Models.json': {
      Models: [
        {
          ModelObjects: [
            {
              MeshData: [
                { MeshPath: 'left.obj', MaterialID: 0 },
                { MeshPath: 'right.obj', MaterialID: 1 },
              ],
            },
          ],
        },
      ],
    },
    'FIXTURE/Skybox/Materials.json': { Materials: [{ TexturePath: 'left.png' }, { TexturePath: 'right.png' }] },
  };
  const quad = (left: number, right: number) =>
    `v ${-left * 100} -200 -100\nv ${-right * 100} -200 -100\nv ${-right * 100} -200 100\nv ${-left * 100} -200 100\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3\nf 1/1 3/3 4/4\n`;
  const meshes: Record<string, string> = {
    'FIXTURE/Skybox/Meshes/left.obj': quad(-1, 0),
    'FIXTURE/Skybox/Meshes/right.obj': quad(0, 1),
  };
  const source: MapDataSource = {
    root: '',
    readJsonOr: async <T>(path: string, fallback: T) => (documents[path] ?? fallback) as T,
    readTextOrNull: async path => meshes[path] ?? null,
    listDir: async () => [],
    listEntries: async () => [],
    pathExists: async () => false,
    readBytesOrNull: async () => null,
  };
  const textureUrl = (path: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 4, 4);
    ctx.fillStyle = path.endsWith('left.png') ? '#ff0000' : '#0000ff';
    ctx.fillRect(path.endsWith('left.png') ? 0 : 3, 0, 1, 4);
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 4, 1);
    return canvas.toDataURL();
  };
  const scene = new THREE.Scene();
  const previewBackground = new THREE.Color('#123456');
  scene.background = previewBackground;
  scene.fog = new THREE.Fog('#ffff00', 0, 1); // The sky must not inherit the course's distance fog.
  const backdrop = createSky({ scene } as Stage);
  const viewport = { scene, setSky: backdrop.setSky, showSky: backdrop.setVisible } as Viewport;
  const sky = await installLocalSky(viewport, source, 'FIXTURE', textureUrl);
  check(sky, 'The local sky fixture must load');
  const deadline = performance.now() + 5000;
  while (!backdrop.loaded) {
    check(performance.now() < deadline, 'The shared sky renderer must finish loading');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(256, 128);
  renderer.toneMapping = THREE.NoToneMapping;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  const target = new THREE.WebGLRenderTarget(256, 128);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(256 * 128 * 4);
  renderer.readRenderTargetPixels(target, 0, 0, 256, 128, pixels);
  const previewPixel = Array.from(pixels.slice((64 * 256 + 128) * 4, (64 * 256 + 128) * 4 + 3));
  check(
    previewPixel.every((channel, i) => Math.abs(channel - [0x12, 0x34, 0x56][i]) <= 2),
    `A loaded ISO sky stays hidden in map preview: ${previewPixel}`,
  );
  sky.setVisible(true);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 256, 128, pixels);
  const seam = Array.from({ length: 8 }, (_, i) =>
    Array.from(pixels.slice((64 * 256 + 124 + i) * 4, (64 * 256 + 124 + i) * 4 + 3)),
  );
  check(
    seam.every(rgb => rgb.every(channel => Math.abs(channel - 128) <= 2)),
    `Sky tile seam must stay neutral under fog: ${JSON.stringify(seam)}`,
  );
  camera.lookAt(0, 1, 0);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 256, 128, pixels);
  const zenith = Array.from(pixels.slice((64 * 256 + 128) * 4, (64 * 256 + 128) * 4 + 3));
  check(
    zenith.every(channel => Math.abs(channel - 128) <= 2),
    `Open sky must match the upper tile edge: ${zenith}`,
  );
  sky.setVisible(false);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 256, 128, pixels);
  const stoppedPixel = Array.from(pixels.slice((64 * 256 + 128) * 4, (64 * 256 + 128) * 4 + 3));
  check(
    scene.background === previewBackground &&
      stoppedPixel.every((channel, i) => Math.abs(channel - previewPixel[i]) <= 2),
    `Stopping restores the preview background instead of leaving the ISO zenith: ${stoppedPixel}`,
  );
  sky.setVisible(true);
  camera.lookAt(0, 0, -1);
  // Prove the same framebuffer measurement catches the previous edge wrapping.
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = object.material as THREE.MeshBasicMaterial;
    if (!material.map) return;
    material.map.wrapS = material.map.wrapT = THREE.RepeatWrapping;
    material.map.needsUpdate = true;
  });
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 256, 128, pixels);
  const oldPixel = Array.from(pixels.slice((64 * 256 + 127) * 4, (64 * 256 + 127) * 4 + 3));
  check(Math.max(...oldPixel) - Math.min(...oldPixel) > 25, 'Regression fixture must expose the original colored seam');
  target.dispose();
  renderer.dispose();
  return { seam, oldPixel };
}

void run()
  .then(result => {
    (globalThis as typeof globalThis & { localIsoResult?: unknown }).localIsoResult = { ok: true, ...result };
  })
  .catch(error => {
    (globalThis as typeof globalThis & { localIsoResult?: unknown }).localIsoResult = {
      ok: false,
      error: String(error.stack ?? error),
    };
  });
