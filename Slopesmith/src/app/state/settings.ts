import { DEFAULT_FAL_3D_MODEL, DEFAULT_FAL_INPAINT_MODEL, DEFAULT_FAL_MODEL, GEN_SIZES, STORE_SIZES, fal3dDetail, fal3dModel, falInpaintModel } from '../../core/paint/fal-models';
import { DEFAULT_VIDEO_BRIDGE_SERVER, normalizeVideoBridgeServer } from '../net/video-bridge';
import type { VideoBridgePrefs } from '../net/video-bridge-contract';

/**
 * Editor settings: the preferences that belong to the PERSON rather than to a mountain, so they live in
 * localStorage beside the session state (storage.ts) instead of in the .slope.json a document saves. Today
 * that is the fal.ai API key the Generate texture flow needs, generator choices worth remembering between
 * runs, and the optional local video bridge used by the shared Jukebox video surfaces.
 *
 * Secrets are held in localStorage on purpose, and that is also what makes them per-person rather than
 * per-server: Slopesmith has a project service but no account-backed secret store. The fal key is sent with
 * that member's own generation request and never written by the server (docs/033); Yattee Basic credentials
 * go directly from this browser to that member's configured bridge (docs/063). Anyone with the browser
 * profile can read either, exactly like a key pasted into a local .env.
 */

export const SETTINGS_KEY = 'slopesmith-settings-v1';

export interface TexGenPrefs {
  model: string;
  /** The inpainting model behind the dialog's Transition and Decal tabs. */
  inpaintModel: string;
  /** Edge of the image asked of fal (drives both detail and price). */
  genSize: number;
  /** Edge the tile is stored at once generated. */
  storeSize: number;
  /** Run the wrap-offset blend that makes the result actually tile (New texture tab only). */
  seamless: boolean;
  /** Transition tab: spend a second inpaint call healing the strip's wrap seam. */
  vwrapPass: boolean;
  /** Transition tab: stack A above C (the blend strip runs horizontally) instead of side by side. */
  transVertical: boolean;
}

export interface SkyGenPrefs {
  /** Text-to-image model behind the Generate skybox dialog (drawn from the same FAL_MODELS catalogue). */
  model: string;
  /** Spend a flat-priced Hunyuan World call turning the 2:1 view into a true 360° panorama. */
  pano: boolean;
}

export interface PropGenPrefs {
  /** Concept-image model behind the Generate prop dialog (the same FAL_MODELS catalogue). */
  imageModel: string;
  /** The image-to-3D model that builds the mesh (FAL_3D_MODELS). */
  meshModel: string;
  /** The chosen model's detail level (Rodin's quality tiers / Sketch); '' when it offers no menu. */
  meshDetail: string;
  /** Longest side, in editor metres, an imported generated model is scaled to — a generated mesh arrives
   *  normalized, so its authored scale means nothing. */
  sizeM: number;
}

export type { VideoBridgePrefs } from '../net/video-bridge-contract';
export interface EditorSettings {
  falKey: string;
  texGen: TexGenPrefs;
  skyGen: SkyGenPrefs;
  propGen: PropGenPrefs;
  videoBridge: VideoBridgePrefs;
}

const DEFAULTS: EditorSettings = {
  falKey: '',
  texGen: { model: DEFAULT_FAL_MODEL, inpaintModel: DEFAULT_FAL_INPAINT_MODEL, genSize: 512, storeSize: 128, seamless: true, vwrapPass: true, transVertical: false },
  skyGen: { model: DEFAULT_FAL_MODEL, pano: false },
  propGen: { imageModel: DEFAULT_FAL_MODEL, meshModel: DEFAULT_FAL_3D_MODEL, meshDetail: '', sizeM: 3 },
  videoBridge: { enabled: true, serverUrl: DEFAULT_VIDEO_BRIDGE_SERVER, username: '', password: '' },
};

export const SETTINGS_CHANGED_EVENT = 'slopesmith:settings-changed';

