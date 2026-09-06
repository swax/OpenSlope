import { makeTexRef } from '../../core/paint/textures';
import type { PropAlphaMode } from '../../core/reference/props';
import { textureUrl } from '../net/asset-paths';
import * as THREE from 'three';

/**
 * Cutout vs translucent among alpha-pass materials is a TEXTURE property, not a flag
 * ([Trailmap: 170-materials]): the appearance word's bit 18 only says "composite with the texture's
 * alpha"; whether that means alpha-TEST holes (leaves, fences, banners) or alpha-BLEND translucency
 * (water, glass, LCDs) is decided by the alpha channel's content — a hard transparent/opaque hole mask
 * vs a smooth partial band. Some alpha-pass textures carry fully opaque alpha (the GARI Radiotower
 * walls): they take the blend path but read solid. This mirrors the read the Unity importer's
 * AlphaClassifier does; classified once per texture from the served PNG, cached for the session.
 */
export type AlphaClass = 'cutout' | 'translucent' | 'opaque-alpha' | 'unknown';
export type TextureAlphaMode = PropAlphaMode;

/** Pixel facts kept separate from material policy. A soft light halo is hole-shaped too; only an
 * alpha-pass prop may reinterpret that cutout-looking histogram as `glow`. Terrain and priority decals
 * keep treating it as an ordinary cutout, matching Snowknife's TextureBundle policy. */
export interface TextureAlphaAnalysis {
  kind: AlphaClass;
  glow: boolean;
}

export interface TextureAlphaPolicy {
  /** Explicit glTF/author/sidecar verdict. It is the final authority when present. */
  mode?: TextureAlphaMode;
  /** Native appearance-word bit 18: the texture participates in the alpha object pass. */
  alphaPass?: boolean;
  /** Native appearance-word bit 17: a priority decal whose hole mask still alpha-tests. */
  priority?: boolean;
  /** Slopesmith-authored/imported material: its zero native flag word is neutral, so pixels decide. */
  pixelAlpha?: boolean;
}

/** UI wording for a classified alpha-pass surface. */
export function alphaClassLabel(c: AlphaClass): string {
  return c === 'cutout' ? 'cutout — alpha-test holes'
    : c === 'translucent' ? 'translucent — alpha blend'
      : c === 'opaque-alpha' ? 'alpha pass — opaque alpha (reads solid)'
        : 'alpha pass';
}

/** A glow sheet has a cutout-like histogram, but native alpha-pass policy blends its smooth halo. */
export function alphaAnalysisLabel(analysis: TextureAlphaAnalysis, alphaPass = false): string {
  return alphaPass && analysis.kind === 'cutout' && analysis.glow
    ? 'glow — alpha blend'
    : alphaClassLabel(analysis.kind);
}

const analysisCache = new Map<string, Promise<TextureAlphaAnalysis>>();

// The default framebuffer's sample count is fixed when WebGL creates it, so this preference is installed once
// at app boot before any prop material is built. Alpha-to-coverage keeps the cutout in the opaque/depth-writing
// pass while turning a texture's alpha into MSAA sample coverage — Unity's smooth alternative to alpha hash.
let cutoutAlphaToCoverage = false;

export function setCutoutAlphaToCoverage(enabled: boolean): void {
  cutoutAlphaToCoverage = enabled;
}

/** The same histogram and glow-sheet signature Snowknife records in its bundle manifest. Keeping this pure
 * lets render-state tests exercise the decision without a browser image decoder. */
export function analyzeTexturePixels(data: ArrayLike<number>, width: number, height: number): TextureAlphaAnalysis {
  const total = Math.min(Math.max(0, width * height), Math.floor(data.length / 4));
  if (!total) return { kind: 'unknown', glow: false };
  let clear = 0, solid = 0;
  for (let pixel = 0; pixel < total; pixel++) {
    const a = data[pixel * 4 + 3];
    if (a < 8) clear++;
    else if (a >= 250) solid++;
  }
  const middle = total - clear - solid;
  const cutout = clear * 1000 >= total * 3 && solid > 0;
  const kind: AlphaClass = cutout ? 'cutout' : middle * 5 >= total ? 'translucent' : 'opaque-alpha';
  if (!cutout) return { kind, glow: false };

  // Glow sheets are bright, smooth alpha ramps over a transparent background. The thresholds sit in the
  // measured gaps documented by Snowknife/TextureBundle and Unity/docs/005.
  let visible = 0, partial = 0, gradient = 0, pairs = 0, weightedBrightness = 0, alphaWeight = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x;
    if (pixel >= total) continue;
    const at = pixel * 4, a = data[at + 3];
    if (a >= 8) {
      visible++;
      if (a < 250) partial++;
      weightedBrightness += Math.max(data[at], data[at + 1], data[at + 2]) * a;
      alphaWeight += a;
    }
    if (x + 1 < width && pixel + 1 < total) {
      const other = data[at + 7];
      if (a >= 8 || other >= 8) { gradient += Math.abs(a - other); pairs++; }
    }
    if (y + 1 < height && pixel + width < total) {
      const other = data[at + width * 4 + 3];
      if (a >= 8 || other >= 8) { gradient += Math.abs(a - other); pairs++; }
    }
  }
  const glow = visible > 0 && pairs > 0 && alphaWeight > 0
    && partial / visible >= 0.60 && gradient / pairs < 25 && weightedBrightness / alphaWeight >= 128;
  return { kind, glow };
}

