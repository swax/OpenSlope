/**
 * Disposable screen-sharing state.
 *
 * This is deliberately a view, not a video stream: every observer renders the mountain locally and receives
 * only the sharer's camera framing and display switches. It is never persisted into a mountain or replayed
 * after a session ends.
 */

export type SharedShadeMode = 'textured' | 'surface' | 'none';

export interface SharedCameraView {
  pos: [number, number, number];
  target: [number, number, number];
  /** Rendered camera-up direction. Test first-person can bank away from editor world-up. */
  up: [number, number, number];
  ortho: boolean;
  zoom: number;
  orthoHalfH: number;
  /** Perspective projection used by the rendered view; retained while an orthographic frame is active. */
  fov: number;
  /** Near clip matters in first person, where the ride camera moves it much closer than the editor camera. */
  near: number;
}

export interface SharedViewOptions {
  shadeMode: SharedShadeMode;
  cage: boolean;
  viewGrid: boolean;
  orientation: boolean;
  courseGuide: boolean;
  normals: boolean;
  aiPaths: boolean;
  props: boolean;
  tricks: boolean;
  effects: boolean;
  sources: boolean;
  propLights: boolean;
  sun: boolean;
  skybox: boolean;
}

/** The client-owned part of a screen frame. Project/reference identity is taken from its server session. */
export interface SharedScreenState {
  /** The sharer's terrain pointer, routed only to active observers with the rest of this frame. */
  cursor: [number, number, number] | null;
  view: SharedCameraView;
  options: SharedViewOptions;
}

/** One server-authenticated frame delivered to an observer. */
export interface SharedScreenFrame extends SharedScreenState {
  sessionId: string;
  userId: string;
  username: string;
  projectId: string;
  referenceLevel: string | null;
}

const finite = (value: unknown, min: number, max: number): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, value));
};

const vector = (value: unknown): [number, number, number] | null => {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const x = finite(value[0], -10_000_000, 10_000_000);
  const y = finite(value[1], -10_000_000, 10_000_000);
  const z = finite(value[2], -10_000_000, 10_000_000);
  return x === null || y === null || z === null ? null : [x, y, z];
};

/** Narrow an untrusted socket payload to the bounded, JSON-safe state the browser can apply. */
export function sanitizeSharedScreenState(value: unknown): SharedScreenState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as { cursor?: unknown; view?: unknown; options?: unknown };
  if (!input.view || typeof input.view !== 'object' || !input.options || typeof input.options !== 'object') {
    return null;
  }
  const view = input.view as Record<string, unknown>;
  const options = input.options as Record<string, unknown>;
  const cursor = input.cursor == null ? null : vector(input.cursor);
  const pos = vector(view.pos), target = vector(view.target);
  const up = view.up == null ? [0, 1, 0] as [number, number, number] : vector(view.up);
  const zoom = finite(view.zoom, 0.0001, 100_000);
  const orthoHalfH = finite(view.orthoHalfH, 0.001, 10_000_000);
  const fov = finite(view.fov ?? 55, 1, 179);
  const near = finite(view.near ?? 0.5, 0.001, 100);
  const shadeMode = options.shadeMode;
  // Frames from before the global Skybox view existed imply its default-on state during a rolling update.
  const skybox = options.skybox ?? true;
  const booleanKeys = [
    'cage', 'viewGrid', 'orientation', 'courseGuide', 'normals', 'aiPaths', 'props', 'tricks',
    'effects', 'sources', 'propLights', 'sun',
  ] as const;
  if ((input.cursor != null && !cursor) || !pos || !target || !up
    || Math.hypot(up[0], up[1], up[2]) < 1e-6
    || zoom === null || orthoHalfH === null || fov === null || near === null
    || typeof view.ortho !== 'boolean'
    || (shadeMode !== 'textured' && shadeMode !== 'surface' && shadeMode !== 'none')
    || booleanKeys.some(key => typeof options[key] !== 'boolean') || typeof skybox !== 'boolean') return null;
  return {
    cursor,
    view: { pos, target, up, ortho: view.ortho, zoom, orthoHalfH, fov, near },
    options: {
      shadeMode,
      cage: options.cage as boolean,
      viewGrid: options.viewGrid as boolean,
      orientation: options.orientation as boolean,
      courseGuide: options.courseGuide as boolean,
      normals: options.normals as boolean,
      aiPaths: options.aiPaths as boolean,
      props: options.props as boolean,
      tricks: options.tricks as boolean,
      effects: options.effects as boolean,
      sources: options.sources as boolean,
      propLights: options.propLights as boolean,
      sun: options.sun as boolean,
      skybox,
    },
  };
}
