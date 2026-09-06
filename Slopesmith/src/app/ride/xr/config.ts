/** Which WebXR render path Three should build for the next headset session. */
export type XrLayerMode = 'webgl' | 'projection';

/** The actual viewport rendered for one eye in a headset session. WebXR only reveals this after presentation
 *  starts, and runtimes may round or clamp the requested scale, so retain the request beside the measurement. */
export type XrEyeBufferMeasurement = {
  eyeWidth: number;
  eyeHeight: number;
  views: number;
  /** Effective scale inferred from the allocation. It begins as the request and is corrected against a 1x sample. */
  renderScale: number;
  /** Original slider value, retained when the runtime reduced it. */
  requestedScale: number;
  /** Runtime's recommended-to-native factor. Useful context, but explicitly not treated as a ceiling. */
  nativeRenderScale: number | null;
  /** A likely upper bound inferred from a real request that allocated fewer pixels. It never constrains the control. */
  maxRenderScale: number | null;
};

export const DEFAULT_XR_RENDER_SCALE = 1.5;
export const XR_RENDER_SCALE_STEP = 0.1;

/** Put a runtime's arbitrary float onto the slider without ever rounding above the reported ceiling. */
export function xrScaleAtOrBelow(value: number): number {
  return Math.max(XR_RENDER_SCALE_STEP,
    Number((Math.floor((value + 1e-7) / XR_RENDER_SCALE_STEP) * XR_RENDER_SCALE_STEP).toFixed(2)));
}

/** The legacy WebGL API exposes the recommended-to-native factor only after requestSession succeeds. Keep it as
 *  an advisory starting point, never a hard ceiling: runtimes can accept supersampling above native resolution. */
export function xrNativeRenderScale(session: XRSession): number | null {
  const ctor = (globalThis as typeof globalThis & {
    XRWebGLLayer?: { getNativeFramebufferScaleFactor?(session: XRSession): number };
  }).XRWebGLLayer;
  if (typeof ctor?.getNativeFramebufferScaleFactor !== 'function') return null;
  try {
    const scale = ctor.getNativeFramebufferScaleFactor(session);
    return Number.isFinite(scale) && scale > 0 ? xrScaleAtOrBelow(scale) : null;
  } catch {
    return null;
  }
}

/** When a trustworthy 1x sample is available, compare the new real viewport to it and correct both the effective
 *  scale and a likely observed ceiling. The native factor is deliberately excluded: it is not a maximum. */
export function reconcileXrEyeBuffer(previous: XrEyeBufferMeasurement | null,
  next: XrEyeBufferMeasurement): XrEyeBufferMeasurement {
  if (!previous) return next;
  const retained = { ...next, maxRenderScale: next.maxRenderScale ?? previous.maxRenderScale };
  if (Math.abs(previous.renderScale - 1) >= 0.001 || next.renderScale <= 1) return retained;
  const observed = Math.min(next.eyeWidth / previous.eyeWidth, next.eyeHeight / previous.eyeHeight);
  if (!Number.isFinite(observed)) return next;
  const applied = xrScaleAtOrBelow(observed);
  // Meeting a request above a previously suspected cap disproves it. Otherwise retain the earlier observation.
  // A smaller viewport than requested is the stronger observation in the other direction and becomes the bound.
  if (observed + XR_RENDER_SCALE_STEP / 2 >= next.renderScale) return {
    ...next,
    maxRenderScale: previous.maxRenderScale !== null
      && next.renderScale > previous.maxRenderScale + XR_RENDER_SCALE_STEP / 2
      ? null : retained.maxRenderScale,
  };
  return {
    ...next,
    renderScale: applied,
    maxRenderScale: applied,
  };
}

/** Advisory styling only. A suspected cap never disables a value; it just warns that the projection may not be
 *  allocated as requested. */
export function xrScaleMayBeCapped(sample: XrEyeBufferMeasurement | null, selectedScale: number): boolean {
  return sample?.maxRenderScale !== null && sample?.maxRenderScale !== undefined
    && selectedScale > sample.maxRenderScale + XR_RENDER_SCALE_STEP / 2;
}

const scaleText = (scale: number) => `${Number(scale.toFixed(2))}×`;

/** Resolution copy for launch setup. The actual viewport is browser-owned and unavailable until an immersive
 *  frame has rendered, so distinguish the measured allocation from projections based on it. */
