/** Prepare the existing desktop context before Three attaches a session and installs its XR resources. */
export function createXrContext(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const readAttributes = gl.getContextAttributes.bind(gl);
  const initialAttributes = readAttributes();
  let layerAttributes = initialAttributes ? { ...initialAttributes } : null;
  if (layerAttributes) {
    try {
      // Three retains this record from renderer construction. AA is overridden per layer, but compatibility
      // must remain live: makeXRCompatible and context restoration can change it after construction.
      Object.defineProperty(layerAttributes, 'xrCompatible', {
        configurable: true, enumerable: true, get: () => readAttributes()?.xrCompatible === true,
      });
      const attributes = layerAttributes;
      Object.defineProperty(gl, 'getContextAttributes', {
        configurable: true, value: () => readAttributes() ? attributes : null,
      });
    } catch {
      layerAttributes = null; // an unmodifiable host still works, without the per-session AA override
    }
  }
  let preparation: Promise<void> | null = null;

  return {
    layerAttributes,
    get preparing() { return preparation !== null; },
    prepare(restoreTimeoutMs = 10_000): Promise<void> {
      if (preparation) return preparation;
      preparation = makeCompatible(gl, readAttributes, restoreTimeoutMs).finally(() => { preparation = null; });
      return preparation;
    },
  };
}

async function makeCompatible(gl: WebGLRenderingContext | WebGL2RenderingContext,
  readAttributes: () => WebGLContextAttributes | null, restoreTimeoutMs: number): Promise<void> {
  let awaitingRestore = false, sawContextTransition = gl.isContextLost();
  const onLost = () => { awaitingRestore = true; sawContextTransition = true; };
  const onRestored = () => { awaitingRestore = false; sawContextTransition = true; };
  gl.canvas.addEventListener('webglcontextlost', onLost);
  gl.canvas.addEventListener('webglcontextrestored', onRestored);
  try {
    if (gl.isContextLost()) await waitForRestore(gl, restoreTimeoutMs);
    if (readAttributes()?.xrCompatible === true) return;
    try {
      await gl.makeXRCompatible();
    } catch (error) {
      // Chrome PCVR can reject before delivering its context-loss event. Retry only this error with actual
      // loss/restoration evidence, and only once, after restoration. Permission/device errors still propagate.
      if (!(error instanceof Error) || error.name !== 'InvalidStateError'
        || (!gl.isContextLost() && !sawContextTransition)) throw error;
      if (gl.isContextLost() || awaitingRestore) await waitForRestore(gl, restoreTimeoutMs);
      if (readAttributes()?.xrCompatible !== true) await gl.makeXRCompatible();
    }
    // Some implementations resolve compatibility before restoration's event has reached renderer listeners.
    if (gl.isContextLost() || awaitingRestore) await waitForRestore(gl, restoreTimeoutMs);
  } finally {
    gl.canvas.removeEventListener('webglcontextlost', onLost);
    gl.canvas.removeEventListener('webglcontextrestored', onRestored);
  }
}

function waitForRestore(gl: WebGLRenderingContext | WebGL2RenderingContext, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onRestored = () => {
      gl.canvas.removeEventListener('webglcontextrestored', onRestored);
      clearTimeout(timer); resolve();
    };
    const timer = setTimeout(() => {
      gl.canvas.removeEventListener('webglcontextrestored', onRestored);
      reject(new Error('WebGL context did not restore during XR startup'));
    }, timeoutMs);
    gl.canvas.addEventListener('webglcontextrestored', onRestored, { once: true });
  });
}
