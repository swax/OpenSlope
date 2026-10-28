import type { PropAlphaMode } from '../reference/props';

/** Pure pixel classification and material policy shared by viewport previews and portable exports. */
export type AlphaClass = 'clear' | 'cutout' | 'translucent' | 'opaque-alpha' | 'unknown';
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

/** The same histogram and glow-sheet signature Snowknife records in its bundle manifest. Keeping this pure
 * lets render-state tests exercise the decision without a browser image decoder. */
export function analyzeTexturePixels(data: ArrayLike<number>, width: number, height: number): TextureAlphaAnalysis {
  const total = Math.min(Math.max(0, width * height), Math.floor(data.length / 4));
  if (!total) return { kind: 'unknown', glow: false };
  let clear = 0,
    solid = 0;
  for (let pixel = 0; pixel < total; pixel++) {
    const a = data[pixel * 4 + 3];
    if (a < 8) clear++;
    else if (a >= 250) solid++;
  }
  const middle = total - clear - solid;
  // Helper pages and blank animation frames need to discard their hidden RGB and depth.
  if (clear === total) return { kind: 'clear', glow: false };
  const cutout = clear * 1000 >= total * 3 && solid > 0;
  const kind: AlphaClass = cutout ? 'cutout' : middle * 5 >= total ? 'translucent' : 'opaque-alpha';
  if (!cutout) return { kind, glow: false };

  // Glow sheets are bright, smooth alpha ramps over a transparent background. The thresholds sit in the
  // measured gaps documented by Snowknife/TextureBundle and Unity/docs/005.
  let visible = 0,
    partial = 0,
    gradient = 0,
    pairs = 0,
    weightedBrightness = 0,
    alphaWeight = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (pixel >= total) continue;
      const at = pixel * 4,
        a = data[at + 3];
      if (a >= 8) {
        visible++;
        if (a < 250) partial++;
        weightedBrightness += Math.max(data[at], data[at + 1], data[at + 2]) * a;
        alphaWeight += a;
      }
      if (x + 1 < width && pixel + 1 < total) {
        const other = data[at + 7];
        if (a >= 8 || other >= 8) {
          gradient += Math.abs(a - other);
          pairs++;
        }
      }
      if (y + 1 < height && pixel + width < total) {
        const other = data[at + width * 4 + 3];
        if (a >= 8 || other >= 8) {
          gradient += Math.abs(a - other);
          pairs++;
        }
      }
    }
  const glow =
    visible > 0 &&
    pairs > 0 &&
    alphaWeight > 0 &&
    partial / visible >= 0.6 &&
    gradient / pairs < 25 &&
    weightedBrightness / alphaWeight >= 128;
  return { kind, glow };
}

/** Resolve texture facts through the material policy, then aggregate a flipbook with cutout precedence. */
export function resolvePropAlphaMode(
  analyses: readonly (TextureAlphaAnalysis | undefined)[],
  policy: TextureAlphaPolicy,
): TextureAlphaMode {
  if (policy.mode) return policy.mode;
  const fallback: TextureAlphaMode = policy.alphaPass
    ? 'blend'
    : policy.pixelAlpha || policy.priority
      ? 'cutout'
      : 'opaque';
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
  // Empty frames do not turn a translucent/glow animation into a cutout. A wholly
  // clear alpha-enabled material still clips; native opaque policy remains authoritative.
  const visibleFrames = analyses.filter(analysis => analysis?.kind !== 'clear');
  const modes: TextureAlphaMode[] = visibleFrames.length
    ? visibleFrames.map(modeOf)
    : analyses.length && (policy.alphaPass || policy.pixelAlpha || policy.priority)
      ? ['cutout']
      : [fallback];
  return modes.includes('cutout')
    ? 'cutout'
    : modes.includes('glow')
      ? 'glow'
      : modes.includes('blend')
        ? 'blend'
        : 'opaque';
}