export function xrEyeBufferNote(sample: XrEyeBufferMeasurement | null, selectedScale: number): string {
  if (!sample) {
    return '1× resolution appears after the first VR launch; WebXR does not expose the headset’s eye buffer beforehand.';
  }
  const baseWidth = Math.round(sample.eyeWidth / sample.renderScale);
  const baseHeight = Math.round(sample.eyeHeight / sample.renderScale);
  const selectedWidth = Math.round(baseWidth * selectedScale);
  const selectedHeight = Math.round(baseHeight * selectedScale);
  const eyes = `${sample.views} view${sample.views === 1 ? '' : 's'}`;
  const bounds = [
    sample.maxRenderScale === null ? null : `likely cap ${scaleText(sample.maxRenderScale)}`,
    sample.nativeRenderScale === null ? null : `runtime native ${scaleText(sample.nativeRenderScale)} (not a cap)`,
  ].filter((part): part is string => part !== null).join(' · ');
  const boundsSuffix = bounds ? ` · ${bounds}` : '';
  const measuredAtOne = Math.abs(sample.renderScale - 1) < 0.001;
  const selectedWasMeasured = Math.abs(sample.renderScale - selectedScale) < 0.001;
  if (Math.abs(selectedScale - 1) < 0.001) {
    return measuredAtOne
      ? `1×: ${sample.eyeWidth}×${sample.eyeHeight} per eye · ${eyes} · measured on the last headset${boundsSuffix}.`
      : `Estimated 1×: ${baseWidth}×${baseHeight} per eye · ${eyes} · derived from the last ${scaleText(sample.renderScale)} session (${sample.eyeWidth}×${sample.eyeHeight} actual)${boundsSuffix}.`;
  }
  const selected = selectedWasMeasured
    ? `${scaleText(selectedScale)}: ${sample.eyeWidth}×${sample.eyeHeight} per eye (measured)`
    : `${scaleText(selectedScale)} requests about ${selectedWidth}×${selectedHeight} per eye`;
  const baseline = `${measuredAtOne ? '' : 'estimated '}1× ${baseWidth}×${baseHeight}`;
  return `${selected} · ${baseline} · ${eyes}${boundsSuffix}. WebXR may round or cap the request.`;
}

/**
 * Prefer the runtime-owned XRWebGLLayer while measuring PCVR. Three r170 otherwise chooses an
 * XRProjectionLayer whenever the Layers API exists, even when the optional `layers` feature was not requested.
 */
export const DEFAULT_XR_LAYER_MODE: XrLayerMode = 'webgl';

/**
 * Three r170 decides which XR render path to create with exactly this test:
 *
 *     session.renderState.layers === undefined
 *
 * Modern runtimes expose `layers` even when the optional composition-layers feature was not requested, because
 * a single projection layer is part of the base facility. Shadow the inherited WebIDL accessor on this ONE
 * render-state object while `WebXRManager.setSession()` runs, then put the object back exactly as it was.
 *
 * The XRSession itself is never proxied or wrapped, so the native XRWebGLLayer constructor still receives the
 * real platform object and passes its WebIDL brand check. Null means this runtime made the property unforgeable;
 * the caller can continue safely and the requested -> effective diagnostic will expose the fallback.
 */
export function maskXrLayersForThree(renderState: object): (() => void) | null {
  const prior = Object.getOwnPropertyDescriptor(renderState, 'layers');
  try {
    Object.defineProperty(renderState, 'layers', {
      configurable: true,
      enumerable: prior?.enumerable ?? false,
      value: undefined,
    });
  } catch {
    return null;
  }
  if ((renderState as { layers?: unknown }).layers !== undefined) {
    restoreOwnProperty(renderState, 'layers', prior);
    return null;
  }
  return () => restoreOwnProperty(renderState, 'layers', prior);
}

function restoreOwnProperty(target: object, key: string, prior: PropertyDescriptor | undefined) {
  try {
    if (prior) Object.defineProperty(target, key, prior);
    else delete (target as Record<string, unknown>)[key];
  } catch {
    // Diagnostics retain whether the override was accepted. Restoration failure is harmless to the native
    // session: this only removes an own JS shadow whose value was undefined; the runtime keeps its layer state.
  }
}

/** Structural rather than `instanceof`: browser-owned XR interfaces are not constructors in every runtime. */
export function xrLayerKind(layer: unknown): 'webgl' | 'projection' | 'none' {
  if (!layer || typeof layer !== 'object') return 'none';
  const candidate = layer as { framebufferWidth?: unknown; textureWidth?: unknown };
  if (typeof candidate.framebufferWidth === 'number') return 'webgl';
  if (typeof candidate.textureWidth === 'number') return 'projection';
  return 'none';
}
