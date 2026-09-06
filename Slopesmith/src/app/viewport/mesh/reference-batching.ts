import { makeTexRef, type TexRef } from '../../../core/paint/textures';

/**
 * XZ grid cell for the terrain split, in metres — native editor space IS metres (`RAW_TO_EDITOR` scales the
 * raw centimetres by 1/100). Smaller cells cull tighter; what they used to cost was draws, because a cell
 * drew once per texture it contained and a tile shared by four cells became four draws.
 *
 * Measured on GARI — 3,885 patches x 128 faces = 497k quilt triangles over 52 terrain tile pages — from a
 * view with most of the level off screen, as quilt triangles still submitted / draw calls added against no
 * split at all:
 *
 *     800 m -> 84% drawn, +78 calls    400 m -> 61% drawn, +111 calls    200 m -> 53% drawn, +215 calls
 *
 * 400 m was the knee under those numbers, and the note here said the knee would move once a cell's tiles
 * could collapse into ONE draw — which is what the array-texture bank now does (mesh/texture-array.ts). A
 * cell is a draw, not a draw per page, so the draw column collapses to roughly the visible cell COUNT and
 * 200 m becomes the better trade. Measured on the same GARI ride, three seconds down from the start gate:
 *
 *              400 m + a material per page    200 m + one array
 *     Near     116 calls ·  99,612 tris        40 calls · 72,176 tris
 *     Medium   140 calls · 146,986 tris        42 calls · 91,767 tris
 *     Far      140 calls · 146,986 tris        42 calls · 91,042 tris
 *
 * Both halves are load-bearing and neither is worth much alone: without the bank, 200 m cells would submit
 * hundreds of calls; without the tighter cells, the bank would leave 40% more triangles on screen. This is
 * the same 200 m the Unity port settled on (`StaticChunker`), for the same reason.
 */
export const REFERENCE_CHUNK_METRES = 200;

export interface ReferenceBatchGroup {
  start: number;
  count: number;
  materialIndex: number;
}

/**
 * One spatially bounded slice of the quilt: every patch binned into a single grid cell, as one draw range per
 * texture present there, plus the exact bounds of those patches. The bounds are the whole point — they are
 * what lets the renderer reject the cell before it walks any of its draws.
 */
export interface ReferenceBatchChunk {
  /** Grid coordinates of the cell. Diagnostic only; culling reads `min`/`max`. */
  cell: [number, number];
  groups: ReferenceBatchGroup[];
  min: [number, number, number];
  max: [number, number, number];
  /** Patches binned here, for the load-time census. */
  patches: number;
}

export interface ReferenceBatchLayout {
  indices: Uint32Array;
  /** Material slots 1..n; slot 0 is reserved for the untextured/fallback material. */
  textureRefs: TexRef[];
  /** Cell-major, then texture within the cell. One mesh per entry, all sharing `indices`. */
  chunks: ReferenceBatchChunk[];
  /** Per patch, its texture slot — what `buildPatchSliceAttribute` turns into per-vertex array slices. */
  patchSlots: Uint32Array;
  /** Per source patch, the start of its contiguous range in the reordered render index. This lets transient
   *  Edit visibility collapse a patch without rebuilding the spatial/material layout. */
  patchStarts: Uint32Array;
}

/**
 * Reorder a reference quilt's render-only index into a spatial grid of chunks, each holding one contiguous
 * range per texture. The source index stays untouched because ride contact and every reference pick resolve
 * faceIndex -> patch from its original patch-major order. Vertices are already private to each patch, so
 * moving whole index ranges changes only submission order, not topology, UVs, lighting, or the visible result.
 *
 * The grid is why this exists. Drawn as ONE map-spanning mesh the quilt can never be frustum-culled — the
 * whole course is submitted from every viewpoint, which is the same over-merge the Unity port diagnosed and
 * fixed with `StaticChunker` (Unity/docs/vrchat/025-performance.md). Split into cells with tight
 * bounds, Three rejects the off-screen ones for free, in the editor viewport, in Play, and in a headset —
 * where the cull runs once against a frustum enclosing both eyes, so a rejected chunk is rejected for both.
 *
 * Patches, not triangles, are the binning unit: a patch is already a contiguous `facesPerPatch` slice of the
 * index and is ~20x34 m, well under a cell, so binning by its box centre is both cheaper than Unity's
 * per-triangle pass and free of any re-indexing. A patch that straddles a boundary simply widens the bounds
 * of the cell that claims it, which costs a little culling precision and cannot cost correctness.
 *
 * `cellMetres <= 0` (or non-finite) disables the split and returns a single chunk over the whole quilt.
 */
