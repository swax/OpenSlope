import type { QuadMeshDoc, V3 } from '../doc/types';
import { surfaceStyle } from '../doc/types';
import { deriveQuadMesh, type DerivedQuadMesh } from '../doc/mountain';
import { patchNormal, patchPoint } from '../math/bezier';
import {
  bilinearTwist, docEdgeHandles, meshAdjacency, quadControlPoints,
  type EdgeHandle, type MeshAdjacency, type QuadMesh,
} from './topology';
import type { TexRef } from '../paint/textures';
import { orientUV } from '../paint/orientation';
import type { SurfaceTopology } from './surface';

/** Tessellation per patch cell - matches snowknife's HD render bake (TerrainResHd = 8) so preview == game.
 *  The ride shares this mesh but never rides the chords: contact Newton-refines onto the analytic patch, so
 *  density is a pure visual/perf trade (snowknife keeps its COLLIDER bake at TerrainRes = 4 for the same reason). */
export const PREVIEW_RES = 8;

/** Vertices one patch owns in the quilt buffers. Every patch occupies exactly this many, in quad order, which
 *  is what makes a patch a contiguous slice of every buffer — the property the incremental path stands on. */
export const PATCH_VERTS = (PREVIEW_RES + 1) * (PREVIEW_RES + 1);

export interface PreviewData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Tile UVs: one tile per patch (0..1 per cell, the SSX convention). The export additionally pulls the
   *  corners in by its seam inset (level.ts UV_INSET, 0.008 per side) — a 0.8% zoom the preview skips. */
  uvs: Float32Array;
  indices: Uint32Array;
  /** faces per cell, for faceIndex -> (row, col) paint picking. */
  facesPerCell: number;
  /** Painted real tile per quad (quad id), or null to show the SurfaceType tint. */
  cellTex: (TexRef | null)[];
  /** Resolved SurfaceType per cell (same index as cellTex) - the viewport sampler's surface-default hint. */
  cellSurf: number[];
  /** Painted D4 orientation per cell (same index), or null when the cell has none - so sampling can
   *  pick a painted tile up at the orientation it was placed (already in the U=downhill / V=across frame). */
  cellOrient: ({ rot: number; mirror: boolean } | null)[];
  /** The cell grid's quad adjacency, for the shared face-loop / cell selection (surface.ts `faceLoop` /
   *  `faceBlock`). A regular grid today (the seed template); the same shape a general authored quad mesh will
   *  expose later. */
  topology: SurfaceTopology;
  /** The derived quad mesh (vertices + quads), for the Edit gizmo's topology neighbour-ring (frame / slide). */
  mesh: QuadMesh;
  /** The mesh's vertex adjacency, built once with the quilt. The gizmo's neighbour ring, the cage, the
   *  dependency radius and every rebuilt handle provider read this one index rather than each deriving it. */
  adjacency: MeshAdjacency;
  /** The net's edge-handle lookup. With `mesh` + `twistOf` it rebuilds any cell's 16 control points
   *  (`quadControlPoints`), so a consumer can evaluate the EXACT Bezier surface the tessellation below only
   *  approximates — the ride's analytic contact reads the real patch instead of riding its chords. */
  edgeHandle: EdgeHandle;
  /** Per-quad interior twist ([A,B,C,D] offsets, or null) — so the cell control-net study seats its interior
   *  handles at their TRUE (sculpted) positions, the same offsets the tessellation above bakes in. */
  twistOf: (q: number) => readonly V3[] | null;
  /** Checkerboard parity (0/1) per quad — the cosmetic shade the patch colours carry. Topology-derived, so it
   *  is retained across an incremental refresh rather than recomputed from the doc. */
  parity: number[];
}

/** The quilt buffers one patch is written into — everything a patch owns a contiguous slice of. */
type QuiltBuffers = Pick<PreviewData,
  'positions' | 'normals' | 'colors' | 'uvs' | 'indices' | 'cellTex' | 'cellSurf' | 'cellOrient'>;

/** What emitting one patch reads: the shape `deriveQuadMesh` hands back, minus the parts only the export
 *  needs. Named narrowly so the incremental refresh can supply it from a live quilt plus the document. */
type PatchSource = Pick<DerivedQuadMesh, 'mesh' | 'edgeHandle' | 'surfOf' | 'texOf' | 'orientOf' | 'twistOf' | 'parity'>;

/**
 * Write ONE patch into the quilt at the slot its quad index owns.
 *
 * Every buffer is addressed from `q` rather than from a running cursor, so emitting patch 7 alone lands
 * byte-for-byte where emitting patches 0…7 in order would have put it. That is what lets the full build and
 * the incremental refresh share this function instead of agreeing to match: they ARE the same write.
 */
