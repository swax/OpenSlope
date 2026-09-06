import { quadCount, texOf, type EditDoc } from '../doc/doc-edit';
import type { SkyboxDoc } from '../doc/types';
import { CUSTOM_TEX_LEVEL, parseTexRef } from '../paint/textures';
import { SKY_TIERS, tileSizes, type SkyRing, type SkyTier } from '../sky/ring';

/**
 * Export preflight (docs/011): what a mountain ships, summarised for the export dialog before anything is
 * written. Pure — no fs; the server (`src/server/routes/preflight.ts`) attaches the imported-model records it
 * has to read off disk.
 *
 * It describes the MAP, not a disc. A tile's class is a fact about where its art came from — the target's slot
 * table, the reuse-vs-append allocation and the VRAM cost all belong to `snowknife repack`, which holds the
 * allocator and reports them with `--dry-run`.
 *
 *   custom  — the author's own tile (the Custom pseudo-level).
 *   real    — a tile lifted from an extracted level, which ships flattened and verbatim.
 */
export type TileClass = 'real' | 'custom';

export interface PreflightTile {
  /** The tile ref as painted, "<LEVEL>/<file.png>". */
  ref: string;
  level: string;
  name: string;
  cls: TileClass;
  /** How many cells are painted with this exact tile. */
  cells: number;
}

/**
 * What a document's PROPS cost. Attached by the server route (`server/routes/preflight.ts`), which owns the
 * model geometry and the material tables on disk that the pure classifier cannot read.
 *
 * Retail instances its props — thousands of placements over a few hundred models. An authored export does
 * NOT: `canonical-props.ts` writes one model row, one mesh file and one instance PER PLACEMENT, and
 * `repack` appends all three, so `bakedTris` is what the level carries on the disc as well as in the
 * Unity bundle. `geomTris` is the smaller number — the distinct art in use — and it is reported because it
 * says how modular the map is, not because anything only pays that much.
 */
export interface PreflightProps {
  /** Placements as they BAKE — a group placement counts as its members, which is how the export writes it. */
  placements: number;
  /** Distinct models placed, across every source. */
  models: number;
  /** Triangles of distinct source art in use — how modular the map is. */
  geomTris: number;
  /** Placements × per-copy triangles: what the level actually ships, on the disc and in the bundle alike. */
  bakedTris: number;
  /** Pages the prop materials name (`<LEVEL>/<file.png>`), flipbook frames included — one bank slot each. */
  pages: string[];
  /** One row per model, heaviest baked first. */
  rows: { source: string; name: string; placements: number; tris: number; pages: number }[];
  /** A placement whose model could not be resolved — the bake warns, so this does too. */
  missing: string[];
}

/**
 * The shipped seven, measured by `tools/prop-budget.ts` (`npm run budget`) — the band an authored course is
 * read against, so a prop count means something without opening a spreadsheet. Visible instances, the
 * distinct geometry each level carries, the same props baked once per placement, and the terrain+prop half of
 * a texture bank (every retail bank also carries 17–20 pages of crowd and particle art no patch or prop
 * names).
 *
 * An authored export bakes per placement, so its baked total is compared against retail's GEOMETRY band —
 * that is the like-for-like — rather than against retail's baked one, which an instancing renderer earns.
 */
export const RETAIL_PROPS = {
  instances: [1_089, 4_193],
  geomTris: [19_238, 273_720],
  bakedTris: [72_953, 2_680_841],
  pages: [108, 197],
} as const;

export interface Preflight {
  /** Distinct painted tiles, most-covered first. */
  tiles: PreflightTile[];
  counts: { real: number; custom: number };
  cells: { total: number; painted: number; unpainted: number };
  /** The imported GLB models the doc places (docs/032) — so the dialog can show the MODELS, not only their
   *  tiles: each geometry bakes once per placement. Attached by the server route, which owns the record store
   *  the pure classifier cannot read; absent when the doc places none. */
  importedModels?: {
    name: string;
    placements: number;
    /** Triangles PER COPY — the bake emits geometry once per placement. */
    tris: number;
    /** The model's Custom tile refs ("Custom/<name>.png"), one per textured material. */
    pages: string[];
    /** The record behind a placement is gone — the bake will warn; hiding it here would understate the doc. */
    missing?: boolean;
  }[];
  /** Every prop the doc places, priced against the retail band. Attached by the server route; absent when the
   *  doc places none. Imported GLB models keep their own section — they are the author's geometry rather than
   *  a level's, and their triangles are already counted here. */
  props?: PreflightProps;
  /** The sky the doc ships (docs/025). A `level` sky lifts the donor's bank verbatim — no decode — while a
   *  `custom` one encodes a fresh `_sky.ssh` using the measured slots, FORCED type-5 (a re-encoded 8-bit page is not displayed
   *  by the PS2 uploader), priced here exactly at 4 bytes/texel. The proven reference is the standard tier's
   *  ~1.0 MB ≈ a retail day sky's native ~0.85 MB; the high tier's ~3.3 MB has no characterized budget. */
  sky?:
    | { kind: 'level'; level: string }
    | { kind: 'custom'; name: string; tier: SkyTier; pages: number; bytes: number };
}

export function computePreflight(doc: EditDoc, skyRing?: SkyRing): Preflight {
  const total = quadCount(doc);

  // distinct painted tiles + how many cells each covers
  const byRef = new Map<string, number>();
  let painted = 0;
  for (let q = 0; q < total; q++) {
    const ref = texOf(doc, q);
    if (!ref) continue;
    painted++;
    byRef.set(ref, (byRef.get(ref) ?? 0) + 1);
  }

  const tiles: PreflightTile[] = [...byRef.entries()]
    .map(([ref, cells]) => {
      const { level, name } = parseTexRef(ref);
      // the user's own tiles carry the Custom pseudo-level prefix; everything else came out of an extraction
      return { ref, level, name, cells, cls: (level === CUSTOM_TEX_LEVEL ? 'custom' : 'real') as TileClass };
    })
    .sort((a, b) => b.cells - a.cells || a.ref.localeCompare(b.ref));

  const counts = { real: 0, custom: 0 };
  for (const t of tiles) counts[t.cls]++;

  const out: Preflight = {
    tiles,
    counts,
    cells: { total, painted, unpainted: total - painted },
  };

  const sky = (doc as { skybox?: SkyboxDoc }).skybox;
  if (sky?.source.kind === 'level') {
    out.sky = { kind: 'level', level: sky.source.level };
  } else if (sky?.source.kind === 'custom') {
    const tier: SkyTier = sky.tier ?? 'standard';
    const pages = skyRing ? tileSizes(SKY_TIERS[tier], skyRing) : [];
    out.sky = {
      kind: 'custom', name: sky.source.name, tier,
      pages: pages.length,
      bytes: pages.reduce((n, d) => n + d.w * d.h * 4, 0),   // forced type-5: 4 bytes/texel
    };
  }

  return out;
}