/** Analyze a decoded browser image synchronously. TextureLoader has already made it same-origin by the time
 * the viewport calls this; callers still catch a canvas/security failure and retain their safe fallback. */
export function analyzeTextureImage(image: CanvasImageSource): TextureAlphaAnalysis {
  const sized = image as CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  const width = sized.naturalWidth || sized.width || 0;
  const height = sized.naturalHeight || sized.height || 0;
  if (!width || !height) return { kind: 'unknown', glow: false };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { kind: 'unknown', glow: false };
  context.drawImage(image, 0, 0);
  return analyzeTexturePixels(context.getImageData(0, 0, width, height).data, width, height);
}

/** Resolve texture facts through the material policy, then aggregate a flipbook with cutout precedence. */
export function resolvePropAlphaMode(
  analyses: readonly (TextureAlphaAnalysis | undefined)[], policy: TextureAlphaPolicy,
): TextureAlphaMode {
  if (policy.mode) return policy.mode;
  const fallback: TextureAlphaMode = policy.alphaPass ? 'blend'
    : policy.pixelAlpha || policy.priority ? 'cutout' : 'opaque';
  const modeOf = (analysis: TextureAlphaAnalysis | undefined): TextureAlphaMode => {
    if (!analysis || analysis.kind === 'unknown') return fallback;
    if (policy.pixelAlpha) {
      if (analysis.kind === 'cutout') return 'cutout';
      return analysis.kind === 'translucent' ? 'blend' : 'opaque';
    }
    if (policy.alphaPass) {
      if (analysis.kind === 'cutout') return analysis.glow ? 'glow' : 'cutout';
      // Opaque-looking alpha still uses the native alpha pass (e.g. GARI Radiotower).
      return 'blend';
    }
    if (policy.priority) {
      if (analysis.kind === 'cutout') return 'cutout';
      return analysis.kind === 'translucent' ? 'blend' : 'opaque';
    }
    return 'opaque';
  };
  const modes = analyses.length ? analyses.map(modeOf) : [fallback];
  return modes.includes('cutout') ? 'cutout'
    : modes.includes('glow') ? 'glow'
      : modes.includes('blend') ? 'blend' : 'opaque';
}

/** Apply the framebuffer state shared by prop, terrain-array, and thumbnail materials. With the default-on MSAA
 * preference, cutouts use Unity-style alpha-to-coverage. The opt-out uses Three's stable alpha hash as its
 * single-sample equivalent: partial edge texels become depth-writing spatial coverage while true holes vanish. */
export function applyTextureAlphaMode(material: THREE.Material, mode: TextureAlphaMode, sheet = false): void {
  const transparent = mode === 'blend' || mode === 'glow';
  const coverage = mode === 'cutout' && cutoutAlphaToCoverage;
  // In coverage mode alpha must survive into the fragment output: WebGL's sample mask consumes the continuous
  // value directly. Three deliberately keeps that alpha for a non-transparent alphaToCoverage material.
  const alphaTest = mode === 'glow' || (mode === 'cutout' && !coverage) ? 0.05 : 0;
  const depthWrite = mode === 'blend' ? !sheet : true;
  const alphaHash = mode === 'cutout' && !coverage;
  if (material.transparent === transparent && material.alphaTest === alphaTest
    && material.depthWrite === depthWrite && material.alphaHash === alphaHash
    && material.alphaToCoverage === coverage) return;
  material.transparent = transparent;
  material.alphaTest = alphaTest;
  material.depthWrite = depthWrite;
  material.alphaHash = alphaHash;
  material.alphaToCoverage = coverage;
  material.needsUpdate = true;
}

/** Terrain never blends. A hole-shaped page clips; every other page remains opaque. */
export function terrainAlphaMode(analysis: TextureAlphaAnalysis | undefined): TextureAlphaMode {
  return analysis?.kind === 'cutout' ? 'cutout' : 'opaque';
}

/** Classify a texture's alpha channel with Snowknife's measured thresholds: a bimodal clear+solid mask is
 * cutout; otherwise a substantial partial-alpha band is translucent; the remainder reads opaque. */
export function analyzeTextureAlpha(level: string, file: string): Promise<TextureAlphaAnalysis> {
  const key = makeTexRef(level, file);
  let pending = analysisCache.get(key);
  if (!pending) {
    pending = new Promise<TextureAlphaAnalysis>(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          resolve(analyzeTextureImage(img));
        } catch {
          resolve({ kind: 'unknown', glow: false }); // a taint/decode failure retains the material fallback
        }
      };
      img.onerror = () => resolve({ kind: 'unknown', glow: false });
      img.src = textureUrl(level, file);
    });
    analysisCache.set(key, pending);
  }
  return pending;
}

export function classifyTextureAlpha(level: string, file: string): Promise<AlphaClass> {
  return analyzeTextureAlpha(level, file).then(analysis => analysis.kind);
}

/** Project-local refs keep the same logical name across mountains; their pixels and verdict must not. */
export function invalidateTextureAlphaLevel(level: string): void {
  const prefix = `${level}/`.toLowerCase();
  for (const key of analysisCache.keys()) if (key.toLowerCase().startsWith(prefix)) analysisCache.delete(key);
}