function patchWriter(out: QuiltBuffers, d: PatchSource) {
  const res = PREVIEW_RES, side = res + 1;
  return (q: number): void => {
    const cp = quadControlPoints(d.mesh, d.edgeHandle, q, d.twistOf(q));
    const surf = d.surfOf(q);
    const o = d.orientOf(q); // per-cell tile orientation (D4), applied to the UVs
    const shade = d.parity(q) === 0 ? 1 : 0.93; // checkerboard shade (cosmetic parity)
    const tint = surfaceStyle(surf).color;
    out.cellTex[q] = d.texOf(q);
    out.cellSurf[q] = surf;
    out.cellOrient[q] = o;

    const vBase = q * PATCH_VERTS;
    let vp = vBase * 3, tp = vBase * 2;
    for (let iu = 0; iu < side; iu++) {
      for (let iv = 0; iv < side; iv++) {
        const u = iu / res, v = iv / res;
        const p = patchPoint(cp, u, v);
        const n = patchNormal(cp, u, v);
        out.positions[vp] = p[0]; out.positions[vp + 1] = p[1]; out.positions[vp + 2] = p[2];
        out.normals[vp] = n[0]; out.normals[vp + 1] = n[1]; out.normals[vp + 2] = n[2];
        out.colors[vp] = tint[0] * shade; out.colors[vp + 1] = tint[1] * shade; out.colors[vp + 2] = tint[2] * shade;
        vp += 3;
        // one tile per patch (the SSX convention): U 0->1 down the rows, V 0->-1 across the cols. The export
        // writes the same tile pulled in by its seam inset (level.ts UV_INSET) - invisible at 0.8%, so the
        // preview samples the full tile. A per-cell D4 orientation rotates/mirrors the tile's UVs.
        const [ou, ov] = o ? orientUV(u, v, o.rot, o.mirror) : [u, v];
        out.uvs[tp] = ou;
        out.uvs[tp + 1] = -ov;
        tp += 2;
      }
    }
    let ip = q * res * res * 6;
    for (let iu = 0; iu < res; iu++) {
      for (let iv = 0; iv < res; iv++) {
        const a = vBase + iu * side + iv;
        const b = a + 1;
        const c2 = vBase + (iu + 1) * side + iv;
        const dd = c2 + 1;
        // wound so the CCW face normal matches the skyward analytic normal
        // (du×dv points down here - see spine.ts frameAt / mountain.ts orientation - wind against it)
        out.indices[ip++] = a; out.indices[ip++] = dd; out.indices[ip++] = c2;
        out.indices[ip++] = a; out.indices[ip++] = b; out.indices[ip++] = dd;
      }
    }
  };
}

/** Allocate one quilt and expose its patch emitter. The normal edit path runs every emitter synchronously;
 *  the document-load path below runs the same emitter in time-bounded batches so loading progress can paint. */
function createQuiltBuilder(d: DerivedQuadMesh) {
  const { mesh, edgeHandle } = d;
  const res = PREVIEW_RES;
  const cells = mesh.quadCount;

  const buffers: QuiltBuffers = {
    positions: new Float32Array(cells * PATCH_VERTS * 3),
    normals: new Float32Array(cells * PATCH_VERTS * 3),
    colors: new Float32Array(cells * PATCH_VERTS * 3),
    uvs: new Float32Array(cells * PATCH_VERTS * 2),
    indices: new Uint32Array(cells * res * res * 6),
    cellTex: new Array(cells),
    cellSurf: new Array(cells),
    cellOrient: new Array(cells),
  };
  const emit = patchWriter(buffers, d);

  const finish = (): PreviewData => ({
    ...buffers,
    facesPerCell: res * res * 2,
    topology: mesh.topology,
    mesh,
    adjacency: meshAdjacency(mesh),
    edgeHandle,
    twistOf: d.twistOf,
    parity: Array.from({ length: cells }, (_, q) => d.parity(q)),
  });
  return { cells, emit, finish };
}

/** Evaluate a Bezier quilt exactly as the bake will - the editor never previews a lie. Reads the
 *  topology-general QuadMesh (mountain.ts `deriveQuadMesh`); each quad's 16 control points come from
 *  `quadControlPoints`, so preview == export == bake whatever the net's topology. */
export function tessellateQuilt(d: DerivedQuadMesh): PreviewData {
  const builder = createQuiltBuilder(d);
  for (let q = 0; q < builder.cells; q++) builder.emit(q);
  return builder.finish();
}

export function buildMountainPreview(doc: QuadMeshDoc): PreviewData {
  return tessellateQuilt(deriveQuadMesh(doc));
}

export type ProgressivePreviewOptions = {
  /** Called after each yielded batch, and once at completion. */
  onProgress: (completedPatches: number, totalPatches: number) => void;
  /** Supplied by the app shell so this core routine has no browser scheduling policy of its own. */
  yieldControl: () => Promise<void>;
  /** Maximum uninterrupted tessellation time. A generous default keeps loading fast while updating visibly. */
  budgetMs?: number;
};

