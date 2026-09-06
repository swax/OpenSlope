import { randomUUID } from 'node:crypto';
import { AUTHORED_MODEL_LEVEL, modelIdFromNumber, modelNumber } from '../../core/doc/models';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { AuthoredModel } from '../../core/doc/types';
import {
  authoredModelPortal, cageFromPortal, importedGeometryFromPortal, importedPropPortal, portalGlb,
  type CageUpdate, type PortalKind, type PortalMesh,
} from '../../core/blender/portal';
import { CUSTOM_TEX_LEVEL, makeTexRef, parseTexRef } from '../../core/paint/textures';
import { IMPORTED_PROP_LEVEL, type ImportedPropRecord } from '../../core/props/imported';
import type { EncodeImage } from '../../core/props/glb-encode';
import { projectAssetPath } from '../project-assets';
import { listProjects } from '../projects';
import { ensureDir, readJsonOr, writeJsonAtomic } from '../fs-async';
import { listImportedProps, replaceImportedProp } from './imported-props';
import {
  customTextureExists, readReferenceTextureBytes, replaceCustomTextureArt, saveCustomTexture,
} from './textures';

/**
 * The Blender bridge's server half (docs/046) — what a checked-out model is, and what happens when one comes
 * back.
 *
 * The two libraries the escape hatch serves diverge on where the geometry LIVES, and that is the whole shape
 * of this file. An imported prop (`@import`) is a record on disk the server owns outright, so a push-back is
 * applied HERE: the record is rewritten in place, keeping its number and name, and every placement in every
 * mountain follows it the moment the catalogue is refetched. An authored model (`@models`) is a definition
 * inside the open document, which belongs to the browser — so a push-back is parked in a per-mountain INBOX
 * and the editor applies it as an ordinary undoable edit. That asymmetry is deliberate: writing the document
 * from here would put an author's geometry beyond Ctrl+Z, and the one thing an escape hatch must never do is
 * make the trip out of Slopesmith harder to take back than it was to take.
 *
 * A pushed TILE splits along the same line for the same reason. The bank is on disk, so the art is written
 * here; but a replaced tile's ref MOVES (docs/038 — a stored name is an identity), and the painted cells and
 * model textures wearing that ref are in the document, so the move is parked in the same inbox.
 */

/** One row of what Blender can pull. */
export interface BlenderCatalogueEntry {
  kind: PortalKind;
  /** The model NUMBER placements persist. */
  id: number;
  name: string;
  /** The prop-library level this model belongs to, so a caller can name it the way the editor does. */
  level: string;
  /** Faces the artist will see — quads for a cage, triangles for an imported record. */
  faces: number;
  verts: number;
  /** True for a quad cage, whose polygons round-trip as quads. */
  cage: boolean;
}

export interface BlenderCatalogue {
  /** The mountain these models came out of — the one named by `?project=`, or the one the editor has open. */
  project: { id: string; name: string };
  /** Every mountain on this server, so the add-on can offer a picker rather than only ever showing whichever
   *  map a browser tab happens to have open. Ids only travel back as `?project=`; the folder each lives in is
   *  deliberately not sent. */
  maps: { id: string; name: string }[];
  models: BlenderCatalogueEntry[];
}

/**
 * How the addon fetches a tile's PNG. The bare `/api/texture` route already serves both an extracted level's
 * bank and a mountain's own Custom one, so the bridge adds no serving path of its own.
 *
 * The mountain is NAMED, and it has to be. A `Custom/` ref addresses the bank of exactly one mountain — each
 * map's assets are its own — and the addon carries no tab id and no session, so an unqualified URL resolves
 * against whichever map happens to be active. Pulling from the mountain picker while a browser tab sits on a
 * different one is the supported flow (docs/046) and is precisely the case that would answer 404, or worse,
 * with another mountain's tile of the same name.
 *
 * An extracted level's bank is global and needs none of this. It is sent anyway: a URL whose correctness
 * depends on which kind of ref it happens to name is a URL that gets built wrong later.
 */
const textureUrl = (project: string) => (ref: string): string => {
  const { level, name } = parseTexRef(ref);
  return `/api/texture?level=${encodeURIComponent(level)}&name=${encodeURIComponent(name)}`
    + `&project=${encodeURIComponent(project)}`;
};

const authoredModels = (document: EditDoc): AuthoredModel[] => document.models ?? [];

/** How many bytes a base64 string decodes to, from its length and its padding alone. */
function base64Bytes(encoded: string): number {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, (encoded.length / 4) * 3 - padding);
}

/** Everything in the open mountain that can go out to Blender: the author's OWN geometry, both kinds. An
 *  extracted level's props are deliberately absent — they are the reference, not the work (docs/032), and
 *  the way to edit one is to revise it into a model first (docs/028). */
