import { createHash } from 'node:crypto';
import type { EditDoc } from '../core/doc/doc-edit';
import { effectNodeSoundFile } from '../core/effects/authoring';
import { CUSTOM_TEX_LEVEL, parseTexRef } from '../core/paint/textures';
import { IMPORTED_PROP_LEVEL, type ImportedPropRecord } from '../core/props/imported';
import { listDir, mapLimit, readBytesOrNull, READ_CONCURRENCY } from './fs-async';
import { createProject, finishProjectCreation, openProject, type ProjectSnapshot } from './projects';
import { listImportedProps, saveImportedProp } from './routes/imported-props';
import { saveCustomMusic } from './routes/music';
import { safeDataName } from './routes/safe-name';
import { saveCustomSky } from './routes/skybox';
import { saveCustomSound } from './routes/sounds';
import { saveCustomTexture } from './routes/textures';
import {
  initializeNativeProjectAssets, migrateLegacyProjectAssets, projectAssetPath, withProjectAssets,
} from './project-assets';
import {
  PROJECT_BUNDLE_SCHEMA, type BundleAsset, type BundleAssetKind, type ProjectBundle,
} from '../core/project/transfer';

export {
  PROJECT_BUNDLE_SCHEMA,
  type BundleAsset, type BundleAssetKind, type ProjectBundle,
} from '../core/project/transfer';

/**
 * Moving a mountain between servers, which is a file transfer rather than a handshake (docs/038).
 *
 * **Export mountain** takes a project's current revision as a self-contained bundle — the document, plus a
 * manifest naming every custom asset it wears by content hash. The browser lays that bundle out as a
 * `.slopesmith.zip`. **Import mountain** copies it onto another server and the editor follows it there. Forking
 * is the same pair with the same server on both ends.
 *
 * Project-owned assets ride along by content hash. A destination creates a fresh ownership boundary and
 * installs every file inside it; imported prop ids and any collision-safe names are retargeted in the
 * arriving document.
 */

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

// ---- where each kind lives, and how it is read and stored ----

/** The file one asset occupies, or null for a kind whose storage is not a single named file. */
function assetFile(kind: BundleAssetKind, name: string): string | null {
  const stem = safeDataName(name.replace(/\.[^.]+$/, ''));
  if (!stem) return null;
  switch (kind) {
    case 'texture': return projectAssetPath('textures', `${stem}.png`);
    case 'sound': return projectAssetPath('sounds', `${stem}.wav`);
    case 'sky': return projectAssetPath('skies', `${stem}.png`);
    // Music keeps whatever extension the author's source had, so the name is used as it stands — reduced
    // only to "one file in that folder", which is the whole of what makes it safe to join.
    case 'music':
      return name && !/[\\/]/.test(name) && !name.split('.').includes('..')
        ? projectAssetPath('music', name) : null;
    case 'prop': return null;
  }
}

/** One asset's bytes as this server holds them. An imported prop is its JSON record, which is what makes a
 *  model's geometry and its material refs travel as one hashed thing. */
async function readAsset(kind: BundleAssetKind, name: string, model?: number): Promise<Buffer | null> {
  if (kind === 'prop') {
    const found = (await listImportedProps()).find(entry => entry.record.id === model);
    return found ? Buffer.from(JSON.stringify(found.record), 'utf8') : null;
  }
  const file = assetFile(kind, name);
  return file ? readBytesOrNull(file) : null;
}

/** Store one arriving asset under a name that is free here, and answer what it landed as. */
async function writeAsset(kind: BundleAssetKind, name: string, bytes: Buffer,
  textures: Map<string, string>): Promise<{ name: string; model?: number }> {
  switch (kind) {
    case 'texture': return { name: await saveCustomTexture(name, bytes) };
    case 'sound': return { name: await saveCustomSound(name, bytes) };
    case 'music': return { name: await saveCustomMusic(name, bytes) };
    case 'sky': return { name: await saveCustomSky(name, bytes) };
    case 'prop': {
      const record = JSON.parse(bytes.toString('utf8')) as ImportedPropRecord;
      // The record's own material refs are retargeted onto the tiles this server stored a moment ago, before
      // it is written — a model whose textures landed as `lamp_2.png` must name `lamp_2.png`. The map is
      // keyed by the tile's own name, so the `Custom/` the ref wears is stripped and put back.
      const materials = (record.materials ?? []).map(material => {
        const tile = customTextureRef(material.tex);
        const moved = tile && textures.get(tile.toLowerCase());
        const frames = material.frames?.map(frame => {
          const frameTile = customTextureRef(frame);
          const frameMoved = frameTile && textures.get(frameTile.toLowerCase());
          return frameMoved ? `${CUSTOM_TEX_LEVEL}/${frameMoved}` : frame;
        });
        return {
          ...material,
          ...(moved ? { tex: `${CUSTOM_TEX_LEVEL}/${moved}` } : {}),
          ...(frames ? { frames } : {}),
        };
      });
      const { record: saved } = await saveImportedProp(name, { ...record, materials });
      return { name, model: saved.id };
    }
  }
}