/**
 * Load-only twin of buildMountainPreview. It produces byte-for-byte equivalent buffers through the same patch
 * emitter, but yields after a time budget so a large saved mountain reports real completed/total patch counts.
 * Interactive edits intentionally keep using the synchronous function above for lowest input latency.
 */
export async function buildMountainPreviewProgressive(
  doc: QuadMeshDoc,
  options: ProgressivePreviewOptions,
): Promise<PreviewData> {
  const builder = createQuiltBuilder(deriveQuadMesh(doc));
  const budget = Math.max(16, options.budgetMs ?? 80);
  let batchStart = performance.now();
  options.onProgress(0, builder.cells);
  for (let q = 0; q < builder.cells; q++) {
    builder.emit(q);
    const completed = q + 1;
    if (completed < builder.cells && performance.now() - batchStart >= budget) {
      options.onProgress(completed, builder.cells);
      await options.yieldControl();
      batchStart = performance.now();
    }
  }
  options.onProgress(builder.cells, builder.cells);
  return builder.finish();
}

/** Whether a document still describes the mesh a preview was tessellated from — the precondition every
 *  incremental path checks before it writes into retained buffers. */
export function previewMatchesTopology(doc: QuadMeshDoc, preview: PreviewData): boolean {
  return doc.quads.length === preview.mesh.quadCount && doc.vertices.length / 3 === preview.mesh.vertexCount;
}

/**
 * Re-emit the named patches into a live quilt, from the document as it now stands.
 *
 * The mesh's topology and its adjacency are RETAINED — a change that leaves which vertices and quads exist
 * alone cannot move either — so the only per-change derivation is the handle provider, whose overrides and
 * corner positions are read fresh. Everything else goes through `patchWriter`, the same function the full
 * build uses, so an updated patch is byte-identical to the one a full rebuild would have produced.
 *
 * Answers how many patches it wrote, or 0 when the topology has moved and only a full rebuild is correct.
 */
export function refreshPreviewPatches(doc: QuadMeshDoc, preview: PreviewData, quads: Iterable<number>): number {
  if (!previewMatchesTopology(doc, preview)) return 0;
  preview.mesh.vertices = doc.vertices;
  preview.edgeHandle = docEdgeHandles(preview.mesh, doc, preview.adjacency);
  preview.twistOf = q => doc.linearCage ? bilinearTwist(preview.mesh, q) : doc.quadTwist?.[q] ?? null;
  const write = patchWriter(preview, {
    mesh: preview.mesh,
    edgeHandle: preview.edgeHandle,
    surfOf: q => doc.quadPaint?.[q] ?? doc.baseSurface,
    texOf: q => doc.quadTex?.[q] ?? null,
    orientOf: q => doc.quadOrient?.[q] ?? null,
    twistOf: preview.twistOf,
    parity: q => preview.parity[q],
  });
  let changed = 0;
  for (const q of new Set(quads)) {
    if (q < 0 || q >= preview.mesh.quadCount) continue;
    write(q);
    changed++;
  }
  return changed;
}

/**
 * Where an incrementally updated quilt differs from a full rebuild of the same document, or null when it
 * does not differ anywhere.
 *
 * A stale patch is a mountain that renders differently for two people looking at one document, and it is
 * silent — nothing throws, the terrain is simply wrong. So the equivalence is checked rather than argued:
 * the tests run this after every kind of edit, and the editor can be asked to run it on every rebuild.
 */
export function previewMismatch(doc: QuadMeshDoc, preview: PreviewData): string | null {
  const full = buildMountainPreview(doc);
  const numeric: (keyof PreviewData & ('positions' | 'normals' | 'colors' | 'uvs' | 'indices'))[] =
    ['positions', 'normals', 'colors', 'uvs', 'indices'];
  for (const field of numeric) {
    const mine = preview[field], theirs = full[field];
    if (mine.length !== theirs.length) return `${field}: ${mine.length} values, a full rebuild has ${theirs.length}`;
    for (let at = 0; at < mine.length; at++) {
      if (mine[at] === theirs[at]) continue;
      const patch = Math.floor(at / (mine.length / full.mesh.quadCount));
      return `${field}[${at}] (patch ${patch}): ${mine[at]} where a full rebuild has ${theirs[at]}`;
    }
  }
  for (let q = 0; q < full.mesh.quadCount; q++) {
    if (preview.cellSurf[q] !== full.cellSurf[q]) return `cellSurf[${q}]: ${preview.cellSurf[q]} vs ${full.cellSurf[q]}`;
    if (preview.cellTex[q] !== full.cellTex[q]) return `cellTex[${q}]: ${preview.cellTex[q]} vs ${full.cellTex[q]}`;
    const mine = preview.cellOrient[q], theirs = full.cellOrient[q];
    if (JSON.stringify(mine ?? null) !== JSON.stringify(theirs ?? null)) {
      return `cellOrient[${q}]: ${JSON.stringify(mine ?? null)} vs ${JSON.stringify(theirs ?? null)}`;
    }
  }
  return null;
}