export async function blenderCatalogue(
  project: { id: string; name: string }, document: EditDoc,
): Promise<BlenderCatalogue> {
  const models: BlenderCatalogueEntry[] = authoredModels(document).map(model => ({
    kind: 'model' as const,
    id: modelNumber(model.id),
    name: model.name,
    level: AUTHORED_MODEL_LEVEL,
    faces: model.quads.length,
    verts: model.vertices.length / 3,
    cage: true,
  }));
  for (const { record } of await listImportedProps()) {
    models.push({
      kind: 'import', id: record.id, name: record.name, level: IMPORTED_PROP_LEVEL,
      faces: record.tris,
      // Counted off the base64 LENGTH rather than by decoding every submesh: this is a catalogue row, and
      // unpacking a fifty-thousand-triangle record to put a number beside its name is not worth the pass.
      verts: record.subs.reduce((n, sub) => n + Math.floor(base64Bytes(sub.pos) / 12), 0),
      cage: false,
    });
  }
  const maps = (await listProjects())
    .map(entry => ({ id: entry.id, name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { project, maps, models };
}

function findAuthoredModel(document: EditDoc, id: number): AuthoredModel {
  const wanted = modelIdFromNumber(id);
  const model = authoredModels(document).find(candidate => candidate.id === wanted);
  if (!model) throw new Error(`this mountain has no authored model ${id}`);
  return model;
}

async function findImportedRecord(id: number): Promise<ImportedPropRecord> {
  const found = (await listImportedProps()).find(entry => entry.record.id === id);
  if (!found) throw new Error(`this mountain has no imported model ${id}`);
  return found.record;
}

/** One checked-out model as the portal payload the addon builds a Blender mesh from. */
export async function blenderPortal(document: EditDoc, projectId: string, kind: PortalKind, id: number):
Promise<PortalMesh> {
  const tile = textureUrl(projectId);
  if (kind === 'model') {
    const model = findAuthoredModel(document, id);
    return authoredModelPortal(model, projectId, model.texture ? tile(model.texture) : undefined);
  }
  return importedPropPortal(await findImportedRecord(id), projectId, tile);
}

/**
 * The same model as a self-contained GLB, for a tool that is not the addon.
 *
 * Every referenced tile is read out of the bank and EMBEDDED, because the point of this file is that it can
 * be opened somewhere Slopesmith is not. A tile that cannot be read is left off rather than failing the
 * export: an untextured material in Blender is a recoverable annoyance, and no file at all is not.
 */
export async function blenderPortalGlb(mesh: PortalMesh): Promise<Uint8Array> {
  const images: EncodeImage[] = [];
  const imageOfSlot = new Map<number, number>();
  for (const material of mesh.materials) {
    if (!material.tex) continue;
    const { level, name } = parseTexRef(material.tex);
    try {
      const bytes = await readReferenceTextureBytes(level, name);
      imageOfSlot.set(material.id, images.length);
      images.push({ name: material.tex, mimeType: 'image/png', bytes: new Uint8Array(bytes) });
    } catch { /* a missing tile draws as clay in Blender, which is legible; a failed export is not */ }
  }
  return portalGlb(mesh, images, slot => imageOfSlot.get(slot) ?? null);
}

// ---- push-back --------------------------------------------------------------------------------------

/** What a push did, in the words the toast and the addon's status line both use. */
export interface BlenderPushResult {
  kind: PortalKind;
  id: number;
  name: string;
  faces: number;
  /** Set when the change is waiting for the editor to apply it (an authored model), rather than already
   *  stored (an imported record). */
  pending?: boolean;
  /** Loops the cage had to split, and loops it dropped — surfaced rather than swallowed. */
  fanned?: number;
  dropped?: number;
  /** Material slots the pushed mesh referenced beyond the ones the record had. */
  addedMaterials?: number;
  /** Tiles this push wrote, and how many of those landed as a NEW Custom tile rather than replacing the one
   *  the slot already wore. */
  textures?: number;
  forkedTextures?: number;
}

// ---- the art -----------------------------------------------------------------------------------------

/** What a push's tiles did — where each slot's art ended up, and which refs the rest of the mountain has to
 *  follow. */
export interface TexturePushResult {
  /** Slot id → the tile ref that slot must now wear. Only the slots whose art actually changed. */
  slotTex: Map<number, string>;
  /**
   * Custom refs that MOVED, so everything else wearing them can follow (docs/038 — a stored name is an
   * identity, so new art lands under a new one). The imported records were repointed here; the live
   * document's painted cells and model tiles are the editor's to move, through the inbox.
   */
  moved: { from: string; to: string }[];
  written: number;
  forked: number;
}

/**
 * The art half of a push: land each changed slot's tile in the mountain's Custom bank.
 *
 * There are exactly two outcomes and which one applies is decided by where the slot's CURRENT tile lives,
 * because that is the same line every other part of Slopesmith draws:
 *
 *  * **Custom** — the mountain's own art, so this is a REPLACE, and it is the same `replaceCustomTextureArt`
 *    the Texture Library's ⟳ replace art performs. Everything wearing the tile follows it, which is what an
 *    author who painted over their own texture meant.
 *  * **anything else** — an extracted level's bank, or no tile at all. That art is the REFERENCE, never
 *    written (docs/032), so the push FORKS: the tile lands as a new Custom one named after the prop and only
 *    this slot is repointed at it. `GARI/0012.png` still means what it meant this morning.
 *
 * A slot that carried no `png` is skipped entirely, so an ordinary geometry push writes nothing and cannot
 * disturb a tile that other props share.
 */
export async function applyTexturePushes(mesh: PortalMesh): Promise<TexturePushResult> {
  const slotTex = new Map<number, string>();
  const moved: { from: string; to: string }[] = [];
  let written = 0, forked = 0;

  for (const material of mesh.materials) {
    if (!material.png) continue;
    const bytes = Buffer.from(material.png, 'base64');
    if (!bytes.length) continue;
    const wearing = material.tex ? parseTexRef(material.tex) : null;
    const ours = wearing?.level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()
      && await customTextureExists(wearing.name);
    if (ours) {
      const { name, replaced } = await replaceCustomTextureArt(wearing!.name, bytes);
      const to = makeTexRef(CUSTOM_TEX_LEVEL, name);
      moved.push({ from: makeTexRef(CUSTOM_TEX_LEVEL, replaced), to });
      slotTex.set(material.id, to);
    } else {
      // Named for the PROP, not for the tile it forked from: "0012" is a page number in somebody else's
      // atlas, and the author looking for this art in the Texture Library later will look for the prop.
      // Spaces are spelled `_` rather than left for `safeDataName` to drop, which would give "Railjump".
      const stem = (mesh.stamp.name + (mesh.materials.length > 1 ? ` ${material.id + 1}` : ''))
        .replace(/\s+/g, '_');
      slotTex.set(material.id, makeTexRef(CUSTOM_TEX_LEVEL, await saveCustomTexture(stem, bytes)));
      forked++;
    }
    written++;
  }
  return { slotTex, moved, written, forked };
}

/**
 * An imported prop's push-back: rewrite its geometry, keep everything else.
 *
 * The material TABLE is preserved by slot and extended when the pushed mesh reaches past it, so a Blender
 * session that split one surface into two lands two slots — the second untextured, ready for a tile from the
 * Texture Library. Emitters, the declared clip and the flipbook lists are carried verbatim: they are
 * declarations the model made about itself, and a geometry edit is not a statement about any of them.
 *
 * `slotTex` is where a texture push lands, and it is applied AFTER the table is extended so a slot the artist
 * invented in Blender can arrive already wearing the art they painted on it.
 */
export async function applyImportedPush(mesh: PortalMesh, slotTex?: ReadonlyMap<number, string>):
Promise<BlenderPushResult> {
  const record = await findImportedRecord(mesh.stamp.id);
  const geometry = importedGeometryFromPortal(mesh, record.materials.length);
  const materials = [...record.materials];
  for (let i = 0; i < geometry.addedMaterials; i++) materials.push({ id: materials.length, tex: null });
  const { id: _id, name: _name, ...rest } = record;
  await replaceImportedProp(record.id, {
    ...rest, tris: geometry.tris, subs: geometry.subs,
    materials: materials.map(material =>
      slotTex?.has(material.id) ? { ...material, tex: slotTex.get(material.id)! } : material),
  });
  return {
    kind: 'import', id: record.id, name: record.name, faces: geometry.tris,
    ...(geometry.addedMaterials ? { addedMaterials: geometry.addedMaterials } : {}),
  };
}

/** A push-back the editor has not applied yet. Held whole rather than as a diff: the tab that picks it up
 *  may be a different tab from the one that sent the model out, and it has to be able to apply this without
 *  having seen anything that came before. */
export interface PendingCagePush {
  token: string;
  at: number;
  kind: 'model';
  id: number;
  name: string;
  /** Already reduced to the two channels a model record stores, so the browser applies it without carrying
   *  the portal format into the document layer. */
  cage: CageUpdate;
  /** The tile the model must now wear, when the same push brought art back for it (docs/046). Absent means
   *  the model's texture is not part of this change. */
  texture?: string;
}

/**
 * A Custom tile's ref moved, and the document has to follow it.
 *
 * The stored half of a replace happens on the server — imported records are repointed by
 * `replaceCustomTextureArt` — but painted terrain cells and the tile an authored model wears live in the open
 * document, and a route must not write that. So the move is parked here and the editor applies it with the
 * same `retargetDocTex` the Texture Library's own ⟳ replace art uses, as one undoable edit.
 */
export interface PendingRetexPush {
  token: string;
  at: number;
  kind: 'retex';
  from: string;
  to: string;
}

export type PendingBlenderPush = PendingCagePush | PendingRetexPush;

/** The most pushes of ONE kind an inbox holds. A queue is a symptom — nothing drains it but an open editor —
 *  so it keeps the newest few and drops the rest rather than growing without bound behind a closed tab.
 *  Counted per kind so a burst of cages cannot push the ref moves out from under them. */
const MAX_PENDING = 8;

const inboxFile = () => projectAssetPath('blender', 'pending.json');

async function readInbox(): Promise<PendingBlenderPush[]> {
  const stored = await readJsonOr<{ pushes?: unknown }>(inboxFile(), {});
  return Array.isArray(stored.pushes) ? stored.pushes as PendingBlenderPush[] : [];
}

/** Keep the newest few of each kind, in the order they were queued. */
function trimInbox(pushes: PendingBlenderPush[]): PendingBlenderPush[] {
  const keep = new Set([
    ...pushes.filter(push => push.kind === 'model').slice(-MAX_PENDING),
    ...pushes.filter(push => push.kind === 'retex').slice(-MAX_PENDING),
  ]);
  return pushes.filter(push => keep.has(push));
}

async function writeInbox(pushes: PendingBlenderPush[]): Promise<void> {
  await ensureDir(projectAssetPath('blender'));
  await writeJsonAtomic(inboxFile(), { pushes: trimInbox(pushes) });
}

/**
 * An authored model's push-back: park it for the editor.
 *
 * A second push of the same model REPLACES the first rather than queueing behind it. The inbox holds whole
 * states, not edits, so two of them are not two changes to apply — they are one change described twice, and
 * applying the stale one first would flash the older geometry through the viewport and into the undo stack.
 */
export async function queueModelPush(mesh: PortalMesh, texture?: string): Promise<BlenderPushResult> {
  const cage = cageFromPortal(mesh, mesh.anchor);
  if (!cage.quads.length) throw new Error('that mesh has no faces a cage can hold');
  const push: PendingCagePush = {
    token: randomUUID(), at: Date.now(), kind: 'model', id: mesh.stamp.id, name: mesh.stamp.name, cage,
    ...(texture ? { texture } : {}),
  };
  const held = (await readInbox()).filter(pending => pending.kind !== 'model' || pending.id !== push.id);
  await writeInbox([...held, push]);
  return {
    kind: 'model', id: push.id, name: push.name, faces: cage.quads.length, pending: true,
    ...(cage.fanned ? { fanned: cage.fanned } : {}),
    ...(cage.dropped ? { dropped: cage.dropped } : {}),
  };
}

/**
 * Park the ref moves a texture push made, so the document follows them.
 *
 * Unlike a cage, these are a CHAIN rather than a state: pushing the same tile twice takes `bark` to `bark_2`
 * and then to `bark_3`, and a document that only heard about the second move would still be wearing a ref
 * that no longer exists. So a move whose source is a move already waiting EXTENDS it — one entry per tile,
 * always naming the ref the document actually holds, and bounded however long the tab stays closed.
 */
export async function queueTextureRetarget(moves: readonly { from: string; to: string }[]): Promise<void> {
  if (!moves.length) return;
  const held = await readInbox();
  for (const move of moves) {
    const chained = held.find(push => push.kind === 'retex' && push.to === move.from) as
      PendingRetexPush | undefined;
    if (chained) { chained.to = move.to; chained.at = Date.now(); continue; }
    held.push({ token: randomUUID(), at: Date.now(), kind: 'retex', from: move.from, to: move.to });
  }
  await writeInbox(held);
}

export async function pendingBlenderPushes(): Promise<PendingBlenderPush[]> {
  return readInbox();
}

/** Drop one applied push. Missing is not an error: the goal state is "the editor and the inbox agree", and
 *  two tabs racing to apply the same push both reach it. */
export async function ackBlenderPush(token: string): Promise<boolean> {
  const held = await readInbox();
  const kept = held.filter(pending => pending.token !== token);
  if (kept.length === held.length) return false;
  await writeInbox(kept);
  return true;
}