const defaultSettings = (): EditorSettings => ({
  ...DEFAULTS,
  texGen: { ...DEFAULTS.texGen },
  skyGen: { ...DEFAULTS.skyGen },
  propGen: { ...DEFAULTS.propGen },
  videoBridge: { ...DEFAULTS.videoBridge },
});

/** Read the stored settings, filling anything missing or corrupt from the defaults. Never throws: a
 *  disabled / full / half-written store degrades to "no settings yet" rather than breaking boot. */
export function loadSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const stored = JSON.parse(raw) as Partial<EditorSettings>;
    const texGen = { ...DEFAULTS.texGen, ...(stored.texGen ?? {}) };
    const skyGen = { ...DEFAULTS.skyGen, ...(stored.skyGen ?? {}) };
    const propGen = { ...DEFAULTS.propGen, ...(stored.propGen ?? {}) };
    const videoBridge = { ...DEFAULTS.videoBridge, ...(stored.videoBridge ?? {}) };
    const meshModel = fal3dModel(propGen.meshModel) ? propGen.meshModel : DEFAULTS.propGen.meshModel;
    let serverUrl = DEFAULTS.videoBridge.serverUrl;
    try {
      if (typeof videoBridge.serverUrl === 'string') serverUrl = normalizeVideoBridgeServer(videoBridge.serverUrl);
    } catch { /* malformed or retired stored value falls back without breaking editor boot */ }
    return {
      falKey: typeof stored.falKey === 'string' ? stored.falKey : '',
      texGen: {
        model: typeof texGen.model === 'string' ? texGen.model : DEFAULTS.texGen.model,
        // validated against the catalogue: a retired id would leave the Transition tab's <select> silently
        // showing (and billing) a model other than the one recorded
        inpaintModel: falInpaintModel(texGen.inpaintModel) ? texGen.inpaintModel : DEFAULTS.texGen.inpaintModel,
        // a stored size from an older build may no longer be offered — fall back rather than render a
        // <select> with no matching option, which would silently generate at the wrong size
        genSize: (GEN_SIZES as readonly number[]).includes(texGen.genSize) ? texGen.genSize : DEFAULTS.texGen.genSize,
        storeSize: (STORE_SIZES as readonly number[]).includes(texGen.storeSize) ? texGen.storeSize : DEFAULTS.texGen.storeSize,
        seamless: texGen.seamless !== false,
        vwrapPass: texGen.vwrapPass !== false,
        transVertical: texGen.transVertical === true,
      },
      skyGen: {
        model: typeof skyGen.model === 'string' ? skyGen.model : DEFAULTS.skyGen.model,
        pano: skyGen.pano === true,
      },
      propGen: {
        imageModel: typeof propGen.imageModel === 'string' ? propGen.imageModel : DEFAULTS.propGen.imageModel,
        // validated against the catalogue, like inpaintModel: a retired id would silently bill another model
        meshModel,
        // resolved against that model's own detail menu; '' when it offers none
        meshDetail: fal3dDetail(meshModel, propGen.meshDetail)?.id ?? '',
        sizeM: Number.isFinite(propGen.sizeM) && propGen.sizeM >= 0.1 && propGen.sizeM <= 100
          ? propGen.sizeM : DEFAULTS.propGen.sizeM,
      },
      videoBridge: {
        enabled: typeof videoBridge.enabled === 'boolean' ? videoBridge.enabled : DEFAULTS.videoBridge.enabled,
        serverUrl,
        username: typeof videoBridge.username === 'string' ? videoBridge.username : '',
        password: typeof videoBridge.password === 'string' ? videoBridge.password : '',
      },
    };
  } catch {
    return defaultSettings();
  }
}

/** Merge a patch into the stored settings and write it back. */
export function saveSettings(patch: Partial<EditorSettings>): EditorSettings {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* storage full / disabled */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: next }));
  return next;
}

/** The fal.ai key, or '' when none is set — the Generate flow's gate. */
export function falKey(): string { return loadSettings().falKey.trim(); }
