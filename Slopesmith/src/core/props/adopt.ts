import { makeTexRef } from '../paint/textures';
import type { LevelProps, PropModel } from '../reference/props';
import type { ImportedPropRecord } from './imported';

/**
 * Take a prop the author does not own — a shipped level's model — into their own library, unchanged.
 *
 * This is the honest conversion, and the reason it exists is that the OTHER one is not. Baking a reference
 * prop into a tiled cage (`reviseModelFromProp`) throws its UV layout away by construction: a tiled prop
 * computes its mapping as the full 0–1 rect per quad, and a shipped prop's UVs are nothing of the sort.
 * Measured on GARI's river, each segment spans the tile exactly ONCE across two quads, split at `0.532`
 * where the bend falls — so the same geometry under the tiled rule would show the texture twice. Not lossy
 * but close: a different mapping.
 *
 * A **textured** record has room for all of it, because a reference prop and an imported GLB are the same
 * shape of thing (docs/032: "`PropSub` already IS per-material submesh with real UVs and indexed triangles").
 * So this is a re-pack rather than a conversion — the geometry is already in the model-local raw cm every
 * record stores, and not one coordinate is touched.
 *
 * Two things do have to be rewritten:
 *
 *  - **Material ids become LOCAL** (0…n−1). A record's are, and the catalogue rebases them onto a running
 *    counter when it is assembled, so importing one model can never renumber another's (docs/032).
 *  - **Texture refs become CROSS-LEVEL.** A shipped material names a bare file in its own level's bank
 *    ("0106.png"); a record has no level of its own, so the ref is qualified to the one it came from
 *    ("GARI/0106.png") — the form `resolvePropTex` and the export's tile combiner both already take.
 *
 * That second one gets the copy DRAWING correctly and no further: an extracted level's bank is read-only, so
 * a ref into it is paint the author cannot change. Copying the pixels is `adoptRecordArt` on the server —
 * core cannot read one bank and write another — and it is what `/api/custom-prop-import?adopt=1` runs before
 * storing the record. Reading this file alone would leave you thinking a revised prop's art stays borrowed.
 */

/** What a shipped model becomes, plus what the caller needs to report. */
export interface AdoptedProp {
  record: Omit<ImportedPropRecord, 'id'>;
  /** Distinct source materials carried across. */
  materials: number;
  tris: number;
}

/** Typed array → base64, the packing `ImportedPropRecord` stores. `btoa` rather than `Buffer`, because core
 *  runs in the browser too. */
function pack(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * One shipped model as a stored record, keeping its UVs, its materials and whatever motion it declared.
 *
 * `level` is the bank the model's textures live in, which is the model's own level for a reference prop and
 * is what qualifies every bare ref. Untextured submeshes (`mat === -1`) get a real slot carrying a null
 * texture rather than being dropped: the renderer falls back to neutral clay for one, and losing the
 * geometry would be worse than losing the paint.
 */
export function recordFromReferenceProp(
  props: LevelProps, model: PropModel, name: string,
): AdoptedProp {
  // Source material id -> local slot, in first-seen order, so the record's own ids run 0…n−1.
  const slotOf = new Map<number, number>();
  const subs: ImportedPropRecord['subs'] = [];
  let tris = 0;

  for (const sub of model.subs) {
    if (!sub.indices.length) continue;
    let slot = slotOf.get(sub.mat);
    if (slot === undefined) slotOf.set(sub.mat, slot = slotOf.size);
    subs.push({
      mat: slot,
      pos: pack(sub.positions),
      // A shipped prop's UVs are already raw OBJ `vt` (bottom-left origin) — the exact convention a record
      // stores — so unlike the GLB path there is no V to flip here.
      uv: pack(sub.uvs),
      idx: pack(sub.indices),
      ...(Number.isInteger(sub.object) ? { object: sub.object } : {}),
    });
    tris += Math.floor(sub.indices.length / 3);
  }

  const materials: ImportedPropRecord['materials'] = [];
  for (const [sourceMat, slot] of [...slotOf.entries()].sort((a, b) => a[1] - b[1])) {
    const source = props.materials.get(sourceMat);
    const tex = source?.tex ? makeTexRef(props.level, source.tex) : null;
    const frames = (source?.frames ?? []).filter(Boolean).map(frame => makeTexRef(props.level, frame));
    materials[slot] = {
      id: slot,
      tex,
      // A flipbook's state list always begins at the material's own tile, which is the invariant every
      // shipped native flipbook holds and what the renderer draws at rest (docs/028).
      ...(tex && frames.length > 1 ? { frames: [tex, ...frames.slice(1)] } : {}),
      ...(source?.blend ? { blend: true } : {}),
      ...(source?.alphaMode ? { alphaMode: source.alphaMode } : {}),
      // Only an imported GLB ever declares this; a shipped model's motion lives in its level's own effect
      // graphs. Carried anyway, so the one path serves both kinds of source.
      ...(source?.scroll ? { scroll: source.scroll } : {}),
    };
  }

  return {
    record: {
      name,
      tris,
      subs,
      materials,
      // Declared motion the MODEL owns. An extracted level sets neither (docs/032), so these are the
      // imported-source case; carrying them keeps one function honest for both.
      ...(model.emitters?.length ? { emitters: model.emitters as ImportedPropRecord['emitters'] } : {}),
      ...(model.animation ? { animation: model.animation } : {}),
    },
    materials: materials.length,
    tris,
  };
}

/** "Rail jump" → "Rail jump v2" → "Rail jump v3". Shared with the authored-model revision so a copy of
 *  either kind is named the same way. */
export function revisedPropName(name: string): string {
  const match = /^(.*) v(\d+)$/.exec(name);
  return match ? `${match[1]} v${Number(match[2]) + 1}` : `${name} v2`;
}
