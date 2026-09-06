import { CUSTOM_TEX_LEVEL, makeTexRef, parseTexRef } from '../../core/paint/textures';
import type { ImportedPropRecord } from '../../core/props/imported';
import { readReferenceTextureBytes, saveSharedCustomTexture } from '../routes/textures';

/**
 * The other half of adopting a shipped prop (docs/032, docs/046): bring its ART into the mountain too.
 *
 * `recordFromReferenceProp` re-packs the geometry and qualifies each material's ref to the bank it came out
 * of — "GARI/0106.png" — which resolves correctly and is *not* editable. An extracted level's bank is the
 * reference, never written, so the copy's mesh belongs to the author while its paint does not: the Texture
 * Library will not manage that tile, `⟳ replace art` cannot reach it, and a texture generated over it has
 * nowhere to land. That is half a copy, and "revise" does not mean half.
 *
 * So every ref that is not already the mountain's own is READ out of its bank and stored as a Custom tile,
 * and the record is repointed at what it got. From then on the prop is self-contained: it holds no dependency
 * on the level it came from, which is also what an export of a mountain the receiver has no GARI for needs.
 *
 * ## Why the bank does not fill up with duplicates
 *
 * A retail prop's tile is usually an ATLAS PAGE that a dozen props share, so adopting a dozen of them looks
 * like it should spend a dozen slots of the Custom bank — and later a dozen pages of a PS2 texture budget —
 * on a dozen copies of one image. It does not, because staging goes through `saveSharedCustomTexture`: a name
 * that is taken by THE SAME BYTES is not taken at all, compared against the canonical re-encoding rather than
 * the source file. Twelve adoptions off one page land one tile and twelve refs to it.
 *
 * That is the fact this whole decision rests on. Without it, copying the art eagerly would be the wrong
 * trade and the art would have to stay a pointer until something actually painted on it.
 */

/** What staging did, for the caller's toast. */
export interface AdoptedArt {
  /** Distinct refs moved into the Custom bank. Not the number of FILES written — a page this mountain had
   *  already adopted for another prop is landed on rather than copied, which is the point above. */
  staged: number;
  /** Refs whose bank could not be read. Left pointing where they were: a prop that still draws against the
   *  reference is better than one holding a ref to nothing. */
  missing: number;
}

/**
 * Stage a record's texture refs into the open mountain's Custom bank, in place.
 *
 * Named for the SOURCE rather than for the prop: one page is worn by many props, so calling it after
 * whichever one happened to adopt it first would be a lie the Texture Library then shows to everyone. The
 * level prefix keeps two banks' `0106.png` apart before the byte comparison has to.
 */
export async function adoptRecordArt(record: Omit<ImportedPropRecord, 'id'>): Promise<AdoptedArt> {
  const done = new Map<string, string | null>();
  const art: AdoptedArt = { staged: 0, missing: 0 };

  const stage = async (ref: string): Promise<string> => {
    const { level, name } = parseTexRef(ref);
    if (!level || level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()) return ref;
    const already = done.get(ref);
    if (already !== undefined) return already ?? ref;
    let landed: string | null = null;
    try {
      const bytes = await readReferenceTextureBytes(level, name);
      landed = makeTexRef(CUSTOM_TEX_LEVEL,
        await saveSharedCustomTexture(`${level}_${name.replace(/\.png$/i, '')}`, bytes));
      art.staged++;
    } catch {
      art.missing++;
    }
    done.set(ref, landed);
    return landed ?? ref;
  };

  for (const material of record.materials ?? []) {
    if (material.tex) material.tex = await stage(material.tex);
    if (material.frames?.length) {
      const frames: string[] = [];
      for (const frame of material.frames) frames.push(await stage(frame));
      // A flipbook's list always begins at the material's own tile (docs/028), and staging must not be the
      // thing that breaks that — both went through the same map, so re-heading it is just belt and braces.
      material.frames = material.tex ? [material.tex, ...frames.slice(1)] : frames;
    }
  }
  return art;
}