export function buildReferenceBatchLayout(
  source: Uint32Array,
  positions: Float32Array,
  patchTextures: readonly (string | null)[],
  facesPerPatch: number,
  level: string,
  cellMetres: number = REFERENCE_CHUNK_METRES,
): ReferenceBatchLayout {
  const indicesPerPatch = facesPerPatch * 3;
  if (!Number.isInteger(indicesPerPatch) || indicesPerPatch <= 0)
    throw new Error(`invalid reference facesPerPatch: ${facesPerPatch}`);
  const required = patchTextures.length * indicesPerPatch;
  if (required > source.length)
    throw new Error(`reference index buffer is short (${source.length} < ${required})`);

  const textureRefs: TexRef[] = [];
  const slotOf = new Map<TexRef, number>();
  const patchSlots = new Uint32Array(patchTextures.length);

  for (let patch = 0; patch < patchTextures.length; patch++) {
    const name = patchTextures[patch];
    let slot = 0;
    if (name) {
      // Keep the containing reference level in the request even when TexturePath is qualified. The server
      // can then prefer this export's staged local copy; paint picking separately unwraps the logical ref.
      const ref = makeTexRef(level, name);
      const known = slotOf.get(ref);
      if (known !== undefined) slot = known;
      else {
        slot = textureRefs.length + 1;
        slotOf.set(ref, slot);
        textureRefs.push(ref);
      }
    }
    patchSlots[patch] = slot;
  }

  interface Cell {
    cx: number;
    cz: number;
    /** texture slot -> the patches in this cell carrying it, in patch order. */
    slots: Map<number, number[]>;
    min: [number, number, number];
    max: [number, number, number];
    patches: number;
  }
  const split = Number.isFinite(cellMetres) && cellMetres > 0;
  const cells = new Map<string, Cell>();

  for (let patch = 0; patch < patchTextures.length; patch++) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const from = patch * indicesPerPatch;
    for (let i = from; i < from + indicesPerPatch; i++) {
      const v = source[i] * 3;
      const x = positions[v], y = positions[v + 1], z = positions[v + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    // A patch whose positions are absent or non-finite would otherwise carry an inverted box into a bounding
    // sphere and cull unpredictably. Seat it at the origin cell instead: it still draws, it just cannot help.
    if (minX > maxX) { minX = maxX = minY = maxY = minZ = maxZ = 0; }

    const cx = split ? Math.floor((minX + maxX) / 2 / cellMetres) : 0;
    const cz = split ? Math.floor((minZ + maxZ) / 2 / cellMetres) : 0;
    const key = `${cx},${cz}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { cx, cz, slots: new Map(), min: [minX, minY, minZ], max: [maxX, maxY, maxZ], patches: 0 };
      cells.set(key, cell);
    } else {
      if (minX < cell.min[0]) cell.min[0] = minX;
      if (minY < cell.min[1]) cell.min[1] = minY;
      if (minZ < cell.min[2]) cell.min[2] = minZ;
      if (maxX > cell.max[0]) cell.max[0] = maxX;
      if (maxY > cell.max[1]) cell.max[1] = maxY;
      if (maxZ > cell.max[2]) cell.max[2] = maxZ;
    }
    cell.patches++;
    const slot = patchSlots[patch];
    const list = cell.slots.get(slot);
    if (list) list.push(patch);
    else cell.slots.set(slot, [patch]);
  }

  // Emit cell-major so each chunk's groups are contiguous, and slot-ascending within a cell so a chunk's
  // material switches follow the same stable order the single-mesh layout used to submit globally.
  const ordered = [...cells.values()].sort((a, b) => (a.cx - b.cx) || (a.cz - b.cz));
  const indices = new Uint32Array(required);
  const patchStarts = new Uint32Array(patchTextures.length);
  const chunks: ReferenceBatchChunk[] = [];
  let cursor = 0;
  for (const cell of ordered) {
    const groups: ReferenceBatchGroup[] = [];
    for (const slot of [...cell.slots.keys()].sort((a, b) => a - b)) {
      const start = cursor;
      for (const patch of cell.slots.get(slot)!) {
        patchStarts[patch] = cursor;
        indices.set(source.subarray(patch * indicesPerPatch, (patch + 1) * indicesPerPatch), cursor);
        cursor += indicesPerPatch;
      }
      groups.push({ start, count: cursor - start, materialIndex: slot });
    }
    chunks.push({ cell: [cell.cx, cell.cz], groups, min: cell.min, max: cell.max, patches: cell.patches });
  }

  return { indices, textureRefs, chunks, patchSlots, patchStarts };
}

/**
 * Resolve a cell's per-texture ranges to draw ranges, merging NEIGHBOURING ranges that land on the same
 * material — which is what turns a packed texture bank into one draw per cell.
 *
 * A cell's ranges are contiguous in the index by construction and are emitted in ascending texture-slot
 * order, while the bank assigns its array slices in that same slot order. So the slots a bank covers form a
 * contiguous prefix-shaped run within every cell and collapse to a single range; a page too large for the
 * bank, or one that never loaded, simply interrupts the run and keeps a range of its own.
 *
 * It pays off before any bank exists too: while tiles are still downloading every range resolves to the one
 * fallback material, so a cell submits one draw rather than one per tile it is waiting on.
 */
export function mergeReferenceBatchGroups(
  groups: readonly ReferenceBatchGroup[],
  materialOf: (materialIndex: number) => number,
): ReferenceBatchGroup[] {
  const merged: ReferenceBatchGroup[] = [];
  for (const group of groups) {
    const materialIndex = materialOf(group.materialIndex);
    const last = merged[merged.length - 1];
    if (last && last.materialIndex === materialIndex && last.start + last.count === group.start) {
      last.count += group.count;
      continue;
    }
    merged.push({ start: group.start, count: group.count, materialIndex });
  }
  return merged;
}

/**
 * The per-vertex array-slice attribute (mesh/texture-array.ts): for every vertex, which layer of the packed
 * bank its patch's tile lives in. This is the editor's `UV0.z` — the one number that lets a whole cell of
 * mixed tiles go out as a single draw.
 *
 * Written by walking each patch's own index range, which is sound because a reference quilt's vertices are
 * PRIVATE to their patch (each patch is tessellated independently). A vertex shared between two patches
 * carrying different tiles would take whichever wrote last; that cannot arise here, and the render-only
 * layout would already be misdrawing UVs long before the slice mattered if it did.
 *
 * A patch whose tile is not in the bank gets slice 0. Its triangles keep their own per-page material and are
 * never sampled through the array, so the value is unread rather than wrong.
 */
export function buildPatchSliceAttribute(
  source: Uint32Array,
  patchSlots: Uint32Array,
  facesPerPatch: number,
  vertexCount: number,
  sliceOfSlot: (slot: number) => number,
): Uint16Array {
  const slices = new Uint16Array(vertexCount);
  const indicesPerPatch = facesPerPatch * 3;
  const bySlot = new Map<number, number>();
  for (let patch = 0; patch < patchSlots.length; patch++) {
    const slot = patchSlots[patch];
    let slice = bySlot.get(slot);
    if (slice === undefined) bySlot.set(slot, slice = Math.max(0, sliceOfSlot(slot)));
    if (!slice) continue; // slice 0 is the array's first layer AND the zero-filled default: nothing to write
    const from = patch * indicesPerPatch;
    for (let i = from; i < from + indicesPerPatch; i++) {
      const vertex = source[i];
      if (vertex < vertexCount) slices[vertex] = slice;
    }
  }
  return slices;
}
