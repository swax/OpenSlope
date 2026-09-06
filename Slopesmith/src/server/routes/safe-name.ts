import { readJsonOr, writeJsonAtomic } from '../fs-async';
import { serialize } from '../serialize';
import { safeDataName } from '../../core/export/names';

/** Keep one extracted-data path segment within the filename alphabet used by SSX level assets. Defined in
 *  core, because the names an export bakes into a folder go through the same sanitiser. */
export { safeDataName };

/** A stem may collect this many `_2`, `_3`… variants before the uploader is asked for a real name. Reaching
 *  it means a loop is uploading under one name, not that someone loaded a thousand versions of a tile. */
const MAX_NAME_VARIANTS = 1000;

/** One queue per library, ordering everything that takes or frees a name in it. A name is picked by reading
 *  the library and then writing to it, so without this two uploads of one name both see `stem_2` free and
 *  both claim it, and a delete racing an upload lets the upload take a name the delete is retiring. Unrelated
 *  libraries never wait on each other. */
const nameLock = (library: string): string => `asset-name:${library}`;

/** Where a library's retired names live: one JSON list of stems beside the folder it describes, so
 *  `…/Custom/Textures` is answered by `…/Custom/Textures.retired.json` and the record is never mistaken for
 *  a member of the library it belongs to. */
export const retiredNamesFile = (library: string): string => `${library}.retired.json`;

/** Retired stems, lowercased for comparison — a name and its case variants address one file on a
 *  case-insensitive filesystem, so they retire together. */
async function readRetiredNames(library: string): Promise<string[]> {
  const stored = await readJsonOr<unknown>(retiredNamesFile(library), []);
  return Array.isArray(stored) ? stored.filter((name): name is string => typeof name === 'string') : [];
}

/** Add one stem to the record. Callers hold the library's name lock, so this read-modify-write is safe. */
async function recordRetiredName(library: string, name: string): Promise<void> {
  const stem = safeDataName(name);
  if (!stem) return;
  const retired = await readRetiredNames(library);
  if (retired.some(previous => previous.toLowerCase() === stem.toLowerCase())) return;
  await writeJsonAtomic(retiredNamesFile(library), [...retired, stem]);
}

export interface FreeNameStore<T> {
  /** The directory the name is claimed in, and the library whose retired names and queue apply. */
  library: string;
  /** What the uploader called it, before sanitising. */
  name: string;
  /** The stem to use when nothing survives sanitising ('texture', 'sound', …). */
  fallback: string;
  /** Whether a stem is already spoken for on disk in `library`. Retired stems are also taken, and that is
   *  applied here rather than by each caller. */
  taken(stem: string): Promise<boolean>;
  /** Write the asset under the stem that was free. */
  write(stem: string): Promise<T>;
  /** A name this operation frees rather than deletes — a rename's source. Retired once the write succeeds,
   *  inside the same locked section that picked the new name. */
  retires?: string;
  /**
   * Names this asset has held before, which it alone may take back.
   *
   * A retired stem is taken by everything ELSE in the library, which is the whole of what retiring is for: the
   * next upload of `snow` must not be served the bytes a ref called `snow` used to name. Handing a name back
   * to the asset that retired it names the same bytes it always did, so nothing is reissued — and without this
   * an asset can never return to a name it has passed through. That is what a map restored to a revision
   * authored under an older name needs, and it is what keeps restoring the same checkpoint twice from walking
   * the name up a suffix each time.
   */
  reclaims?: readonly string[];
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Store an asset under a name that is free: the sanitised stem, or `stem_2`, `stem_3`, … when it is taken.
 *
 * An uploaded name never lands on someone else's bytes (docs/038). That makes a stored ref name bytes which
 * cannot change, which is what lets every consumer — painted cells, model materials, a checkpoint's record of
 * what it was authored against, an HTTP cache — treat the ref as an identity rather than a lookup that might
 * answer differently tomorrow.
 *
 * A name that has been retired counts as taken, so an asset's name is spoken for by the library forever, not
 * only while its file is there. Names never overwrite, so names are never reused.
 *
 * Picking the name and writing it is one read-modify-write over the library folder, so it runs serialized.
 */
export async function storeUnderFreeName<T>(store: FreeNameStore<T>): Promise<{ name: string; stored: T }> {
  return serialize(nameLock(store.library), async () => {
    const retired = new Set((await readRetiredNames(store.library)).map(name => name.toLowerCase()));
    for (const name of store.reclaims ?? []) retired.delete(name.toLowerCase());
    const stem = safeDataName(store.name) || store.fallback;
    let name = stem;
    for (let variant = 2; retired.has(name.toLowerCase()) || await store.taken(name); variant++) {
      if (variant > MAX_NAME_VARIANTS)
        throw new Error(`there are already ${MAX_NAME_VARIANTS} assets named ${stem} — give this one its own name`);
      name = `${stem}_${variant}`;
    }
    const stored = await store.write(name);
    // A name that resolved back to the one being freed was never freed: `snow` renamed onto a taken `powder`
    // lands on `snow` again, and retiring it would leave the asset wearing a name nothing may ever take.
    if (store.retires && !sameName(name, store.retires)) await recordRetiredName(store.library, store.retires);
    return { name, stored };
  });
}

/**
 * Remove an asset and retire its name, so the name is never issued again.
 *
 * Deleting is the one thing that could hand a live ref to different bytes: the name goes back in the pool,
 * the next upload of it is served from the same URL, and everyone holding that URL — a painted cell, a
 * checkpoint, an HTTP cache with an hour left on it — silently follows art nobody repointed them to. Retiring
 * the name means the next upload of `snow` lands as `snow_2`, exactly as it would have while the original
 * was still there.
 *
 * `remove` reports whether it actually freed the name; a delete of something that was not there records
 * nothing. Both halves run under the library's name lock, so an upload racing a delete either finds the file
 * or finds the name retired, never a gap between them.
 */
export async function retireName(library: string, name: string, remove: () => Promise<boolean>): Promise<boolean> {
  return serialize(nameLock(library), async () => {
    const removed = await remove();
    if (removed) await recordRetiredName(library, name);
    return removed;
  });
}
