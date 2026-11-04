import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';

const work = mkdtempSync(join(tmpdir(), 'slopesmith-ssx3-beta-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(work, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(work, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const fixture = process.env.SLOPESMITH_SSX3_BETA_ISO ?? join(work, 'preview.iso');
const course = process.env.SLOPESMITH_SSX3_BETA_COURSE ?? 'SSX3B_ARA1';
if (!process.env.SLOPESMITH_SSX3_BETA_ISO)
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [resolve('../Native/tests/ssx3_music_import_test.py'), '--fixture', fixture],
    { windowsHide: true },
  );
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: null, proxy: { '/api': { target: api.url, ws: true } } },
});
await vite.listen();
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript('globalThis.__name = fn => fn;');
page.setDefaultTimeout(process.env.SLOPESMITH_SSX3_BETA_ISO ? 900_000 : 120_000);
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const address = vite.httpServer!.address();
  assert(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/isos`);
  if (process.env.SLOPESMITH_SSX3_BETA_ISO) {
    page.on('console', message => {
      if (message.text().startsWith('Music import:')) console.log(message.text());
    });
    await page.evaluate(() => {
      let previous = '';
      new MutationObserver(() => {
        const text = document.querySelector('.public-iso-status')?.textContent ?? '';
        if (text !== previous && /music|saved|validating/i.test(text)) console.log(`Music import: ${text}`);
        previous = text;
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }
  await page.locator('#public-iso').setInputFiles(fixture);
  await page.locator('.public-iso-status').filter({ hasText: 'maps found' }).waitFor();
  assert((await page.getByRole('button', { name: 'SSX 3 Beta', exact: true }).getAttribute('aria-pressed')) === 'true');
  const card = page.locator(`.public-iso-map[data-course="${course}"]`);
  await card.waitFor();
  const advanced = page.getByRole('checkbox', { name: 'Show all SSX 3 Beta map types', exact: true });
  const defaults = await page.locator('.public-iso-map').count();
  await advanced.check();
  assert((await page.locator('.public-iso-map').count()) > defaults);
  await advanced.uncheck();
  await card.locator('.public-iso-map-actions button').first().click();
  await page.locator(`.public-iso-map[data-course="${course}"][data-state="loaded"]`).waitFor();
  const metadata = await page.evaluate(async course => {
    const cachePath = '/src/app/public/iso-cache.ts';
    const { readCachedCourse, cachedIsoCourses, needsCollisionSoundUpdate } = await import(
      /* @vite-ignore */ cachePath
    );
    const files: Map<string, Blob> = await readCachedCourse(course);
    const read = async (name: string) => JSON.parse(await files.get(name.toLowerCase())!.text());
    const dataPath = '/src/app/public/local-map-data.ts';
    const { localMapData } = await import(/* @vite-ignore */ dataPath);
    const local = await localMapData([course]);
    const musicIndex = await (await fetch(local.resolveAsset(`/api/reference-music?level=${course}`))).json();
    const song = musicIndex.songs[0];
    const musicGraph = await (
      await fetch(local.resolveAsset(`/api/reference-music?level=${course}&song=${song.id}`))
    ).json();
    const musicWave = await (
      await fetch(local.resolveAsset(`/api/reference-music-sample?level=${course}&song=${song.id}&sample=1`))
    ).arrayBuffer();
    const musicBuffer = await new OfflineAudioContext(2, 1, 8000).decodeAudioData(musicWave);
    const wave = await (
      await fetch(local.resolveAsset(`/api/board-sound?bank=zboard&slot=4&loop=1&level=${course}`))
    ).arrayBuffer();
    const decoded = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(wave);
    const samples = decoded.getChannelData(0);
    const peak = samples.reduce((peak: number, value: number) => Math.max(peak, Math.abs(value)), 0);
    const readerPath = '/src/shared/map-effects.ts';
    const { readReferenceEffects } = await import(/* @vite-ignore */ readerPath);
    const effects = await readReferenceEffects(local.source, course);
    const fog = await createImageBitmap(files.get('textures/particles/fog0.png')!);
    const fogSize = [fog.width, fog.height];
    fog.close();
    const sourceModels = (await read('Models.json')).Models as { Pickup?: { Kind: string; Value: number } }[];
    const sourceInstances = (await read('Instances.json')).Instances as {
      ModelID: number;
      Pickup?: { Kind: string };
    }[];
    const pickupIds = sourceModels.flatMap((model, id) => (model.Pickup ? [id] : []));
    const propsPath = '/src/shared/map-props.ts';
    const { buildLevelPropsUncached, readModelGeometries, nativeArtSource } = await import(
      /* @vite-ignore */ propsPath
    );
    const payload = await buildLevelPropsUncached(local.source, course);
    const art = await nativeArtSource(local.source);
    const pickupTemplates = payload.models.filter(
      (model: { id: number; fx?: unknown }) => pickupIds.includes(model.id) && model.fx,
    );
    const geoms = await readModelGeometries(local.source, course, new Set(pickupIds));
    const exportPath = '/src/core/export/props.ts';
    const { bakePlacedProps } = await import(/* @vite-ignore */ exportPath);
    const materialPath = '/src/core/export/materials.ts';
    const { buildMaterialCombiner } = await import(/* @vite-ignore */ materialPath);
    const copies = pickupIds.map(id => ({
      id: `pickup-copy:${id}`,
      level: course,
      model: id,
      name: 'Copied pickup',
      pos: [0, 0, 0],
      yaw: 0,
      scale: 1,
    }));
    const baked = bakePlacedProps(
      copies,
      (_level: string, model: number) => geoms.get(model),
      buildMaterialCombiner(new Map()),
    );
    local.dispose();
    // Reproduce an older cached adapter with the generated snow loops missing.
    const { openIsoCache } = await import(/* @vite-ignore */ cachePath);
    const db = await openIsoCache();
    const transaction = db.transaction('files', 'readwrite');
    for (const stem of ['003', '004'])
      for (const suffix of ['.wav', '.loop.wav'])
        transaction.objectStore('files').delete(`${course}/audio/sfx/openslope_board/${stem}${suffix}`);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    const old = await localMapData([course]);
    const repaired = await (
      await fetch(old.resolveAsset(`/api/board-sound?bank=zboard&slot=4&loop=1&level=${course}`))
    ).arrayBuffer();
    old.dispose();
    return {
      courses: await cachedIsoCourses(),
      origin: await read('Origin.json'),
      info: await read('Import.json'),
      patches: (await read('Patches.json')).Patches.length,
      needsSound: await needsCollisionSoundUpdate([course]),
      loopFrames: samples.length,
      peak,
      repairedBytes: repaired.byteLength,
      musicSongs: musicIndex.songs.length,
      musicNodes: musicGraph.Nodes.length,
      musicFrames: musicBuffer.length,
      fogSize,
      fogTexture: effects.particleVolumes?.[0]?.texture,
      pickupModels: pickupIds.length,
      pickupUiTagged: payload.models.filter((model: { pickup?: boolean }) => model.pickup).length,
      pickupTemplates: pickupTemplates.length,
      pickupClips: Object.keys(baked.propClips).length,
      pickupTiers: art.gemTiers.map((tier: { tier: number }) => tier.tier).sort((a: number, b: number) => a - b),
      collectibleIndex: sourceInstances.findIndex(instance => instance.Pickup?.Kind === 'collectible'),
    };
  }, course);
  assert(metadata.courses.includes(course));
  assert(!metadata.courses.includes('SSX3_ARA1'));
  assert.equal(metadata.origin.Game, 'ssx-3-beta');
  assert.equal(metadata.info.WorldId, 'ssx-3-beta:bam');
  assert(metadata.patches > 0);
  assert.equal(metadata.needsSound, false);
  assert(metadata.loopFrames >= 32 && metadata.peak > 0.001, 'Snow glide decodes to audible PCM');
  assert(metadata.repairedBytes > 44, 'Older cached adapters reuse their own original board loop');
  assert(
    metadata.musicSongs > 0 && metadata.musicNodes > 0 && metadata.musicFrames > 0,
    'Imported music routes decode',
  );
  if (!process.env.SLOPESMITH_SSX3_BETA_ISO) assert.equal(metadata.musicSongs, 2);
  assert(metadata.fogSize.every((size: number) => size > 0));
  assert(metadata.fogTexture?.startsWith('asset2:'), 'Fog binds the imported sprite by its exact asset identity');
  assert(
    metadata.pickupModels > 0 && metadata.pickupTemplates === metadata.pickupModels,
    'Pickups carry portable default effects',
  );
  assert(
    metadata.pickupClips === metadata.pickupModels,
    'Every pickup retains its animation when copied as an ordinary prop',
  );
  assert(metadata.pickupTiers.includes(2));
  assert.equal(metadata.pickupUiTagged, metadata.pickupModels, 'Common pickup metadata controls Tricks visibility');
  await page.reload();
  await page.getByRole('button', { name: 'SSX 3 Beta', exact: true }).click();
  await card.getByRole('link', { name: /^Play / }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  await page.evaluate(async () => {
    const audioPath = '/src/app/audio/ride-music.ts';
    const { RideMusicRuntime } = await import(/* @vite-ignore */ audioPath);
    const step = RideMusicRuntime.prototype.step;
    RideMusicRuntime.prototype.step = function (...args: unknown[]) {
      Object.assign(window, { betaMusicForTest: this });
      return step.apply(this, args);
    };
    const path = '/src/app/ride/session.ts';
    const { TestRide } = (await import(/* @vite-ignore */ path)) as typeof import('../src/app/ride/session');
    const start = TestRide.prototype.start;
    TestRide.prototype.start = function (...args) {
      const scene = (this as unknown as { o: { scene: import('three').Scene } }).o.scene;
      Object.assign(window, { betaRideForTest: this, betaSceneForTest: scene });
      return start.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const music = (
      window as typeof window & {
        betaMusicForTest?: { raceCurrent?: { source: AudioBufferSourceNode }; raceMaster?: GainNode };
      }
    ).betaMusicForTest;
    return (music?.raceCurrent?.source.buffer?.length ?? 0) > 0 && (music?.raceMaster?.gain.value ?? 0) > 0;
  });
  if (process.env.SLOPESMITH_SSX3_BETA_ISO) {
    const spinning = await page.evaluate(async () => {
      const scene = (window as typeof window & { betaSceneForTest: import('three').Scene }).betaSceneForTest;
      const snapshots = new Map<string, number[]>();
      for (let frame = 0; frame < 20; ++frame) {
        for (const object of scene.getObjectsByProperty('name', 'mdl_ESS3_collecta_1000')) {
          const model = object as import('three').InstancedMesh;
          if (!model.isInstancedMesh || model.userData.propBatchKind === 'effect-proxy') continue;
          const before = snapshots.get(model.uuid);
          if (before?.some((value, index) => Math.abs(value - model.instanceMatrix.array[index]) > 1e-5)) return true;
          snapshots.set(model.uuid, Array.from(model.instanceMatrix.array));
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    });
    assert(spinning, 'The real collectible model spins during the ride');
    const grounded = await page.evaluate(async () => {
      let count = 0;
      for (let i = 0; i < 40; ++i) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (
          (window as typeof window & { betaRideForTest: import('../src/app/ride/session').TestRide }).betaRideForTest
            .state.grounded
        )
          ++count;
      }
      return count;
    });
    assert(grounded > 0, 'The real preview terrain supports the rider after spawn');
    const lighting = await page.evaluate(patches => {
      const scene = (window as typeof window & { betaSceneForTest: import('three').Scene }).betaSceneForTest;
      const chunks = scene.getObjectByName('reference-terrain-chunks')!;
      const terrain = chunks.children[0] as import('three').Mesh;
      const positions = terrain.geometry.getAttribute('position');
      const normals = terrain.geometry.getAttribute('normal');
      const perPatch = positions.count / patches;
      const middle = Math.floor(perPatch / 2);
      const source = scene.userData.riderLightSource as import('../src/app/ride/rider-lighting').RiderLightSource;
      let darkest = 1,
        brightest = 0,
        sampled = 0;
      for (let patch = 0; patch < patches; patch++) {
        const vertex = patch * perPatch + middle;
        if (normals.getY(vertex) < 0.5) continue;
        const point = terrain.localToWorld(terrain.position.clone().fromBufferAttribute(positions, vertex));
        point.y += 0.9;
        const light = source(point);
        if (!light) continue;
        if (light.keys.length !== 1) throw new Error('Scenery averages still override the ground lighting');
        const shade = light.ambient[0] / 0.6;
        darkest = Math.min(darkest, shade);
        brightest = Math.max(brightest, shade);
        sampled++;
      }
      return { darkest, brightest, sampled };
    }, metadata.patches);
    assert(lighting.sampled > 10, 'Real preview ground lighting reaches the riding scene');
    assert(
      lighting.darkest < lighting.brightest * 0.5,
      `Preview shade varies by location: ${JSON.stringify(lighting)}`,
    );
    console.log('Preview rider lighting:', lighting);
    const pickup = await page.evaluate(async index => {
      const ride = (window as typeof window & { betaRideForTest: import('../src/app/ride/session').TestRide })
        .betaRideForTest;
      const options = (ride as unknown as { o: import('../src/app/ride/session').RideStartOpts }).o;
      const collider = options.obstacles?.find(
        source => source.object.kind === 'reference' && source.object.index === index,
      );
      if (!collider) throw new Error('The collectible has no riding trigger');
      const point = options.scene.position.clone().setFromMatrixPosition(collider.matrixWorld);
      options.onObstacleHit!({
        key: collider.key,
        object: collider.object,
        point,
        normal: point.clone().set(0, 1, 0),
        impactSpeed: 8,
        shove: null,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      const meshes = options.scene
        .getObjectsByProperty('name', 'mdl_ESS3_collecta_1000')
        .map(object => object as import('three').InstancedMesh)
        .filter(mesh => mesh.isInstancedMesh && mesh.userData.propBatchKind !== 'effect-proxy')
        .map(mesh => ({
          mesh,
          slot: (mesh.userData.propInsts as { sourceIndex: number }[]).findIndex(
            instance => instance.sourceIndex === index,
          ),
        }))
        .filter(item => item.slot >= 0);
      const hidden =
        meshes.length > 0 &&
        meshes.every(({ mesh, slot }) =>
          [0, 1, 2, 4, 5, 6, 8, 9, 10].every(
            component => Math.abs(mesh.instanceMatrix.array[slot * 16 + component]) < 1e-8,
          ),
        );
      return { solid: collider.solid, hidden, message: document.body.textContent?.includes('Collectible collected') };
    }, metadata.collectibleIndex);
    assert.equal(pickup.solid, false, 'Collectibles can be ridden through');
    assert(pickup.hidden, 'The collected snowflake disappears');
    assert(!pickup.message, 'Collection has no large HUD message');
    assert.deepEqual(metadata.pickupTiers, [2, 3, 5, 10]);
  }
  await page.screenshot({ path: join(work, 'beta-riding.png') });
  assert.deepEqual(errors, []);
  console.log(
    `SSX 3 beta browser discovery, import, persistence, music and riding passed (${metadata.patches} patches, ${metadata.musicSongs} songs). ${work}`,
  );
} catch (error) {
  await page.screenshot({ path: join(work, 'failure.png') });
  console.error('Browser errors:', errors, '\nPage:', await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
