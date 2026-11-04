import * as THREE from 'three';
import { preparePublicPlayer } from '../src/app/public/player';
import { Viewport } from '../src/app/viewport/viewport';
import type { PublicCourse } from '../src/core/session/public-courses';
import type { SessionChannel } from '../src/app/net/session-channel';

const playerState: { viewport?: Viewport } = {};
const focus = Viewport.prototype.focusMountain;
Viewport.prototype.focusMountain = function (...args) {
  playerState.viewport = this;
  return focus.apply(this, args);
};

declare global {
  interface Window {
    checkPublicEnvironment(course: PublicCourse): Promise<unknown>;
  }
}

window.checkPublicEnvironment = async course => {
  const session = {
    reference() {},
    setPlaying() {},
    rideEvent() {},
    aware() {},
    isOpen: () => false,
    serverNow: () => Date.now(),
  } as unknown as SessionChannel;
  const player = await preparePublicPlayer(course, document.getElementById('view')!, session, {
    progress() {},
    onPlaying() {},
    onRideControls() {},
    onStartChanged() {},
  });
  const viewport = playerState.viewport!;
  const fog = viewport.stage.worldRoot.getObjectByName('Custom ambient particles')!;
  const batch = fog.getObjectByProperty('isMesh', true) as THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  const texture = batch.material.uniforms.particleAtlas.value as THREE.Texture<HTMLImageElement | HTMLCanvasElement>;
  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const until = async (ready: () => boolean) => {
    const deadline = performance.now() + 15_000;
    while (!ready()) {
      if (performance.now() > deadline) throw new Error('Environment did not finish loading.');
      await nextFrame();
    }
  };
  await until(() => !!texture.image?.width && !viewport.terrainLayer.lightingStale);
  const renderer = viewport.stage.renderer;
  const target = new THREE.WebGLRenderTarget(32, 32);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(10, 30, -10);
  camera.up.set(0, 0, -1);
  camera.lookAt(10, 0, -10);
  const pixel = () => {
    renderer.setRenderTarget(target);
    renderer.render(viewport.stage.scene, camera);
    const rgb = new Uint8Array(4);
    renderer.readRenderTargetPixels(target, 16, 16, 1, 1, rgb);
    renderer.setRenderTarget(null);
    return [...rgb].slice(0, 3);
  };
  fog.visible = false;
  const lit = pixel();
  viewport.showAuthoredLights(false);
  await until(() => !viewport.terrainLayer.lightingStale);
  const unlit = pixel();
  fog.visible = true;
  const fogged = pixel();
  const result = {
    lights: viewport.lights.authoredRigData?.lights.length,
    lit,
    unlit,
    fogged,
    fog: {
      instances: batch.geometry.instanceCount,
      width: texture.image.width,
      missing: !!texture.userData.missingAsset,
    },
    markers: viewport.lights.authoredLightsGroup.visible,
    bounds: viewport.particleVolumes.authoredBounds.visible,
  };
  target.dispose();
  player.dispose();
  return result;
};