// ---- what a document wears ----

const customTextureRef = (ref: string | undefined | null): string | null => {
  if (!ref) return null;
  const { level, name } = parseTexRef(ref);
  return level === CUSTOM_TEX_LEVEL && name ? name : null;
};

/** Every custom asset a document names, before the bytes behind them are read. Imported props bring their own
 *  texture refs, which live in the record rather than in the document — so they are collected from disk. */
async function referencedAssets(document: EditDoc): Promise<Array<Omit<BundleAsset, 'hash' | 'size'>>> {
  const textures = new Set<string>();
  const wanted: Array<Omit<BundleAsset, 'hash' | 'size'>> = [];
  const addTexture = (ref: string | undefined | null) => {
    const name = customTextureRef(ref);
    if (name) textures.add(name);
  };

  for (const ref of Object.values(document.quadTex ?? {})) addTexture(ref);
  for (const model of document.models ?? []) addTexture(model.texture);

  const sounds = new Set<string>();
  const models = new Set<number>();
  for (const prop of document.props ?? []) {
    if (prop.collisionSoundFile) sounds.add(prop.collisionSoundFile);
    if (prop.ambientSoundFile) sounds.add(prop.ambientSoundFile);
    if (prop.level === IMPORTED_PROP_LEVEL) models.add(prop.model);
  }

  if (models.size) {
    for (const { record } of await listImportedProps()) {
      if (!models.has(record.id)) continue;
      wanted.push({ kind: 'prop', name: record.name || `prop-${record.id}`, model: record.id });
      for (const material of record.materials ?? []) {
        addTexture(material.tex);
        for (const frame of material.frames ?? []) addTexture(frame);
      }
    }
  }

  for (const name of textures) wanted.push({ kind: 'texture', name });
  for (const owner of [...(document.effects?.graphs ?? []), ...(document.effects?.functions ?? [])]) {
    for (const node of owner.nodes ?? []) {
      const file = effectNodeSoundFile(node);
      if (file) sounds.add(file);
    }
  }
  for (const name of sounds) wanted.push({ kind: 'sound', name });
  if (document.raceMusic) wanted.push({ kind: 'music', name: document.raceMusic });
  const sky = document.skybox?.source;
  if (sky?.kind === 'custom' && sky.name) wanted.push({ kind: 'sky', name: sky.name });
  return wanted;
}

/** Everything in this mountain's local catalogue, including uploads not currently placed in the document.
 * A mountain copy is a workspace copy: its useful shelf of candidate props and textures must not vanish just
 * because a particular revision is not wearing them yet. */
async function localLibraryAssets(): Promise<Array<Omit<BundleAsset, 'hash' | 'size'>>> {
  const wanted: Array<Omit<BundleAsset, 'hash' | 'size'>> = [];
  const addFiles = async (folder: string, kind: BundleAssetKind, accept: RegExp, name: (file: string) => string = file => file) => {
    for (const file of await listDir(projectAssetPath(folder))) {
      if (accept.test(file)) wanted.push({ kind, name: name(file) });
    }
  };
  await Promise.all([
    addFiles('textures', 'texture', /\.png$/i),
    addFiles('sounds', 'sound', /\.wav$/i),
    addFiles('music', 'music', /\.(?:wav|mp3|flac|ogg|m4a|aac)$/i),
    addFiles('skies', 'sky', /\.png$/i, file => file.replace(/\.png$/i, '')),
  ]);
  for (const { record } of await listImportedProps()) {
    wanted.push({ kind: 'prop', name: record.name || `prop-${record.id}`, model: record.id });
    for (const material of record.materials ?? []) {
      const refs = [material.tex, ...(material.frames ?? [])];
      for (const ref of refs) {
        const name = customTextureRef(ref);
        if (name) wanted.push({ kind: 'texture', name });
      }
    }
  }
  return wanted;
}

/**
 * The manifest for one document: every custom asset it wears, hashed.
 *
 * An asset the document names and this server no longer holds is reported rather than skipped, because a map
 * downloaded with a hole in it should say so at the moment it is downloaded and not at the moment it is
 * opened somewhere else.
 */
