import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectAssetPath } from '../project-assets';
import { ensureDir, listDir, mapLimit, pathExists, readJsonOr, writeJsonAtomic, READ_CONCURRENCY } from '../fs-async';
import { retireName, safeDataName, storeUnderFreeName } from './safe-name';
import { IMPORTED_PROP_LEVEL, type ImportedPropRecord } from '../../core/props/imported';
import type { PropsPayload } from '../../core/reference/props';
import { propAlphaMode } from '../../core/reference/props';

/**
 * Storage for IMPORTED props (docs/032) — the GLB models a user loads through the Prop Library's Custom
 * view, kept as one JSON record per model under the open mountain's `assets/props/`.
 *
 * The record is already in `PropsPayload`'s base64 packing, so serving the catalogue is a remap rather than
 * a re-encode, and the client decodes it with the same `decodeProps` every extracted level goes through.
 * Textures are NOT stored here: import stages them into the same mountain's `assets/textures/` through the ordinary
 * texture-upload route and the record just carries "Custom/<name>.png" refs (docs/005).
 */

const JSON_EXT = /\.json$/i;
const importedDir = () => projectAssetPath('props');

/** The catalogue's model-number high-water mark, beside the folder it describes — the same sidecar shape
 *  retired names use, so `…/assets/props` is answered by `…/assets/props.nextid.json`. */
const nextIdFile = () => `${importedDir()}.nextid.json`;

/**
 * The next model number to issue, and the record of it.
 *
 * Numbers cannot come from `max(existing) + 1` alone once a model can be DELETED: removing the newest record
 * would hand its number straight to the next import, and every placement still holding that number — in
 * this mountain's retained history or undo stack — would silently start drawing different
 * geometry. That is the id-shaped version of what retiring a name prevents for bytes (docs/038), so a
 * deleted number is spent the same way a deleted name is.
 *
 * The high-water mark is stored rather than derived, and the reader takes the larger of the two so a
 * catalogue written before this file existed (or one restored from a backup without it) still allocates
 * above everything it holds.
 */
async function issueModelNumber(): Promise<number> {
  const stored = await readJsonOr<{ next?: unknown }>(nextIdFile(), {});
  const floor = (await listImportedProps()).reduce((max, e) => Math.max(max, e.record.id), -1) + 1;
  const id = Math.max(typeof stored.next === 'number' && Number.isInteger(stored.next) ? stored.next : 0, floor);
  await writeJsonAtomic(nextIdFile(), { next: id + 1 });
  return id;
}

/** The stored record with this model number, and the file it lives in. */
async function findImportedProp(id: number): Promise<{ file: string; record: ImportedPropRecord }> {
  const found = (await listImportedProps()).find(e => e.record.id === id);
  if (!found) throw new Error(`no imported prop ${id}`);
  return found;
}

/** The file stem a display name stores under: sanitised to the level-asset alphabet, `prop` when nothing
 *  survives. A model's NAME is free text (an import derives "old lamp post" from the file), so unlike a
 *  tile it is never refused for its characters — only the storage name is constrained. */
const propStem = (name: string) => safeDataName(name) || 'prop';

/** Every stored record, in stable file order. A file that fails to parse is skipped rather than poisoning
 *  the whole catalogue — one bad import must not cost the user every other model they have loaded. */
export async function listImportedProps(): Promise<{ file: string; record: ImportedPropRecord }[]> {
  const dir = importedDir();
  const files = (await listDir(dir)).filter(f => JSON_EXT.test(f)).sort((a, b) => a.localeCompare(b));
  const records = await mapLimit(files, READ_CONCURRENCY,
    file => readJsonOr<ImportedPropRecord | null>(join(dir, file), null));
  return files.flatMap((file, index) => {
    const record = records[index];
    // An unreadable record is skipped rather than poisoning the catalogue.
    return record && Number.isInteger(record.id) && Array.isArray(record.subs) ? [{ file, record }] : [];
  });
}

/**
 * Store one imported model, returning the record as saved and the file it landed in. The file name is
 * returned rather than left for the caller to re-derive: it is sanitised to `safeDataName`'s alphabet (which
 * keeps hyphens and underscores and drops everything else) and then stepped past any name already in the
 * catalogue, so a second guess at it is a bug waiting to happen.
 *
 * Importing under a name that is taken lands beside the original as `name_2` (docs/038), and every stored
 * record gets its own model number from `issueModelNumber`. That pairing is what makes numbers safe:
 * placements persist the number, so a record's number must name the same geometry for as long as the record
 * exists, and a number is never reused.
 */
