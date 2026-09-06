import type { V3 } from '../../core/doc/types';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { GizmoFrame, Mode, RotationSnapStep, ShadeMode, SnapStep, ViewState } from '../viewport/viewport';
import type { DrawDistance } from '../viewport/scene/range-cull';
import type { XrEyeBufferMeasurement, XrLayerMode } from '../ride/xr/config';
import type { RideGear, SnowboardStance } from '../ride/gear';

/**
 * localStorage persistence for the editor session: the storage keys, the typed shapes saved under them, the
 * one-shot loaders (used at module boot, before any service exists — hence plain functions), and a
 * `createPersistence` factory whose four writers pull the live values through injected getters. Every write is
 * wrapped so a full / disabled store degrades to "not saved" rather than throwing.
 */

export const MOUNTAIN_KEY = 'slopesmith-mountain-v1';
export const VIEW_KEY = 'slopesmith-view-v1'; // camera framing, restored on reload so a refresh keeps the current view
export const REF_KEY = 'slopesmith-ref-v1';   // the loaded reference level (+ its placement offset), re-loaded on reload
export const UI_KEY = 'slopesmith-ui-v1';     // editor mode + view toggles (shading, cage, XYZ grid), restored on reload
export const PINS_KEY = 'slopesmith-mountain-pins-v1'; // mountains pinned to the top of the stats comparison

export interface StoredUi { mode: Mode; cageOn: boolean; viewGrid: boolean; viewGridStep: SnapStep; snapOn: boolean; snapStep: SnapStep; rotationSnapStep: RotationSnapStep; shadeMode: ShadeMode; fOverlay: boolean; courseGuide: boolean; normals: boolean; aiPaths: boolean; propsVisible: boolean; collisionOverlay: boolean; worldEffects: boolean; lightRig: boolean; propLights: boolean; skybox: boolean; tricks: boolean; textureLib: boolean; propLib: boolean; playTarget: 'authored' | 'reference'; playRiderModel: string; playRiderStyle: string; playRideGear: RideGear; playSnowboardStance: SnowboardStance; playRaceMode: 'race' | 'showoff' | 'freeride'; /** Legacy pre-count toggle, read only while migrating an older saved UI. */ playAi?: boolean; playAiPaths: boolean; /** Zero disables AI; positive values are the field cap. */ playAiMax: number; playCountdown: boolean; playSnow: number; playMusic: boolean; playGameVolume: number; playTelemetry: boolean; playBoardFx: boolean; playColliders: boolean; playSmoothCutouts: boolean; playVrRenderScale: number; playVrEyeBuffer: XrEyeBufferMeasurement | null; playVrLayerMode: XrLayerMode; playVrStats: boolean; playDrawDistance: DrawDistance; gizmoFrame: GizmoFrame }
export interface StoredRef { level: string; offset?: V3 }
/** Which mountains the stats comparison floats to the top. An object rather than a bare array so the entry can
 *  grow a field without every older browser's copy reading as corrupt. */
export interface StoredPins { levels: string[] }

export function loadStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch { /* fall through to default */ }
  return null;
}

/** Write one entry, degrading to "not saved" on a full or disabled store — the same bargain every writer in
 *  `createPersistence` makes. For state that changes on a click rather than at page unload. */
export function saveStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full / disabled */ }
}

/** A stored view is usable only if its vectors and scalars are all finite (guards a corrupt / stale entry
 *  from feeding NaNs into the camera, which would blank the viewport). */
export function isValidView(v: ViewState | null): v is ViewState {
  const vec3 = (a: unknown): a is number[] => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  return !!v && vec3(v.pos) && vec3(v.target) && Number.isFinite(v.zoom) && Number.isFinite(v.orthoHalfH);
}

export function createPersistence(deps: {
  getDoc: () => EditDoc;
  getView: () => ViewState;
  getUi: () => StoredUi;
  getRef: () => StoredRef | null;
}) {
  /** Persist the live doc (incl. its sun + bake-exposure/ambient overrides) to the recovery copy. The sun is
   *  mutated OUTSIDE the geometry-rebuild path (applySunLight / useReferenceLight), so it writes here
   *  immediately. Its caller separately notifies the durable project/register transports for a user edit;
   *  otherwise the disk project, which wins at boot, would replace this recovery copy on refresh. */
  function persistDoc() {
    try { localStorage.setItem(MOUNTAIN_KEY, JSON.stringify(deps.getDoc())); } catch { /* storage full / disabled */ }
  }

  /** Save the current camera framing so a page reload restores the same view (see Viewport.serializeView).
   *  The view changes every frame while flying / orbiting / zooming, so we don't write on each change — only
   *  when the page is being hidden / unloaded (pagehide covers desktop refresh and mobile background). */
  function persistView() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(deps.getView())); } catch { /* storage full / disabled */ }
  }

  /** Save the editor mode + global view toggles (surface / textures / cage-only shading, control cage,
   *  XYZ grid, F overlay) so a reload restores the same working state. Focused Edit sub-cages are transient. */
  function persistUi() {
    try { localStorage.setItem(UI_KEY, JSON.stringify(deps.getUi())); } catch { /* storage full / disabled */ }
  }

  /** Remember (or, with no loaded reference, forget) which reference level is loaded, so a reload re-loads it.
   *  The level name + the reference's placement offset are stored (the mesh itself is re-fetched from the
   *  dev server), so a refresh restores where the reference was moved to. */
  function persistRef() {
    const ref = deps.getRef();
    try {
      if (ref) localStorage.setItem(REF_KEY, JSON.stringify(ref));
      else localStorage.removeItem(REF_KEY);
    } catch { /* storage full / disabled */ }
  }

  return { persistDoc, persistView, persistUi, persistRef };
}
