import * as THREE from 'three';

/**
 * WebGL2 ARRAY TEXTURES — the port of the Unity path's `Texture2DArray` collapse (Unity/docs/vrchat/
 * 025-performance.md), and the one thing that gets a draw call below "one per texture page".
 *
 * Geometry already merges twice over here: the reference quilt is one buffer split into cullable cells, and
 * static reference props go out through `BatchedMesh` (or a physical merge when the renderer has no
 * `WEBGL_multi_draw`). What could not merge was MATERIAL state: one draw carries one sampler, and every SSX
 * texture page is its own material, so a terrain cell holding eight tiles still submitted eight draws and the
 * prop batches bottomed out at one per page.
 *
 * An array texture removes that floor. Every page becomes a SLICE of one `sampler2DArray`, the slice index
 * rides a per-vertex attribute (`texArraySlice` — Unity puts the same number in `UV0.z`), and a cell or a prop
 * batch becomes ONE draw no matter how many pages it spans.
 *
 * **Why an array and not an atlas.** SSX UVs deliberately run past [0,1] to tile a page across a patch.
 * Rect-packing pages into one sheet breaks that: the wrap would run into the neighbour's pixels. Array slices
 * wrap independently — each layer is a whole texture with its own REPEAT — so tiling survives untouched. This
 * is exactly why `TextureArrayPacker` exists on the Unity side rather than an atlas packer.
 *
 * **Sizing.** A layer set must be one size, and shipped banks are not. The canonical size is the MODAL page
 * size (rounded up to a power of two, since `texStorage3D`'s mip level count must be integral): pages smaller
 * than it are resampled up into their slice, pages LARGER are excluded and keep their own material rather
 * than being blurred to fit. On GARI that reads 118 pages at 128x128, 17 at 64x64, 2 at 32x32 and one at
 * 256x128 — so canonical is 128x128, 137 of 138 pages join the bank, and the odd wide page costs one extra
 * draw only in the cells that actually use it. Resolution is a sharpness question and never a correctness
 * one: UVs are normalised, so a page's tiling is identical whatever slice size it lands in.
 */

/** Slices per array. WebGL2 guarantees `MAX_ARRAY_TEXTURE_LAYERS >= 256`; staying well under means a bank
 *  never depends on the headroom a particular driver happens to report. Banks past this split into several
 *  arrays — still a draw per ARRAY rather than per page. */
export const TEXTURE_ARRAY_MAX_LAYERS = 128;
/** Level-0 storage ceiling for one bank, before mips (which add ~1/3). A bank over budget halves its
 *  canonical size until it fits — a safety valve for an unusually large page set, not the normal path. */
export const TEXTURE_ARRAY_MAX_BYTES = 64 * 1024 * 1024;
/** Never resample below this: past it the tiling art stops reading at all, and one extra draw is cheaper. */
const MIN_CANONICAL = 32;

export interface TextureArrayPageSize {
  key: string;
  width: number;
  height: number;
}

export interface TextureArraySlot {
  /** Index into `TextureArrayPlan.arrays` / `TextureArrayBank.textures`. */
  array: number;
  /** Layer within that array. */
  slice: number;
}

export interface TextureArrayPlan {
  width: number;
  height: number;
  /** Page keys per array, in slice order. */
  arrays: string[][];
  slots: Map<string, TextureArraySlot>;
  /** Pages that keep their own material: too large for the canonical size, or never loaded. */
  excluded: string[];
}

const potCeil = (value: number): number => {
  let power = 1;
  while (power < value) power *= 2;
  return Math.max(1, power);
};

/**
 * Decide the canonical slice size and which page lands in which array layer — the whole bank decision, kept
 * free of any canvas or GPU so it can be checked directly.
 *
 * Pages are assigned in the order given and NEVER reordered, because callers rely on that: the terrain's
 * chunk groups are emitted in texture-slot order, so slot order matching array order is what lets adjacent
 * groups merge into one draw range instead of interleaving arrays.
 */
