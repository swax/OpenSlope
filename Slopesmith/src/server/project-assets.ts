import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { basename, dirname, extname, join } from 'node:path';
import type { EditDoc } from '../core/doc/doc-edit';
import { effectNodeSoundFile } from '../core/effects/authoring';
import { parseTexRef, CUSTOM_TEX_LEVEL } from '../core/paint/textures';
import { IMPORTED_PROP_LEVEL, type ImportedPropRecord } from '../core/props/imported';
import {
  ensureDir, listDir, pathExists, readJsonOr, writeJsonAtomic,
} from './fs-async';
import {
  canEditProject, currentProject, listCheckpoints, listProjects, openProject, ProjectPermissionError,
  readCheckpoint, type ProjectSnapshot,
} from './projects';
import type { Identity } from './accounts/guard';
import { createLogger } from './log';
import { mapsRoot } from './workspace-config';

/**
 * Project-owned authored assets.
 *
 * The editor's document deliberately keeps compact logical refs such as `Custom/snow.png`; the request's
 * active project supplies the physical root those refs resolve beneath. AsyncLocalStorage keeps that root
 * request-local, so two tabs serving different mountains cannot see each other's authored catalogues.
 */
interface ProjectAssetContext {
  projectId: string;
  root: string;
}

const contexts = new AsyncLocalStorage<ProjectAssetContext>();

function context(): ProjectAssetContext {
  const active = contexts.getStore();
  if (active) return active;
  // Direct storage tests and maintenance scripts have no HTTP request to carry a tab id. They opt into one
  // explicit isolated root rather than silently falling back to the old Maps/Custom shared catalogue.
  const testRoot = process.env.SLOPESMITH_PROJECT_ASSETS_ROOT;
  if (testRoot) return { projectId: 'direct', root: testRoot };
  throw new Error('No mountain asset context is active. Open a mountain before using authored assets.');
}

export function projectAssetPath(...parts: string[]): string {
  return join(context().root, ...parts);
}

/** Prefix response-cache entries with ownership, so equal logical refs in two mountains never share bytes. */
export function projectAssetCacheKey(key: string): string {
  return `project:${context().projectId}:${key}`;
}

export function currentProjectAssetScope(): string {
  return `project:${context().projectId}:`;
}

export function withProjectAssets<T>(snapshot: ProjectSnapshot, run: () => T): T {
  return contexts.run({ projectId: snapshot.project.id, root: join(snapshot.project.folder, 'assets') }, run);
}

function requestClientId(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-slopesmith-client'];
  const header = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('client')?.trim();
  return (header || query)?.slice(0, 64);
}

/**
 * The mountain a request acts on: the one it named, or the one open in the calling tab.
 *
 * Split out of `withRequestProjectAssets` because a route can need the DOCUMENT as well as the asset root —
 * an authored model lives in `mountain.slope.json`, not in `assets/` (docs/046) — and resolving it a second
 * way would let the two disagree about which mountain the request meant.
 */
/**
 * No mountain to act on — a request state, not a fault.
 *
 * Its own type so `handleApiRequest` can answer it as a refusal with a reason instead of the 500-plus-stack
 * every other throw earns. A browser never sees this (the editor has a map open before it asks anything),
 * but the Blender bridge is reached by a program that has no tab and no session, so on a server whose
 * workspace is still empty it is the FIRST thing that happens — and "500 Internal Server Error" is a
 * miserable way to be told "make a mountain first".
 */
export class NoOpenProjectError extends Error {
  readonly statusCode = 409;

  constructor(message = 'No mountain is open for this editor.') { super(message); }
}

export async function requestProjectSnapshot(req: IncomingMessage): Promise<ProjectSnapshot> {
  const projectId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('project')?.trim();
  // A named mountain that is not here throws from the store rather than answering null, so both ways of
  // having nothing to act on arrive as the same refusal instead of one of them as a 500.
  const snapshot = projectId
    ? await openProject(projectId).catch(() => { throw new NoOpenProjectError(`This server has no mountain ${projectId}.`); })
    : await currentProject(requestClientId(req));
  if (!snapshot) {
    throw new NoOpenProjectError('No mountain is open. Open one in the editor, or name it with ?project=<id>.');
  }
  return snapshot;
}