export async function bundleAssets(document: EditDoc): Promise<{ assets: BundleAsset[]; missing: string[] }> {
  const keyed = new Map<string, Omit<BundleAsset, 'hash' | 'size'>>();
  for (const entry of [...await localLibraryAssets(), ...await referencedAssets(document)]) {
    const identity = entry.kind === 'prop' ? `${entry.kind}:${entry.model}` : `${entry.kind}:${entry.name.toLowerCase()}`;
    keyed.set(identity, entry);
  }
  const wanted = [...keyed.values()];
  const bytes = await mapLimit(wanted, READ_CONCURRENCY, entry => readAsset(entry.kind, entry.name, entry.model));
  const assets: BundleAsset[] = [];
  const missing: string[] = [];
  wanted.forEach((entry, at) => {
    const found = bytes[at];
    if (!found) { missing.push(`${entry.kind} ${entry.name}`); return; }
    assets.push({ ...entry, hash: sha256(found), size: found.length });
  });
  return { assets, missing };
}

/** Any editable mountain revision as a transferable bundle. Current projects and history checkpoints use this
 *  same public archive shape; only the document and revision metadata differ. */
export async function downloadDocument(document: EditDoc, meta: {
  name: string; revision: number; takenAt?: string;
}, withBytes = false): Promise<ProjectBundle> {
  const { assets, missing } = await bundleAssets(document);
  const bundle: ProjectBundle = {
    kind: 'slopesmith-project',
    schema: PROJECT_BUNDLE_SCHEMA,
    name: meta.name,
    revision: meta.revision,
    takenAt: meta.takenAt ?? new Date().toISOString(),
    document,
    assets,
    ...(missing.length ? { missing } : {}),
  };
  if (!withBytes) return bundle;
  const blobs: Record<string, string> = {};
  const bytes = await mapLimit(assets, READ_CONCURRENCY, asset => readAsset(asset.kind, asset.name, asset.model));
  assets.forEach((asset, at) => { if (bytes[at]) blobs[asset.hash] = bytes[at]!.toString('base64'); });
  return { ...bundle, blobs };
}

/** A project's current revision. `withBytes` makes it self-contained for an exported mountain ZIP or a
 * same-server duplicate. */
export async function downloadProject(id: string, withBytes = false): Promise<ProjectBundle> {
  const snapshot = await openProject(id);
  await migrateLegacyProjectAssets(snapshot);
  return withProjectAssets(snapshot, () => downloadDocument(snapshot.document, {
    name: snapshot.project.name, revision: snapshot.project.revision,
  }, withBytes));
}

/** Compatibility response for the two-stage transfer protocol. Project-local ownership means the fresh
 * destination needs every declared asset; there is intentionally no global authored bank to reuse. */
export async function missingAssets(assets: readonly BundleAsset[]):
  Promise<{ missing: BundleAsset[]; have: Record<string, { kind: BundleAssetKind; name: string; model?: number }> }> {
  // Every import creates an empty project-owned asset root. There is deliberately no server-global authored
  // bank to negotiate against, so a portable transfer must bring every dependency it declares.
  return { missing: [...assets], have: {} };
}

/** Move a document off the names it arrived under and onto the names its assets landed under here. */
function retargetDocument(document: EditDoc, moves: {
  textures: Map<string, string>; sounds: Map<string, string>; music: Map<string, string>;
  skies: Map<string, string>; models: Map<number, number>;
}): EditDoc {
  const tile = (ref: string | undefined | null): string | undefined => {
    if (!ref) return ref ?? undefined;
    const name = customTextureRef(ref);
    const moved = name && moves.textures.get(name.toLowerCase());
    return moved ? `${CUSTOM_TEX_LEVEL}/${moved}` : ref;
  };
  const next: EditDoc = { ...document };
  if (next.quadTex) {
    next.quadTex = Object.fromEntries(Object.entries(next.quadTex).map(([quad, ref]) => [quad, tile(ref)!]));
  }
  if (next.models) next.models = next.models.map(model => ({ ...model, texture: tile(model.texture) }));
  if (next.props) {
    next.props = next.props.map(prop => ({
      ...prop,
      ...(prop.level === IMPORTED_PROP_LEVEL && moves.models.has(prop.model)
        ? { model: moves.models.get(prop.model)! } : {}),
      ...(prop.collisionSoundFile && moves.sounds.has(prop.collisionSoundFile.toLowerCase())
        ? { collisionSoundFile: moves.sounds.get(prop.collisionSoundFile.toLowerCase())! } : {}),
      ...(prop.ambientSoundFile && moves.sounds.has(prop.ambientSoundFile.toLowerCase())
        ? { ambientSoundFile: moves.sounds.get(prop.ambientSoundFile.toLowerCase())! } : {}),
    }));
  }
  if (next.raceMusic && moves.music.has(next.raceMusic.toLowerCase())) {
    next.raceMusic = moves.music.get(next.raceMusic.toLowerCase())!;
  }
  const sky = next.skybox?.source;
  if (sky?.kind === 'custom' && moves.skies.has(sky.name.toLowerCase())) {
    next.skybox = { ...next.skybox!, source: { ...sky, name: moves.skies.get(sky.name.toLowerCase())! } };
  }
  return next;
}

