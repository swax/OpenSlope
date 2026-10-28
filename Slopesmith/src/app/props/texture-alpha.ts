import { makeTexRef } from '../../core/paint/textures';
import {
  analyzeTexturePixels,
  type AlphaClass,
  type TextureAlphaAnalysis,
  type TextureAlphaMode,
} from '../../core/props/texture-alpha';
import { textureUrl } from '../net/asset-paths';
import * as THREE from 'three';

export { analyzeTexturePixels, resolvePropAlphaMode } from '../../core/props/texture-alpha';
export type {
  AlphaClass,
  TextureAlphaAnalysis,
  TextureAlphaMode,
  TextureAlphaPolicy,
} from '../../core/props/texture-alpha';
/** UI wording for a classified alpha-pass surface. */
export function alphaClassLabel(c: AlphaClass): string {
  return c === 'clear'
    ? 'fully transparent alpha'
    : c === 'cutout'
      ? 'cutout — alpha-test holes'
      : c === 'translucent'
        ? 'translucent — alpha blend'
        : c === 'opaque-alpha'
          ? 'alpha pass — opaque alpha (reads solid)'
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

/** Analyze a decoded browser image synchronously. TextureLoader has already made it same-origin by the time
 * the viewport calls this; callers still catch a canvas/security failure and retain their safe fallback. */
export function analyzeTextureImage(image: CanvasImageSource): TextureAlphaAnalysis {
  const sized = image as CanvasImageSource & {
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
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
  if (
    material.transparent === transparent &&
    material.alphaTest === alphaTest &&
    material.depthWrite === depthWrite &&
    material.alphaHash === alphaHash &&
    material.alphaToCoverage === coverage
  )
    return;
  material.transparent = transparent;
  material.alphaTest = alphaTest;
  material.depthWrite = depthWrite;
  material.alphaHash = alphaHash;
  material.alphaToCoverage = coverage;
  material.needsUpdate = true;
}

/** Terrain never blends. Clear and hole-shaped pages clip; other pages remain opaque. */
export function terrainAlphaMode(analysis: TextureAlphaAnalysis | undefined): TextureAlphaMode {
  return analysis?.kind === 'clear' || analysis?.kind === 'cutout' ? 'cutout' : 'opaque';
}

/** Classify a texture's alpha channel: fully clear pages, bimodal cutout masks,
 * substantial partial-alpha bands, and opaque alpha. */
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
