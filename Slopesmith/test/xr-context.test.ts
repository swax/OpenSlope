// tier: fast

import assert from 'node:assert/strict';
import { SRGBColorSpace, Vector2, type WebGLRenderer } from 'three';
import { WebXRManager } from 'three/src/renderers/webxr/WebXRManager.js';
import { createXrContext } from '../src/app/viewport/xr-context';

function context() {
  let lost = false, compatible = false, calls = 0;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  class Canvas extends EventTarget {
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) {
      listeners.add(callback);
      super.addEventListener(type, callback, options);
    }
    override removeEventListener(type: string, callback: EventListenerOrEventListenerObject) {
      listeners.delete(callback);
      super.removeEventListener(type, callback);
    }
  }
  const canvas = new Canvas();
  const fake = {
    canvas,
    getContextAttributes: () => lost ? null : { xrCompatible: compatible, antialias: false, depth: true, stencil: false },
    isContextLost: () => lost,
    makeXRCompatible: async () => { calls++; await negotiate(); },
  };
  let negotiate = async () => { compatible = true; };
  return {
    gl: fake as unknown as WebGL2RenderingContext,
    get calls() { return calls; },
    set negotiate(value: () => Promise<void>) { negotiate = value; },
    compatible() { compatible = true; },
    lose(deliverEvent = true) {
      lost = true; compatible = false;
      if (deliverEvent) canvas.dispatchEvent(new Event('webglcontextlost'));
    },
    restore(xrCompatible = false) {
      lost = false; compatible = xrCompatible;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
    listeners,
  };
}

const invalidState = () => new DOMException('context no longer usable', 'InvalidStateError');

{
  const fake = context();
  fake.compatible(); // native context creation honored xrCompatible: true
  const preparation = createXrContext(fake.gl);
  await preparation.prepare();
  assert.equal(fake.calls, 0, 'an XR-compatible viewport starts without a post-requestSession GPU transition');
  assert.equal(preparation.layerAttributes?.xrCompatible, true);
  assert.equal(preparation.preparing, false);
  assert.equal(fake.listeners.size, 0);
}

{
  const fake = context();
  const preparation = createXrContext(fake.gl);
  const captured = fake.gl.getContextAttributes()!;
  assert.equal(captured.xrCompatible, false);
  const pending = preparation.prepare();
  assert.equal(preparation.preparing, true, 'viewport is gated across the asynchronous negotiation');
  assert.equal(preparation.prepare(), pending, 'overlapping preparations share a single negotiation');
  await pending;
  assert.equal(preparation.preparing, false);
  assert.equal(captured.xrCompatible, true, 'the record already retained by Three sees current compatibility');
  captured.antialias = true;
  assert.equal(fake.gl.getContextAttributes()!.antialias, true, 'per-session AA remains independently mutable');
  await preparation.prepare();
  assert.equal(fake.calls, 1, 'an already compatible context needs no further negotiation');
  assert.equal(fake.listeners.size, 0);
  fake.lose();
  assert.equal(captured.xrCompatible, false, 'a later context loss invalidates the retained compatibility flag');
  assert.equal(fake.gl.getContextAttributes(), null, 'the override preserves null while the context is lost');
}

// Match the reported ordering: promise rejection precedes the context-loss event; restoration follows later.
for (const restoredCompatible of [false, true]) {
  const fake = context();
  fake.negotiate = async () => {
    if (fake.calls === 1) {
      fake.lose(false);
      setTimeout(() => { fake.lose(); fake.restore(restoredCompatible); }, 0);
      throw invalidState();
    }
    assert.equal(fake.gl.isContextLost(), false, 'never retry while the context is lost');
    fake.compatible();
  };
  const preparation = createXrContext(fake.gl);
  await preparation.prepare();
  assert.equal(fake.calls, restoredCompatible ? 1 : 2);
  assert.equal(fake.gl.getContextAttributes()!.xrCompatible, true);
  assert.equal(preparation.preparing, false);
  assert.equal(fake.listeners.size, 0, 'recovery removes its restoration listener');
}