export function planTextureArrayBank(
  pages: readonly TextureArrayPageSize[],
  opts: { maxLayers?: number; maxBytes?: number } = {},
): TextureArrayPlan {
  const maxLayers = Math.max(1, opts.maxLayers ?? TEXTURE_ARRAY_MAX_LAYERS);
  const maxBytes = Math.max(1, opts.maxBytes ?? TEXTURE_ARRAY_MAX_BYTES);
  const usable = pages.filter(page => page.width > 0 && page.height > 0
    && Number.isFinite(page.width) && Number.isFinite(page.height));

  const empty: TextureArrayPlan = {
    width: 0, height: 0, arrays: [], slots: new Map(), excluded: pages.map(page => page.key),
  };
  if (!usable.length) return empty;

  // Modal size wins, ties broken toward the larger page: the common case is one size with a short tail, and
  // sizing to the tail would either blur the majority or multiply the bank's memory for no visible gain.
  const counts = new Map<string, { width: number; height: number; count: number }>();
  for (const page of usable) {
    const key = `${page.width}x${page.height}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { width: page.width, height: page.height, count: 1 });
  }
  let modal = { width: 0, height: 0, count: -1 };
  for (const entry of counts.values()) {
    if (entry.count > modal.count
      || (entry.count === modal.count && entry.width * entry.height > modal.width * modal.height)) modal = entry;
  }

  // Two sizes, and the difference matters. `limit` decides MEMBERSHIP — a page bigger than the modal size is
  // an outlier the level author chose to ship sharper, so it keeps its own material rather than being blurred
  // into the bank. `width`/`height` decide STORAGE, and may fall below the modal size when an unusually large
  // page set would blow the memory budget: that is a uniform loss across a bank that would otherwise not
  // exist at all, and it must not be read back as a membership test or the halving would exclude everything.
  const limitWidth = potCeil(modal.width);
  const limitHeight = potCeil(modal.height);
  let width = limitWidth;
  let height = limitHeight;
  while (width > MIN_CANONICAL && height > MIN_CANONICAL
    && usable.length * width * height * 4 > maxBytes) { width /= 2; height /= 2; }

  const arrays: string[][] = [];
  const slots = new Map<string, TextureArraySlot>();
  const excluded: string[] = [];
  const sized = new Map(usable.map(page => [page.key, page]));
  for (const page of pages) {
    const size = sized.get(page.key);
    if (!size || size.width > limitWidth || size.height > limitHeight) { excluded.push(page.key); continue; }
    let array = arrays.length - 1;
    if (array < 0 || arrays[array].length >= maxLayers) { arrays.push([]); array = arrays.length - 1; }
    slots.set(page.key, { array, slice: arrays[array].length });
    arrays[array].push(page.key);
  }
  if (!slots.size) return empty;
  return { width, height, arrays, slots, excluded };
}

export interface TextureArrayBank {
  plan: TextureArrayPlan;
  textures: THREE.DataArrayTexture[];
  dispose(): void;
}

export type TextureArrayImage = CanvasImageSource & { width: number; height: number };

/** Three r185 deliberately types Texture.image as unknown. Narrow the browser image sources used by the
 *  array packer at the boundary instead of scattering unchecked casts through its callers. */
export function asTextureArrayImage(value: unknown): TextureArrayImage | null {
  if (!value || typeof value !== 'object') return null;
  const sized = value as { width?: unknown; height?: unknown };
  return typeof sized.width === 'number' && sized.width > 0
    && typeof sized.height === 'number' && sized.height > 0
    ? value as TextureArrayImage
    : null;
}

/**
 * Can a bank be packed here at all? Packing goes through a 2D canvas, so it needs a document — which the
 * headless checks and any small embedder do not have. Asked BEFORE the page downloads rather than after,
 * because those callers cannot fetch an image either. (WebGL2 itself is not in question: three r165 dropped
 * WebGL1, so every renderer this runs on has array textures.)
 */
export function canPackTextureArrays(): boolean {
  return typeof document !== 'undefined';
}

export interface TextureArrayBuildOpts {
  /** True writes each page's rows bottom-up, matching `Texture.flipY = true` (the prop-model convention);
   *  false keeps image order, matching the terrain tiles' `flipY = false`. The GPU flag cannot do this job:
   *  WebGL2 rejects `UNPACK_FLIP_Y_WEBGL` on a `texImage3D` taking an ArrayBufferView, so the bank flips
   *  while it packs and the texture itself always ships `flipY = false`. */
  flipY?: boolean;
  /**
   * Bleed opaque colour outward into fully transparent texels before packing.
   *
   * Canvas 2D stores premultiplied, so `getImageData` cannot recover the colour under `alpha = 0` and hands
   * back black there. Bilinear filtering then blends toward that black at a cutout's edge and prop art grows
   * a dark fringe. Dilating repairs it, and does slightly better than the direct-upload path it replaces,
   * which carried whatever the exporter happened to leave under the transparent pixels.
   */
  dilateAlpha?: boolean;
  anisotropy?: number;
}

/**
 * Pack the loaded page images into `DataArrayTexture`s per the plan. Returns null off a browser (no canvas)
 * or when the plan holds nothing — callers keep their per-page materials in either case, so an unavailable
 * bank costs draw calls and never correctness.
 */
export function buildTextureArrayBank(
  plan: TextureArrayPlan,
  image: (key: string) => TextureArrayImage | null,
  opts: TextureArrayBuildOpts = {},
): TextureArrayBank | null {
  if (!plan.arrays.length || !canPackTextureArrays()) return null;
  const { width, height } = plan;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const textures: THREE.DataArrayTexture[] = [];
  for (const keys of plan.arrays) {
    const layer = width * height * 4;
    const data = new Uint8Array(layer * keys.length);
    for (let slice = 0; slice < keys.length; slice++) {
      const source = image(keys[slice]);
      if (!source) continue; // leaves the slice transparent; the page was planned in but never arrived
      ctx.clearRect(0, 0, width, height);
      // An integer upscale is exact replication, so keep it crisp; anything else needs the smooth filter.
      ctx.imageSmoothingEnabled = !(width % source.width === 0 && height % source.height === 0);
      ctx.drawImage(source, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      if (opts.dilateAlpha) dilateTransparent(pixels, width, height);
      const base = slice * layer;
      if (opts.flipY) {
        const row = width * 4;
        for (let y = 0; y < height; y++)
          data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), base + y * row);
      } else data.set(pixels, base);
    }
    const texture = new THREE.DataArrayTexture(data, width, height, keys.length);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.colorSpace = THREE.SRGBColorSpace; // three then allocates SRGB8_ALPHA8 and the sample decodes
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; // per slice — the whole reason this is an array
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = opts.anisotropy ?? 4;
    texture.flipY = false; // see TextureArrayBuildOpts.flipY — the packing above already applied it
    texture.needsUpdate = true;
    textures.push(texture);
  }
  return {
    plan,
    textures,
    dispose() { for (const texture of textures) texture.dispose(); },
  };
}

/** One pass of nearest-opaque colour bleed into `alpha = 0` texels (see `dilateAlpha`). Alpha is untouched:
 *  only the colour those texels contribute to a bilinear blend changes. */
function dilateTransparent(pixels: Uint8ClampedArray, width: number, height: number): void {
  const source = pixels.slice();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    if (source[at + 3] !== 0) continue;
    let r = 0, g = 0, b = 0, found = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = (ny * width + nx) * 4;
      if (source[neighbour + 3] === 0) continue;
      r += source[neighbour]; g += source[neighbour + 1]; b += source[neighbour + 2]; found++;
    }
    if (!found) continue;
    pixels[at] = r / found; pixels[at + 1] = g / found; pixels[at + 2] = b / found;
  }
}

/**
 * Carry the per-vertex slice index to the fragment stage. `begin_vertex` is the anchor because every built-in
 * material's vertex shader includes it, and it sits after instancing/batching setup rather than inside it.
 */
export function textureArrayVertexShader(vertexShader: string): string {
  return vertexShader
    .replace('void main() {', 'attribute float texArraySlice;\nvarying float vTexArraySlice;\nvoid main() {')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvTexArraySlice = texArraySlice;');
}

/**
 * Sample the array instead of `map`. The material still binds a 1x1 stand-in as its `map` — that is what
 * makes three define `USE_MAP`, compute `vMapUv`, and emit the `map_fragment` this rewrites; the stand-in's
 * own sampler is then dead code the compiler drops.
 *
 * `floor(slice + 0.5)` rather than the raw varying: the value is constant across a triangle by construction
 * (every vertex of a patch or submesh carries the same page), so the round only guards interpolation's last
 * bit rather than papering over a real gradient.
 */
export function textureArrayFragmentShader(fragmentShader: string): string {
  const sample = THREE.ShaderChunk.map_fragment.replace(
    'vec4 sampledDiffuseColor = texture2D( map, vMapUv );',
    'vec4 sampledDiffuseColor = texture( uTexArray, vec3( vMapUv, floor( vTexArraySlice + 0.5 ) ) );',
  );
  return fragmentShader
    .replace('void main() {', 'uniform sampler2DArray uTexArray;\nvarying float vTexArraySlice;\nvoid main() {')
    .replace('#include <map_fragment>', sample);
}

/** Do both rewrites still bite? Every anchor is a three.js source string, so an upgrade that renamed one
 *  would otherwise leave the bank sampling its 1x1 stand-in — a whole level rendering flat white. */
export function textureArrayShaderApplies(): boolean {
  const vertex = textureArrayVertexShader('#include <begin_vertex>\nvoid main() {}');
  const fragment = textureArrayFragmentShader('#include <map_fragment>\nvoid main() {}');
  return THREE.ShaderChunk.map_fragment.includes('vec4 sampledDiffuseColor = texture2D( map, vMapUv );')
    && vertex.includes('attribute float texArraySlice;')
    && vertex.includes('vTexArraySlice = texArraySlice;')
    && fragment.includes('uniform sampler2DArray uTexArray;')
    && fragment.includes('texture( uTexArray, vec3( vMapUv, floor( vTexArraySlice + 0.5 ) ) )');
}

/** userData key marking a material as drawing through an array. Read by anything that has to rebuild a
 *  material from another one — a clay Surface-view stand-in, a merged-fallback variant — so the rebuild
 *  keeps sampling the bank instead of quietly reverting to the 1x1 stand-in. */
export const TEXTURE_ARRAY = 'textureArray';

let standIn: THREE.DataTexture | null = null;
/** The 1x1 white `map` every array material binds; see `textureArrayFragmentShader`. One shared instance:
 *  it carries no data of its own, and a per-material copy would only be something else to dispose. */
export function textureArrayStandIn(): THREE.DataTexture {
  if (!standIn) {
    standIn = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    standIn.needsUpdate = true;
  }
  return standIn;
}

/** Install the array sampler + slice plumbing on a material, preserving whatever `onBeforeCompile` it already
 *  carries (the terrain's back-face tint, a prop's PS2 shading) rather than replacing it. */
export function useTextureArray<T extends THREE.Material & { map: THREE.Texture | null }>(
  material: T, texture: THREE.DataArrayTexture, cacheKey: string,
): T {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.map = textureArrayStandIn();
  material.userData[TEXTURE_ARRAY] = texture;
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    shader.uniforms.uTexArray = { value: texture };
    shader.vertexShader = textureArrayVertexShader(shader.vertexShader);
    shader.fragmentShader = textureArrayFragmentShader(shader.fragmentShader);
  };
  material.customProgramCacheKey = function () { return `${previousKey.call(this)}|tex-array:${cacheKey}`; };
  return material;
}

/** The bank a material draws through, or null for an ordinary single-page material. */
export function materialTextureArray(material: THREE.Material): THREE.DataArrayTexture | null {
  return (material.userData[TEXTURE_ARRAY] as THREE.DataArrayTexture | undefined) ?? null;
}
