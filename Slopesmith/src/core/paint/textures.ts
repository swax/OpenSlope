/**
 * Texture list — the real extracted SSX texture files a cell can be painted with, in one flat list.
 * Nothing inferred and nothing grouped: a patch's SurfaceType is PHYSICS (ride feel), not the look,
 * so tiles are not sorted into snow/rock/ice buckets. The ride feel stamped alongside a painted tile
 * is chosen by hand in the palette (see docs/005). The per-tile `count` is just how many terrain
 * patches use it, so the most-used tiles sort to the top.
 */

/** A texture reference a cell can be painted with: "<LEVEL>/<file.png>", e.g. "SMOKEMTN/0019.png". */
export type TexRef = string;

/**
 * The synthetic logical "level" holding tiles in the open mountain's `assets/textures/`.
 *
 * It is not a shared folder, and the name is the only thing that suggests otherwise: `Custom/lamp.png`
 * resolves to *this* mountain's `assets/textures/lamp.png`, two mountains can each hold a different
 * `lamp.png`, and response-cache entries are prefixed by project id so they can never answer with each
 * other's bytes (`projectAssetCacheKey`). It replaced a genuinely shared `Maps/Custom` catalogue, and kept
 * the word.
 *
 * The word has to stay, because the ref is PERSISTED — in `quadTex`, in authored-model textures, in imported
 * prop records, in export manifests, in checkpoints — so the bank's name must be mountain-INDEPENDENT.
 * Naming it after the mountain would break every ref in a map the moment it was renamed, and a prop record
 * copied to another mountain would arrive naming a bank that is not there. "Custom" is the stable word for
 * "mine".
 *
 * What a person reads is a separate question, and the answer everywhere is *not* "Custom": the Texture
 * Library's bank combo shows the mountain's own name, prop material rows show the bare file name, and the
 * Blender add-on does the same (`_short_ref`). Reserve the literal for banks that are somebody else's.
 *
 * It stays out of the real-level lists (it is not a course, so it can never be an export target), and its
 * refs resolve through every consumer — viewport tile materials, model textures, export copies — by the same
 * disk convention as an extracted level.
 */
export const CUSTOM_TEX_LEVEL = 'Custom';

/** The active texture paint brush: a tile carrying the ride feel (SurfaceType — always set, snow by
 *  default) and D4 orientation to stamp. Emitted by the palette and the scratch pad. Every cell carries a
 *  tile — there is no "no texture" state, so no erase brush. */
export type Brush = { kind: 'tile'; ref: TexRef; surface: number; rot: number; mirror: boolean };

/** One texture file + how many terrain patches use it (0 = a prop/skybox tile, never used on terrain). */
export interface TexTile {
  name: string;
  count: number;
  /** Content revision used only in the HTTP URL; absent for authored tiles and older servers. */
  revision?: string;
}

/** A level's paintable textures, most-used-on-terrain first (server-derived from Textures/ + Patches.json). */
export interface LevelTextures {
  level: string;
  tiles: TexTile[];
}

export function makeTexRef(level: string, name: string): TexRef {
  return `${level}/${name}`;
}

/** Resolve a terrain patch's TexturePath. Extracted maps normally carry a bare file name, while authored
 *  ISO exports intentionally retain qualified dependencies such as Custom/foo.png or GARI/0012.png. */
export function resolveTerrainTexRef(level: string, path: string): TexRef {
  return path.indexOf('/') > 0 ? path : makeTexRef(level, path);
}

export function parseTexRef(ref: TexRef): { level: string; name: string } {
  const i = ref.indexOf('/');
  return i < 0 ? { level: '', name: ref } : { level: ref.slice(0, i), name: ref.slice(i + 1) };
}

/**
 * Resolve a prop material's texture against the model's own level.
 *
 * Most prop materials name a bare file ("0106.png") living in their own level's Textures/ bank. A
 * CROSS-LEVEL ref carries its bank inline instead ("Custom/lamp.png") and wins over the model's level —
 * that is how an authored model wears a tile from any level (docs/028) and how an imported GLB's extracted
 * art resolves out of the open mountain's logical Custom bank (docs/032). Both the viewport materials and the library
 * thumbnails go through here, so the two can never disagree about where a tile lives.
 */
export function resolvePropTex(level: string, ref: string | null | undefined): { level: string; name: string | null } {
  if (!ref) return { level, name: null };
  const i = ref.indexOf('/');
  return i > 0 ? { level: ref.slice(0, i), name: ref.slice(i + 1) } : { level, name: ref };
}

/** Flattened, collision-free file name a painted tile is copied to in the exported level folder.
 *  "SMOKEMTN/0019.png" -> "SMOKEMTN_0019.png" (never collides with procedural names like snow.png, nor
 *  across source levels that share a numeric file name). */
export function texDestName(ref: TexRef): string {
  const { level, name } = parseTexRef(ref);
  return level ? `${level}_${name}` : name;
}

/**
 * A tile name drawn from what the prompt is actually asking for, avoiding the names already on disk.
 *
 * The subject is the words after "texture of" up to the first sentence break — the template puts the
 * material there, and everything after it is the fixed tiling boilerplate, which would otherwise turn every
 * suggestion into "seamless-repeating-pattern-top-down". Four words is enough to tell snow from gravel in a
 * 56px grid without producing a name too long to read.
 */
export function suggestTextureName(prompt: string, taken: Set<string>): string {
  const subject = /texture of\s+([^.\n]+)/i.exec(prompt)?.[1] ?? prompt;
  const base = subject.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join('-') || 'texture';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