{
  const fake = context();
  const preparation = createXrContext(fake.gl);
  fake.lose(); // loss notification predates the attempt
  setTimeout(() => fake.restore(), 0);
  await preparation.prepare();
  assert.equal(fake.calls, 1, 'an initially lost context is restored before negotiating');
  assert.equal(fake.listeners.size, 0);
}

{
  const fake = context();
  fake.negotiate = async () => {
    fake.lose(); fake.restore(true);
    throw invalidState(); // restoration can also finish before the rejected promise's continuation
  };
  await createXrContext(fake.gl).prepare();
  assert.equal(fake.calls, 1);
}

for (const error of [invalidState(), new DOMException('permission denied', 'NotAllowedError')]) {
  const fake = context();
  fake.negotiate = async () => { throw error; };
  const preparation = createXrContext(fake.gl);
  await assert.rejects(preparation.prepare(), candidate => candidate === error);
  assert.equal(fake.calls, 1, 'errors without context-loss evidence are not retried');
  assert.equal(preparation.preparing, false, 'failure releases the viewport gate');
  assert.equal(fake.listeners.size, 0, 'failure removes the temporary context listeners');
}

{
  const fake = context();
  fake.negotiate = async () => { fake.lose(); throw invalidState(); };
  const preparation = createXrContext(fake.gl);
  await assert.rejects(preparation.prepare(10), /did not restore/);
  assert.equal(fake.calls, 1, 'permanent loss does not enter a retry loop');
  assert.equal(preparation.preparing, false);
  assert.equal(fake.listeners.size, 0, 'timeout also cleans up the restoration listener');
}

// Use the installed Three manager, so this checks its actual retained-attributes and session-end behavior.
class Session extends EventTarget {
  renderState = {};
  updateRenderState(value: object) { Object.assign(this.renderState, value); }
  async requestReferenceSpace() { return {}; }
  requestAnimationFrame() { return 1; }
  cancelAnimationFrame() {}
}
class WebGLLayer { framebufferWidth = 2048; framebufferHeight = 1024; }
const priorLayer = Object.getOwnPropertyDescriptor(globalThis, 'XRWebGLLayer');
try {
  Object.defineProperty(globalThis, 'XRWebGLLayer', { value: WebGLLayer, configurable: true });
  const fake = context();
  fake.negotiate = async () => {
    assert.equal(manager.getSession(), null, 'no partially attached Three session during adapter negotiation');
    if (fake.calls === 1) {
      fake.lose(false);
      setTimeout(() => fake.restore(), 0);
      throw invalidState();
    }
    fake.compatible();
  };
  const preparation = createXrContext(fake.gl);
  let pixelRatio = 2;
  const dimensions = new Vector2(800, 600);
  const manager = new WebXRManager({
    getRenderTarget: () => null, setRenderTarget: () => {},
    getPixelRatio: () => pixelRatio, setPixelRatio: (value: number) => { pixelRatio = value; },
    getSize: (size: Vector2) => size.copy(dimensions),
    setSize: (width: number, height: number) => dimensions.set(width, height),
    outputColorSpace: SRGBColorSpace,
  } as unknown as WebGLRenderer, fake.gl);
  await preparation.prepare();
  const session = new Session();
  await manager.setSession(session as unknown as XRSession);
  assert.equal(manager.isPresenting, true);
  assert.equal(fake.calls, 2, 'Three skips redundant compatibility work after the one recovery');
  session.dispatchEvent(new Event('end'));
  assert.equal(manager.getSession(), null);
  assert.equal(pixelRatio, 2, 'session end restores the original desktop pixel ratio');
  assert.deepEqual(dimensions.toArray(), [800, 600], 'session end restores the original desktop dimensions');
} finally {
  if (priorLayer) Object.defineProperty(globalThis, 'XRWebGLLayer', priorLayer);
  else Reflect.deleteProperty(globalThis, 'XRWebGLLayer');
}

console.log('XR CONTEXT: PASS (delayed restoration, bounded recovery, live attributes and installed Three startup)');
