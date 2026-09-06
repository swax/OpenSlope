import { safeDataName } from './names';
import type { PropAlphaMode } from '../reference/props';

/**
 * One combined material table for everything an export bakes from source-level art — placed props, rail
 * tubes, gem models. Source MaterialIDs from different levels collide, so each distinct (level, MaterialID)
 * used gets a FRESH id (`usemtl mat_<id>` → Materials[id], docs/012); the referenced texture is queued for a
 * verbatim copy under a prop-namespaced dest name, deduped across users of the same source file. The source
 * material's `UnknownInt18` (alpha-blend flag) rides along so TextureBundle classifies the tile like the
 * source level does. Share ONE combiner across all the bakes of an export so Materials.json is written once.
 */

/** One record as a source level's `Materials.json` carries it — the fields a bake resolves through. */
export interface SourceMaterial {
  TexturePath?: string;
  TextureFlipbook?: string[];
  UnknownInt18?: number;
  /** Derived from the source level's TextureAlpha.overrides.json; not part of retail Materials.json. */
  AlphaMode?: PropAlphaMode;
}

/** One record as the export's own `Materials.json` carries it; the array index is the `mat_<id>` slot. */
export interface CombinedMaterial {
  MaterialName: string;
  TexturePath: string;
  UnknownInt18: number;
  TextureFlipbook: string[];
}

/** A texture to copy verbatim: source level's Textures/<name> → this level's Textures/<dest>. */
export interface TextureCopy {
  dest: string;
  level: string;
  name: string;
}

export interface MaterialCombiner {
  materials: CombinedMaterial[];
  texCopies: TextureCopy[];
  /** Destination page → explicit mode, written as TextureAlpha.overrides.json beside the combined table. */
  alphaOverrides: Record<string, PropAlphaMode>;
  /** The combined slot for a source (level, MaterialID) — or -1 (emit `mat_untextured`). */
  resolveSlot(level: string, mat: number): number;
  /** The combined slot for a bare TILE ref "LEVEL/file.png" (an authored model's texture): the tile copies
   *  like any prop texture, and the entry INHERITS the source level's alpha-blend flag for that tile —
   *  UnknownInt18 is authored data, not pixel-derivable, so the river tile keeps its blend. -1 = bad ref.
   *
   *  `frames` is the material's flipbook state list as bare file names in the SAME bank the ref names, which
   *  is where an imported prop's frames are staged. Each copies like the base tile and lands in the entry's
   *  `TextureFlipbook`, so a switchable surface survives the bake with the frame list the level's own
   *  materials carry. A tile used both plainly and as a flipbook gets two slots, because the frame list is
   *  part of what the material IS. */
  resolveTileSlot(ref: string, frames?: readonly string[], blend?: boolean, alphaMode?: PropAlphaMode): number;
}

/**
 * A combiner over every source level's `Materials[]`, keyed by sanitised level name.
 *
 * `resolveSlot` is called from inside the synchronous geometry loops of every bake step, so it must stay
 * synchronous — threading a promise through those loops would serialize the bake on one file read per
 * material. The tables are therefore fetched up front, together, and the combiner is pure thereafter. The
 * whole library's tables are a fraction of a megabyte, and an export reads them once.
 */
export function buildMaterialCombiner(tables: ReadonlyMap<string, readonly SourceMaterial[]>): MaterialCombiner {
  const materials: CombinedMaterial[] = [];
  const texCopies: TextureCopy[] = [];
  const alphaOverrides: Record<string, PropAlphaMode> = {};
  const seenDest = new Set<string>();
  const slotOf = new Map<string, number>(); // "<safeLevel>:<MaterialID>" → combined id (or -1 = untextured)
  // A level absent from the library resolves to an empty table, which is the same "no such material" answer
  // a lazy read produced.
  const materialsOf = (level: string): readonly SourceMaterial[] => tables.get(safeDataName(level)) ?? [];

  return {
    materials,
    texCopies,
    alphaOverrides,
    resolveSlot(level: string, mat: number): number {
      if (mat < 0) return -1;
      const lvl = safeDataName(level);
      const key = `${lvl}:${mat}`;
      const cached = slotOf.get(key);
      if (cached !== undefined) return cached;
      const src = materialsOf(level)[mat];
      const tex = src?.TexturePath;
      if (!tex) { slotOf.set(key, -1); return -1; }
      const queueTexture = (name: string): string => {
        const dest = `p_${lvl}_${name}`;
        if (!seenDest.has(dest)) { seenDest.add(dest); texCopies.push({ dest, level, name }); }
        if (src.AlphaMode) alphaOverrides[dest] = src.AlphaMode;
        return dest;
      };
      const dest = queueTexture(tex);
      const flipbook = (src.TextureFlipbook ?? []).filter(name => typeof name === 'string' && !!name).map(queueTexture);
      const id = materials.length;
      materials.push({
        MaterialName: `prop_${lvl}_${mat}`,
        TexturePath: dest,
        UnknownInt18: src.AlphaMode && src.AlphaMode !== 'opaque'
          ? (src.UnknownInt18 ?? 0) | 0x40000
          : src.AlphaMode === 'opaque' ? (src.UnknownInt18 ?? 0) & ~0x40000 : src.UnknownInt18 ?? 0,
        TextureFlipbook: flipbook,
      });
      slotOf.set(key, id);
      return id;
    },
    resolveTileSlot(ref: string, frames: readonly string[] = [], blend = false,
      alphaMode?: PropAlphaMode): number {
      const slash = ref.indexOf('/');
      if (slash <= 0 || slash === ref.length - 1) return -1;
      const level = ref.slice(0, slash), name = ref.slice(slash + 1);
      const lvl = safeDataName(level);
      const states = frames.filter(frame => typeof frame === 'string' && !!frame);
      const src = materialsOf(level).find(m => m.TexturePath === name);
      const resolvedAlpha = alphaMode ?? src?.AlphaMode;
      const key = `tile:${lvl}:${name}${states.length ? `:flip:${states.join(',')}` : ''}`
        + `${blend ? ':blend' : ''}${resolvedAlpha ? `:alpha-${resolvedAlpha}` : ''}`;
      const cached = slotOf.get(key);
      if (cached !== undefined) return cached;
      // inherit the source level's alpha-blend flag for this tile — the first material wearing it is canon
      const queueTile = (file: string): string => {
        const dest = `p_${lvl}_${file}`;
        if (!seenDest.has(dest)) { seenDest.add(dest); texCopies.push({ dest, level, name: file }); }
        if (resolvedAlpha) alphaOverrides[dest] = resolvedAlpha;
        return dest;
      };
      const dest = queueTile(name);
      const id = materials.length;
      materials.push({
        MaterialName: `model_${lvl}_${name.replace(/\.png$/i, '')}`,
        TexturePath: dest,
        UnknownInt18: resolvedAlpha && resolvedAlpha !== 'opaque'
          ? (src?.UnknownInt18 ?? 0) | 0x40000
          : resolvedAlpha === 'opaque' ? (src?.UnknownInt18 ?? 0) & ~0x40000
            : (src?.UnknownInt18 ?? 0) | (blend ? 0x40000 : 0),
        TextureFlipbook: states.map(queueTile),
      });
      slotOf.set(key, id);
      return id;
    },
  };
}