/** Bind an asset API request to the mountain open in the calling tab. */
export async function withRequestProjectAssets<T>(req: IncomingMessage, run: () => T | Promise<T>,
  enforceEdit = false): Promise<T> {
  const snapshot = await requestProjectSnapshot(req);
  if (enforceEdit) {
    const identity = (req as IncomingMessage & { identity?: Identity }).identity;
    if (!identity || !('user' in identity) || !canEditProject(snapshot.project, identity.user)) {
      throw new ProjectPermissionError(snapshot.project.editorIds === undefined
        ? 'Changing this map needs the editor role.'
        : 'This map is restricted to editors selected by its owner.');
    }
  }
  await migrateLegacyProjectAssets(snapshot);
  return await withProjectAssets(snapshot, run);
}

// ---- one-way migration out of Maps/Custom -----------------------------------------------------------

const MIGRATION_FILE = '.legacy-library-migrated-v1.json';

/**
 * A portable import is born with a project-owned asset library; it is not an old mountain waiting to be
 * separated from Maps/Custom. Seal that fact before the new project becomes active, otherwise the first
 * asset request can mistake freshly assigned imported-prop ids for unrelated ids in the legacy shared bank.
 */
export async function initializeNativeProjectAssets(snapshot: ProjectSnapshot): Promise<void> {
  const root = join(snapshot.project.folder, 'assets');
  await ensureDir(root);
  await writeJsonAtomic(join(root, MIGRATION_FILE), {
    schema: 1,
    initializedAt: new Date().toISOString(),
    copied: [],
    missing: [],
  });
}

interface WantedAssets {
  textures: Set<string>;
  sounds: Set<string>;
  music: Set<string>;
  skies: Set<string>;
  models: Set<number>;
}

function wantedAssets(): WantedAssets {
  return {
    textures: new Set(), sounds: new Set(), music: new Set(), skies: new Set(), models: new Set(),
  };
}

function customTextureName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const { level, name } = parseTexRef(ref);
  return level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase() && name ? name : null;
}

function collectDocumentAssets(document: EditDoc, wanted: WantedAssets): void {
  const texture = (ref: string | null | undefined) => {
    const name = customTextureName(ref);
    if (name) wanted.textures.add(name);
  };
  for (const ref of Object.values(document.quadTex ?? {})) texture(ref);
  for (const model of document.models ?? []) texture(model.texture);
  for (const prop of document.props ?? []) {
    if (prop.level === IMPORTED_PROP_LEVEL) wanted.models.add(prop.model);
    if (prop.collisionSoundFile) wanted.sounds.add(prop.collisionSoundFile);
    if (prop.ambientSoundFile) wanted.sounds.add(prop.ambientSoundFile);
  }
  if (document.raceMusic) wanted.music.add(document.raceMusic);
  for (const owner of [...(document.effects?.graphs ?? []), ...(document.effects?.functions ?? [])]) {
    for (const node of owner.nodes ?? []) {
      const file = effectNodeSoundFile(node);
      if (file) wanted.sounds.add(file);
    }
  }
  const sky = document.skybox?.source;
  if (sky?.kind === 'custom' && sky.name) wanted.skies.add(sky.name);
}

