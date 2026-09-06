import type { QuadMeshDoc, V3 } from './types';
import { readVertex, writeVertex } from '../mesh/primitives';
import { vertexIsLocked } from '../mesh/locks';
import { turnD4 } from '../paint/orientation';

/**
 * Editing accessors over a mountain document. The editor addresses geometry by VERTEX ID and faces by QUAD
 * ID; the document is a quad mesh, so both are direct indices. These wrappers exist so every edit tool
 * speaks one vocabulary — and so paint / tile / orientation reads stay in one place — rather than reaching
 * into `vertices` / `quads` / `quad*` maps themselves.
 */

export type EditDoc = QuadMeshDoc;

/** The mutable vertex position buffer, flat xyz float64.
 *  Exposed for read-only bounds / iteration (bbox, focus); mutate via setVertex / moveVertex. */
export const docPositions = (doc: EditDoc): number[] => doc.vertices;
const posBuf = docPositions;

export function vertexCount(doc: EditDoc): number {
  return posBuf(doc).length / 3;
}
export function getVertex(doc: EditDoc, id: number): V3 {
  return readVertex(posBuf(doc), id);
}
export function setVertex(doc: EditDoc, id: number, p: V3): void {
  if (doc.quadLocked && vertexIsLocked(doc, id)) return;
  writeVertex(posBuf(doc), id, p);
}
/** Offset one vertex by a delta (the group-move primitive). */
export function moveVertex(doc: EditDoc, id: number, d: V3): void {
  if (doc.quadLocked && vertexIsLocked(doc, id)) return;
  const a = posBuf(doc), i = id * 3;
  a[i] += d[0]; a[i + 1] += d[1]; a[i + 2] += d[2];
}

export function quadCount(doc: EditDoc): number {
  return doc.quads.length;
}
/** The four corner vertex ids of quad `q` [A@(0,0), B@(0,1), C@(1,0), D@(1,1)]. */
export function quadVerts(doc: EditDoc, q: number): [number, number, number, number] {
  const [a, b, c, d] = doc.quads[q];
  return [a, b, c, d];
}

// ---- per-quad paint / tile / orientation (paint addresses a QUAD ID; the pick's face index is the quad id) ----

export function surfOf(doc: EditDoc, q: number): number {
  return doc.quadPaint?.[q] ?? doc.baseSurface;
}
export function setSurf(doc: EditDoc, q: number, s: number): void {
  (doc.quadPaint ??= {})[q] = s;
}
export function texOf(doc: EditDoc, q: number): string | null {
  return doc.quadTex?.[q] ?? null;
}
export function setTex(doc: EditDoc, q: number, ref: string): void {
  (doc.quadTex ??= {})[q] = ref;
}
/** Remove a quad's painted tile (it falls back to its SurfaceType tint). */
export function clearTex(doc: EditDoc, q: number): void {
  if (doc.quadTex) delete doc.quadTex[q];
}
export function orientOf(doc: EditDoc, q: number): { rot: number; mirror: boolean } | null {
  return doc.quadOrient?.[q] ?? null;
}
export function setOrient(doc: EditDoc, q: number, o: { rot: number; mirror: boolean } | null): void {
  if (o) (doc.quadOrient ??= {})[q] = o; else if (doc.quadOrient) delete doc.quadOrient[q];
}
/**
 * Turn each painted quad's tile a quarter, or toggle its mirror with `flip` — Paint's ← / → over a cell
 * selection (`shortcuts.ts` → `turnPaintTexture`), applied to the whole set as Delete clears the whole set.
 *
 * The step itself is `turnD4`, shared with the Palette's staged cells and with a tiled prop's single tile, so
 * a tile turns one direction wherever it lives. Quads holding no tile have no orientation to turn and are
 * skipped; returns how many were turned, so a no-op selection can leave the key unhandled.
 */
export function turnOrient(doc: EditDoc, quads: Iterable<number>, dir: 1 | -1, flip: boolean): number {
  let turned = 0;
  for (const q of quads) {
    if (!texOf(doc, q)) continue;
    setOrient(doc, q, turnD4(orientOf(doc, q) ?? { rot: 0, mirror: false }, dir, flip));
    turned++;
  }
  return turned;
}