export async function saveImportedProp(name: string, record: Omit<ImportedPropRecord, 'id'>):
  Promise<{ file: string; record: ImportedPropRecord }> {
  const dir = importedDir();
  const { name: stem, stored } = await storeUnderFreeName({
    library: dir,
    name: name.replace(/\.(glb|gltf|json)$/i, ''),
    fallback: 'prop',
    taken: candidate => pathExists(join(dir, `${candidate}.json`)),
    write: async stored => {
      await ensureDir(dir);
      const saved: ImportedPropRecord = { ...record, id: await issueModelNumber() };
      await writeFile(join(dir, `${stored}.json`), JSON.stringify(saved));
      return saved;
    },
  });
  return { file: `${stem}.json`, record: stored };
}

/**
 * Rename an imported model: the display name the library grid shows, and the file it stores under.
 *
 * The model NUMBER does not move, so every placement keeps pointing at the same geometry — a rename is a
 * label change, not a re-import. The two names are kept in step (a record called "Snow gun" living in
 * `oldname.json` is only ever confusing), which means the file plays by the library's naming rules: it steps
 * past a stem that is taken, and the stem it leaves is retired like any freed name. The display name is
 * whatever was typed, because nothing addresses a model by it.
 */
export async function renameImportedProp(id: number, to: string):
  Promise<{ id: number; name: string; file: string }> {
  const dir = importedDir();
  const { file, record } = await findImportedProp(id);
  const display = to.trim();
  if (!display) throw new Error('a model needs a name');
  const source = file.replace(JSON_EXT, '');
  const { name: stem } = await storeUnderFreeName({
    library: dir,
    name: propStem(display),
    fallback: 'prop',
    taken: candidate => candidate.toLowerCase() === source.toLowerCase()
      ? Promise.resolve(false)   // its own file is not in its way
      : pathExists(join(dir, `${candidate}.json`)),
    write: async stored => {
      await writeFile(join(dir, `${source}.json`), JSON.stringify({ ...record, name: display }));
      if (stored !== source) await rename(join(dir, `${source}.json`), join(dir, `${stored}.json`));
    },
    retires: source,
    reclaims: [source],
  });
  return { id, name: display, file: `${stem}.json` };
}

/** Copy a stored model under a new name and a NEW model number — the "keep this one before I replace it"
 *  move. Nothing already placed follows the copy: it starts unplaced, exactly like a fresh import. */
export async function cloneImportedProp(id: number, to: string):
  Promise<{ id: number; name: string; file: string }> {
  const { record } = await findImportedProp(id);
  const display = to.trim();
  if (!display) throw new Error('a model needs a name');
  const { id: _source, ...geometry } = record;
  const { file, record: saved } = await saveImportedProp(propStem(display), { ...geometry, name: display });
  return { id: saved.id, name: saved.name, file };
}

/**
 * Put new geometry on an existing model: the iterate-on-one-prop loop, and the reason a re-import of the
 * same file lands beside the original rather than over it.
 *
 * The record is written in place — same file, same model number, same display name — so every placement in
 * every mountain follows the new mesh. That is safe here in a way it is not for a texture (docs/038): the
 * mountain-local catalogue is served as one revalidated payload rather than per-model URLs, so no cache
 * holds a stale record, and the client re-registers the geometry against the number it already has.
 */
export async function replaceImportedProp(id: number, next: Omit<ImportedPropRecord, 'id' | 'name'>):
  Promise<{ id: number; name: string; file: string }> {
  // Import can only ever ADD a bad record; replace would write one over a model the author is already using,
  // and `listImportedProps` skips what it cannot read — so a malformed body would delete the model rather
  // than fail. Refuse it while the original is still on disk.
  const shape = next as Partial<ImportedPropRecord> | null;
  if (!shape?.subs?.length || !Array.isArray(shape.materials))
    throw new Error('that file did not convert to a model');
  const { file, record } = await findImportedProp(id);
  const saved: ImportedPropRecord = { ...next, id, name: record.name };
  await writeFile(join(importedDir(), file), JSON.stringify(saved));
  return { id, name: saved.name, file };
}

/**
 * Rewrite one stored model's MATERIAL table, leaving its geometry, clip and emitters exactly as they are.
 *
 * Narrower than `replaceImportedProp` on purpose: retexturing is an edit an author makes on a model they are
 * already using, so it must not be able to arrive carrying a different mesh. The incoming rows are matched to
 * the existing ones by id and only the assignable fields are taken — anything the record knows that the
 * client does not (a declared scroll, a field added later) survives an edit made by an older tab.
 */
