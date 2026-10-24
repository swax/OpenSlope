import type { QuadMeshDoc } from '../doc/types';

/** Editing treats a source cage as authored geometry and its terrain evaluation as derived geometry. */
const cache = new WeakMap<
  QuadMeshDoc,
  { surfaces: QuadMeshDoc['surfaces']; ids: string[]; quads: number[][]; length: number; value: Ownership }
>();
type Ownership = {
  output: Set<string>;
  controls: Set<string>;
  cage: Set<string>;
  /** Consumed construction sketches are hidden in every mode; generated terrain is hidden only in Edit. */
  construction: Set<number>;
  hidden: Set<number>;
};
const empty: Ownership = {
  output: new Set(),
  controls: new Set(),
  cage: new Set(),
  construction: new Set(),
  hidden: new Set(),
};
export function surfaceOwnership(doc: QuadMeshDoc): Ownership {
  if (!doc.surfaces?.length) return empty;
  const found = cache.get(doc);
  if (
    found?.surfaces === doc.surfaces &&
    found.ids === doc.vertexIds &&
    found.quads === doc.quads &&
    found.length === doc.vertexIds.length
  )
    return found.value;
  const output = new Set(doc.surfaces?.flatMap(s => s.vertices));
  const controls = new Set(doc.surfaces?.flatMap(s => s.controls.flat()));
  const cage = new Set(doc.surfaces?.filter(s => !s.guides).flatMap(s => s.controls.flat()));
  const terrain = new Set(doc.quads.flat());
  const inputs = new Set(doc.surfaces?.flatMap(s => s.inputs));
  const construction = new Set(doc.vertexIds.flatMap((id, i) => (inputs.has(id) && !terrain.has(i) ? [i] : [])));
  const hidden = new Set(doc.vertexIds.flatMap((id, i) => (output.has(id) || construction.has(i) ? [i] : [])));
  const value = { output, controls, cage, construction, hidden };
  cache.set(doc, { surfaces: doc.surfaces, ids: doc.vertexIds, quads: doc.quads, length: doc.vertexIds.length, value });
  return value;
}