export interface UploadResult {
  snapshot: ProjectSnapshot;
  /** Assets this upload actually stored, and what each landed under. */
  stored: Array<{ kind: BundleAssetKind; from: string; to: string }>;
  /** Assets the bundle named that arrived without bytes and were not already here. The map opens anyway,
   *  wearing the refs it came with; saying so is better than a silently different mountain. */
  absent: string[];
}

/**
 * Copy an uploaded map onto this server.
 *
 * The order is the whole of it: textures land first, so an imported model can be written naming the tiles it
 * actually got; models land next, so placements can be moved onto the numbers they were assigned; the
 * document is retargeted onto all of it before revision 1 is finalized.
 */
export async function uploadProject(bundle: ProjectBundle, clientId?: string,
  requestedName?: string, ownerId = 'owner'): Promise<UploadResult> {
  const assets = Array.isArray(bundle.assets) ? bundle.assets : [];
  const blobs = bundle.blobs ?? {};
  const supplied = new Map<BundleAsset, Buffer>();
  const absent: string[] = [];
  // Reject a corrupt archive before creating its destination project. Missing blobs remain a reported hole,
  // matching the existing import contract, but bytes that claim another content hash are never installed.
  for (const asset of assets) {
    const packed = blobs[asset.hash];
    if (!packed) { absent.push(`${asset.kind} ${asset.name}`); continue; }
    const bytes = Buffer.from(packed, 'base64');
    if (sha256(bytes) !== asset.hash) throw new Error(`${asset.kind} ${asset.name} did not match its hash`);
    if (asset.kind === 'prop') JSON.parse(bytes.toString('utf8'));
    supplied.set(asset, bytes);
  }
  // Keep the half-built project out of the calling tab until its assets and retargeted document are both in
  // place. It is a native project-owned library, not a legacy map, so seal migration before activation too.
  const sourceDocument = requestedName === undefined
    ? bundle.document : { ...bundle.document, name: requestedName };
  const created = await createProject(sourceDocument, clientId, false, ownerId);
  await initializeNativeProjectAssets(created);

  return withProjectAssets(created, async () => {
    const textures = new Map<string, string>();
    const sounds = new Map<string, string>();
    const music = new Map<string, string>();
    const skies = new Map<string, string>();
    const models = new Map<number, number>();
    const stored: UploadResult['stored'] = [];

    const record = (asset: BundleAsset, landed: { name: string; model?: number }) => {
      const key = asset.name.toLowerCase();
      if (asset.kind === 'texture') textures.set(key, landed.name);
      else if (asset.kind === 'sound') sounds.set(key, landed.name);
      else if (asset.kind === 'music') music.set(key, landed.name);
      else if (asset.kind === 'sky') skies.set(key, landed.name);
      else if (asset.kind === 'prop' && asset.model !== undefined && landed.model !== undefined) {
        models.set(asset.model, landed.model);
      }
    };

    // Textures before the models that wear them; everything else is independent.
    const order: BundleAssetKind[] = ['texture', 'sound', 'music', 'sky', 'prop'];
    for (const kind of order) {
      for (const asset of assets.filter(entry => entry.kind === kind)) {
        const bytes = supplied.get(asset);
        if (!bytes) continue;
        const landed = await writeAsset(asset.kind, asset.name, bytes, textures);
        record(asset, landed);
        stored.push({ kind: asset.kind, from: asset.name, to: landed.name });
      }
    }

    const document = retargetDocument(sourceDocument, { textures, sounds, music, skies, models });
    const snapshot = await finishProjectCreation(created.project.id, document);
    await openProject(snapshot.project.id, true, clientId);
    return { snapshot, stored, absent };
  });
}

/** Same-server copy without a browser round trip: read the source project's local bytes and install them into
 * the fresh destination project through the exact same import path as a portable archive. */
export async function duplicateProject(id: string, clientId?: string,
  requestedName?: string, ownerId = 'owner'): Promise<UploadResult> {
  return uploadProject(await downloadProject(id, true), clientId, requestedName, ownerId);
}

/** Recognise the internal JSON transfer envelope used by direct server transfers and browser ZIP import. */
export function asBundle(value: unknown): ProjectBundle | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ProjectBundle>;
  if (candidate.kind !== 'slopesmith-project' || !candidate.document) return null;
  return {
    kind: 'slopesmith-project',
    schema: Number(candidate.schema) || PROJECT_BUNDLE_SCHEMA,
    name: String(candidate.name ?? ''),
    revision: Number(candidate.revision) || 0,
    takenAt: String(candidate.takenAt ?? new Date().toISOString()),
    document: candidate.document,
    assets: Array.isArray(candidate.assets) ? candidate.assets : [],
    ...(candidate.blobs ? { blobs: candidate.blobs } : {}),
  };
}
