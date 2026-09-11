// tier: fast

import assert from 'node:assert/strict';
import { SRGBColorSpace, type Vector2, type WebGLRenderer } from 'three';
import { WebXRManager } from 'three/src/renderers/webxr/WebXRManager.js';
import { maskXrLayersForThree, xrLayerKind } from '../src/app/ride/xr/config';

// Exercise the installed Three manager, so a dependency upgrade cannot silently invalidate the override.
// Only the native XR/GL boundaries are faked; layer selection and asynchronous setup are Three's real code.
class Session extends EventTarget {
  renderState: Record<string, unknown> = { layers: [] };
  failReferenceSpace = false;
  updateRenderState(state: object) { Object.assign(this.renderState, state); }
  async requestReferenceSpace() {
    if (this.failReferenceSpace) throw new Error('reference space refused');
    return {};
  }
  requestAnimationFrame() { return 1; }
}

class WebGLLayer {
  framebufferWidth = 2048;
  framebufferHeight = 1024;
  constructor(session: Session) {
    assert.ok(session instanceof Session, 'the layer receives the real session without a proxy');
  }
}

class Binding {
  constructor(session: Session) {
    assert.ok(session instanceof Session, 'the binding receives the real session');
  }
  createProjectionLayer() { return { textureWidth: 2048, textureHeight: 1024 }; }
}

const gl = {
  getContextAttributes: () => ({ xrCompatible: false, antialias: false, depth: true, stencil: false }),
  // Three awaits this before checking for projection support. Keep the override active across that await.
  makeXRCompatible: async () => {},
} as unknown as WebGL2RenderingContext;

function manager() {
  return new WebXRManager({
    getRenderTarget: () => null,
    getPixelRatio: () => 1,
    getSize: (size: Vector2) => size.set(800, 600),
    setPixelRatio: () => {},
    setSize: () => {},
    outputColorSpace: SRGBColorSpace,
  } as unknown as WebGLRenderer, gl);
}

const globals = ['XRWebGLBinding', 'XRWebGLLayer'] as const;
const priorGlobals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
try {
  Object.defineProperty(globalThis, 'XRWebGLBinding', { value: Binding, configurable: true });
  Object.defineProperty(globalThis, 'XRWebGLLayer', { value: WebGLLayer, configurable: true });
  const descriptor = Object.getOwnPropertyDescriptor(Binding.prototype, 'createProjectionLayer');

  const staleSession = new Session();
  Object.defineProperty(staleSession.renderState, 'layers', { value: undefined, writable: true });
  const staleManager = manager();
  await staleManager.setSession(staleSession as unknown as XRSession);
  assert.equal(xrLayerKind(staleManager.getBaseLayer()), 'projection',
    'reproduce the bug: hiding renderState.layers no longer forces WebGL in the installed Three');

  const forcedManager = manager();
  const restore = maskXrLayersForThree();
  assert.ok(restore);
  try {
    await forcedManager.setSession(new Session() as unknown as XRSession);
    assert.equal(xrLayerKind(forcedManager.getBaseLayer()), 'webgl',
      'the override makes the installed Three construct XRWebGLLayer');
  } finally {
    restore();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Binding.prototype, 'createProjectionLayer'), descriptor,
    'successful setup restores the native method and its exact descriptor');

  const projectionManager = manager();
  await projectionManager.setSession(new Session() as unknown as XRSession);
  assert.equal(xrLayerKind(projectionManager.getBaseLayer()), 'projection',
    'a subsequent projection session retains its normal capabilities');

  const failedManager = manager();
  const failedSession = new Session();
  failedSession.failReferenceSpace = true;
  const restoreFailed = maskXrLayersForThree();
  assert.ok(restoreFailed);
  try {
    await assert.rejects(failedManager.setSession(failedSession as unknown as XRSession), /reference space refused/);
  } finally {
    restoreFailed();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Binding.prototype, 'createProjectionLayer'), descriptor,
    'failed asynchronous setup also restores the native method');

  const locked = Object.freeze({ createProjectionLayer() {} });
  assert.equal(maskXrLayersForThree(locked), null, 'an unforgeable capability declines the override safely');
  const inherited = Object.create(Binding.prototype) as object;
  const restoreInherited = maskXrLayersForThree(inherited);
  assert.ok(restoreInherited);
  try {
    assert.equal('createProjectionLayer' in inherited, false, 'an inherited capability is hidden at its owner');
  } finally {
    restoreInherited();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Binding.prototype, 'createProjectionLayer'), descriptor);
  assert.equal(Object.hasOwn(inherited, 'createProjectionLayer'), false, 'restoration does not add a shadow');
  assert.ok(maskXrLayersForThree({}), 'a runtime without projection support already selects WebGL');
} finally {
  globals.forEach((key, index) => {
    const prior = priorGlobals[index];
    if (prior) Object.defineProperty(globalThis, key, prior);
    else Reflect.deleteProperty(globalThis, key);
  });
}

console.log('XR LAYER MODE TEST PASSED (installed Three: forced WebGL, projection, and failure restoration)');