export async function updateImportedPropMaterials(id: number, next: unknown):
  Promise<{ id: number; name: string; materials: ImportedPropRecord['materials'] }> {
  if (!Array.isArray(next)) throw new Error('materials must be an array');
  const { file, record } = await findImportedProp(id);
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const byId = new Map((next as { id?: unknown; tex?: unknown; frames?: unknown }[])
    .filter(row => !!row && Number.isInteger(row.id))
    .map(row => [row.id as number, row]));
  const materials = record.materials.map(material => {
    const edit = byId.get(material.id);
    if (!edit) return material;
    const tex = str(edit.tex);
    // A state list always begins at the material's own tile, so an edit cannot make one that starts
    // elsewhere — and dropping to a single frame is dropping the flipbook, not keeping a list of one.
    const rest = (Array.isArray(edit.frames) ? edit.frames.slice(1) : [])
      .map(str).filter((frame): frame is string => !!frame);
    const { frames: _drop, ...kept } = material;
    return tex && rest.length ? { ...kept, tex, frames: [tex, ...rest] } : { ...kept, tex };
  });
  await writeFile(join(importedDir(), file), JSON.stringify({ ...record, materials }));
  return { id, name: record.name, materials };
}

/** Delete a stored model and retire the name its file held, so a later import of that name lands beside it
 *  rather than answering for it. The model NUMBER is already spent — `issueModelNumber` never walks back —
 *  so a placement left holding it finds nothing rather than someone else's geometry. Missing is not an
 *  error: the goal state is "gone". */
export async function deleteImportedProp(id: number): Promise<boolean> {
  const dir = importedDir();
  const found = (await listImportedProps()).find(e => e.record.id === id);
  if (!found) return false;
  const stem = found.file.replace(JSON_EXT, '');
  return retireName(dir, stem, async () => {
    const file = join(dir, found.file);
    if (!await pathExists(file)) return false;
    await rm(file, { force: true });
    return true;
  });
}

/**
 * How many stored records wear this texture ref ("Custom/<name>.png").
 *
 * Imported models are the one place a custom tile is referenced from OUTSIDE the live document, so the
 * editor cannot see them when it counts what a delete would cost. Without this the Texture Library would
 * confidently report "used by 0 things" while a delete quietly untextures an imported prop.
 */
export async function countImportedTextureUsers(ref: string): Promise<number> {
  const wanted = ref.toLowerCase();
  return (await listImportedProps())
    .filter(({ record }) => record.materials?.some(m => (m.tex ?? '').toLowerCase() === wanted)).length;
}

/**
 * Repoint every imported record from one texture ref to another, returning how many records changed. Called
 * on RENAME only: a rename loses no information, so fixing the refs up is strictly a repair. Delete
 * deliberately does NOT call this — dropping a material's texture would edit the author's models as a side
 * effect of a library action, so delete reports the count and leaves the records alone.
 */
export async function retargetImportedTexture(from: string, to: string): Promise<number> {
  const wanted = from.toLowerCase();
  const affected = (await listImportedProps())
    .filter(({ record }) => record.materials?.some(m => (m.tex ?? '').toLowerCase() === wanted));
  await mapLimit(affected, READ_CONCURRENCY, async ({ file, record }) => {
    record.materials = record.materials.map(m => (m.tex ?? '').toLowerCase() === wanted ? { ...m, tex: to } : m);
    await writeFile(join(importedDir(), file), JSON.stringify(record));
  });
  return affected.length;
}

/**
 * The whole imported catalogue as one `PropsPayload` for the '@import' pseudo-level.
 *
 * Material ids are LOCAL to each record (0…n-1) and are rebased onto a running counter here, so importing a
 * model can never renumber another's materials — only the model NUMBER is a stable identity that placements
 * persist, and that comes from the record.
 */
export async function importedPropsPayload(): Promise<PropsPayload> {
  const models: PropsPayload['models'] = [];
  const materials: PropsPayload['materials'] = [];
  let matBase = 0;
  for (const { record } of await listImportedProps()) {
    for (const m of record.materials) {
      // A material's flipbook frames are stored as cross-level refs like its own tile, but the renderer
      // resolves a frame list against the bank the tile already named — so the wire carries bare names.
      const frames = m.frames?.map(ref => ref.slice(ref.indexOf('/') + 1)) ?? [];
      const alphaMode = propAlphaMode(m.alphaMode);
      materials.push({ id: matBase + m.id, tex: m.tex,
        ...(frames.length ? { frames } : {}),
        ...(m.blend ? { blend: true } : {}),
        ...(alphaMode ? { alphaMode } : {}),
        pixelAlpha: true,
        ...(m.scroll ? { scroll: m.scroll } : {}) });
    }
    models.push({
      id: record.id,
      name: record.name,
      subs: record.subs.map(s => ({ mat: matBase + s.mat, pos: s.pos, uv: s.uv, idx: s.idx,
        ...(Number.isInteger(s.object) ? { object: s.object } : {}) })),
      ...(record.emitters?.length ? { emitters: record.emitters } : {}),
      // Object indices are LOCAL to the record and stay that way — unlike materials, nothing shares the
      // hierarchy across models, so there is no counter to rebase against.
      ...(record.animation ? { animation: record.animation } : {}),
    });
    matBase += record.materials.length;
  }
  return { level: IMPORTED_PROP_LEVEL, models, materials, crowdFrames: [], instances: [] };
}