async function copyIfPresent(source: string, destination: string, copied: string[], missing: string[]): Promise<void> {
  // Project-owned uploads satisfy the dependency even when no legacy source exists.
  if (await pathExists(destination)) return;
  if (!await pathExists(source)) { missing.push(source); return; }
  await ensureDir(dirname(destination));
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    copied.push(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

async function copyOptional(source: string, destination: string, copied: string[]): Promise<void> {
  if (!await pathExists(source)) return;
  await ensureDir(dirname(destination));
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    copied.push(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Copy dependencies of an existing mountain (including its retained checkpoints) into its own assets folder.
 * The old folders are intentionally left untouched: migration is recoverable, while all new reads and writes
 * use only the project copy after this marker is committed.
 */
export async function migrateLegacyProjectAssets(snapshot: ProjectSnapshot): Promise<void> {
  const root = join(snapshot.project.folder, 'assets');
  const marker = join(root, MIGRATION_FILE);
  const prior = await readJsonOr<{ missing?: string[] } | null>(marker, null);
  // A complete migration is final. An earlier pass with missing dependencies is retried so restoring a
  // legacy file after Slopesmith first noticed the hole does not require marker surgery.
  if (prior && !(prior.missing?.length)) return;

  const wanted = wantedAssets();
  collectDocumentAssets(snapshot.document, wanted);
  try {
    const listing = await listCheckpoints(snapshot.project.id);
    for (const checkpoint of listing.checkpoints) {
      try { collectDocumentAssets((await readCheckpoint(snapshot.project.id, checkpoint.file)).document, wanted); }
      catch { /* a checkpoint can be thinned between listing and read */ }
    }
  } catch { /* a project created before checkpoint storage simply has no history dependencies */ }

  const legacyProps = join(mapsRoot(), 'Custom', 'Props');
  const propFiles = (await listDir(legacyProps)).filter(file => /\.json$/i.test(file));
  const propRecords = await Promise.all(propFiles.map(async file => ({
    file, record: await readJsonOr<ImportedPropRecord | null>(join(legacyProps, file), null),
  })));
  // A model number is the imported prop's identity. If this project already owns that number, its local
  // record is authoritative even when the legacy bank happens to contain a different prop under the same id.
  // This is also the defensive half of portable import: an older/incomplete import without a marker must
  // never acquire a second record whose id makes thumbnail and placement lookups ambiguous.
  const localPropFiles = (await listDir(join(root, 'props'))).filter(file => /\.json$/i.test(file));
  const localPropRecords = await Promise.all(localPropFiles.map(file =>
    readJsonOr<ImportedPropRecord | null>(join(root, 'props', file), null)));
  const locallyOwnedModels = new Set(localPropRecords
    .filter((record): record is ImportedPropRecord => !!record && Number.isInteger(record.id))
    .map(record => record.id));
  const neededLegacyProps = propRecords.filter(({ record }) =>
    !!record && wanted.models.has(record.id) && !locallyOwnedModels.has(record.id));
  for (const { record } of neededLegacyProps) {
    if (!record) continue;
    for (const material of record.materials ?? []) {
      const own = customTextureName(material.tex);
      if (own) wanted.textures.add(own);
      for (const frame of material.frames ?? []) {
        const frameName = customTextureName(frame);
        if (frameName) wanted.textures.add(frameName);
      }
    }
  }

  const copied: string[] = [];
  const missing: string[] = [];
  await Promise.all([
    ...[...wanted.textures].map(name => copyIfPresent(
      join(mapsRoot(), 'Custom', 'Textures', `${basename(name, extname(name))}.png`),
      join(root, 'textures', `${basename(name, extname(name))}.png`), copied, missing)),
    ...[...wanted.sounds].map(name => copyIfPresent(
      join(mapsRoot(), 'Custom', 'Sounds', `${basename(name, extname(name))}.wav`),
      join(root, 'sounds', `${basename(name, extname(name))}.wav`), copied, missing)),
    ...[...wanted.music].filter(name => basename(name) === name).map(name => copyIfPresent(
      join(mapsRoot(), 'Custom', 'Music', name), join(root, 'music', name), copied, missing)),
    ...[...wanted.skies].map(name => copyIfPresent(
      join(mapsRoot(), 'Shared', 'Skies', `${basename(name, extname(name))}.png`),
      join(root, 'skies', `${basename(name, extname(name))}.png`), copied, missing)),
    ...neededLegacyProps.map(({ file }) =>
      copyIfPresent(join(legacyProps, file), join(root, 'props', file), copied, missing)),
    // Preserve the old libraries' spent names and prop-number high-water mark. These are optional metadata,
    // not missing dependencies, but without them an old checkpoint could later see a deleted name/id reused.
    ...[
      ['Custom', 'Textures.retired.json', 'textures.retired.json'],
      ['Custom', 'Sounds.retired.json', 'sounds.retired.json'],
      ['Custom', 'Music.retired.json', 'music.retired.json'],
      ['Custom', 'Props.retired.json', 'props.retired.json'],
      ['Custom', 'Props.nextid.json', 'props.nextid.json'],
      ['Shared', 'Skies.retired.json', 'skies.retired.json'],
    ].map(([area, file, target]) => copyOptional(join(mapsRoot(), area, file), join(root, target), copied)),
  ]);

  await ensureDir(root);
  await writeJsonAtomic(marker, {
    schema: 1,
    migratedAt: new Date().toISOString(),
    copied: copied.map(path => path.slice(root.length + 1).replace(/\\/g, '/')),
    missing: missing.map(path => path.replace(/\\/g, '/')),
  });
}

const log = createLogger('assets');

/** One-time workspace upgrade. A broken project or dependency is isolated and reported rather than keeping
 * the server offline; opening that project later retries the same migration through its request context. */
export async function migrateLegacyWorkspaceAssets(): Promise<void> {
  for (const project of await listProjects()) {
    try { await migrateLegacyProjectAssets(await openProject(project.id)); }
    catch (error) {
      log.warn(`could not migrate ${project.name}`, { error });
    }
  }
}
