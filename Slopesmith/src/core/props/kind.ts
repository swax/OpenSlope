import { AUTHORED_MODEL_LEVEL } from '../doc/models';
import { IMPORTED_PROP_LEVEL } from './imported';

/**
 * What kind of prop this is, in the words the editor says out loud.
 *
 * There are two, and the line between them is NOT where the geometry came from. Provenance is an accident —
 * a prop built here, one loaded from a GLB and one borrowed from a shipped level can be the same object in
 * every way that matters, and a prop revised out of a reference level was never "imported" from anything. The
 * property that actually predicts behaviour is one question:
 *
 *   **are the UVs computed, or are they data?**
 *
 * A **tiled** prop wears ONE tile with the mapping derived per quad — the full 0–1 rect, A(0,0) B(1,0) C(0,1)
 * D(1,1) (docs/028). Nothing about the mapping is stored, so reshaping is free: move a corner, cut a loop,
 * and correct UVs come back out of the bake. That is exactly why the mesh tools can edit one, why a UV scroll
 * flows unbroken along it, and why the Blender bridge sends it no UV layer at all (docs/046).
 *
 * A **textured** prop carries its own UV layout across however many materials it needs. The layout is
 * authored data, so changing the geometry breaks it — which is why editing one belongs where UVs can be
 * re-authored, and why the bridge round-trips its UVs in both directions.
 *
 * Everything else follows from that row, so the vocabulary is worth keeping in one place: the selection
 * panel, the prop library and the Blender add-on all describe a prop through here rather than each
 * inventing a phrasing, and the words in the editor are the words in the docs.
 */

export type PropKind = 'tiled' | 'textured';

/** Which kind a prop-library level holds. `@models` is the only tiled one; everything else — an imported
 *  record, a shipped level's own props — carries an authored UV layout. */
export const propKindOf = (level: string): PropKind =>
  level === AUTHORED_MODEL_LEVEL ? 'tiled' : 'textured';

/** Whether Slopesmith's own mesh tools can edit this prop's geometry. Only a tiled prop, and only because
 *  its mapping is derived: there is nothing to invalidate by moving a corner. */
export const editableHere = (level: string): boolean => level === AUTHORED_MODEL_LEVEL;

/** Whether the author owns this geometry, or is looking at a shipped level's read-only reference. */
export const ownGeometry = (level: string): boolean =>
  level === AUTHORED_MODEL_LEVEL || level === IMPORTED_PROP_LEVEL;

/** What the selection panel, the library tile and the add-on all say about one prop. */
export interface PropDescription {
  kind: PropKind;
  /** "Tiled prop" / "Textured prop". */
  label: string;
  /** The facts, joined: "6 quads · one tile" or "1,240 tris · 3 materials · from MEGAPLE". */
  detail: string;
  /** What follows from being this kind — two short sentences, the "what's the deal" line. */
  note: string;
  /** True while the geometry belongs to a shipped level and cannot be changed in place. */
  readOnly: boolean;
}

export interface PropFacts {
  level: string;
  /** Quads, for a tiled prop. Triangles are what a textured one counts. */
  quads?: number;
  tris?: number;
  /** Distinct material slots. A tiled prop always has one (or none, when it is untextured clay). */
  materials?: number;
  /** The tile a tiled prop wears, or null for untextured clay. */
  tile?: string | null;
  /** Display name of the level a reference prop was borrowed from. */
  from?: string;
}

const count = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * Describe a prop the way the editor should say it.
 *
 * Deliberately built from plain numbers rather than from a document handle: the three callers each already
 * hold different shapes (a placement plus the open document, a library entry plus its `LevelProps`, a
 * catalogue row over HTTP), and passing facts keeps this a pure function the suite can assert against
 * without standing any of that up.
 */
export function describeProp(facts: PropFacts): PropDescription {
  const kind = propKindOf(facts.level);
  const readOnly = !ownGeometry(facts.level);
  const parts: string[] = [];

  if (kind === 'tiled') {
    if (facts.quads !== undefined) parts.push(count(facts.quads, 'quad'));
    parts.push(facts.tile ? 'one tile' : 'no tile — clay');
  } else {
    if (facts.tris !== undefined) parts.push(count(facts.tris, 'tri'));
    if (facts.materials !== undefined) parts.push(count(facts.materials, 'material'));
  }
  if (facts.from) parts.push(`from ${facts.from}`);
  if (readOnly) parts.push('read-only');

  return {
    kind,
    label: kind === 'tiled' ? 'Tiled prop' : 'Textured prop',
    detail: parts.join(' · '),
    note: kind === 'tiled'
      ? 'Every quad wears the whole tile, so it wraps and scrolls. Reshaping is free — the mapping is '
        + 'computed, not stored.'
      : readOnly
        ? 'It carries its own UV layout. Make an editable copy to change it.'
        : 'It carries its own UV layout, so edit it where UVs can be re-authored. Tiles live in the '
          + 'Texture Library.',
    readOnly,
  };
}
