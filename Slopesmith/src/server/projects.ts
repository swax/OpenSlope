import { watch } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { EditDoc } from '../core/doc/doc-edit';
import { canonicalJson } from '../core/doc/canonical';
import { migrateMountain } from '../core/doc/mountain';
import { serializeMountain } from '../core/doc/serialize';
import { ensureWorkspace } from './workspace-config';
import {
  canonicalDir, ensureDir, listSubdirectories, mapLimit, pathExists, readJson, readJsonOr, writeFileAtomic,
  writeJsonAtomic, READ_CONCURRENCY,
} from './fs-async';
import {
  changedDocumentSpan, checkpointOutgoing, checkpointProjectNow, clearCheckpointCadence,
  listProjectCheckpoints, nameProjectCheckpoint, readProjectCheckpoint,
  type CheckpointListing, type CheckpointRequest, type ProjectCheckpoint,
} from './project-checkpoints';
import { retireName, safeDataName, storeUnderFreeName } from './routes/safe-name';
import { serialize } from './serialize';
import { runInWorker, WorkerTaskError } from './worker-pool';
import { holds, type Role } from './accounts/policy';
import { createLogger } from './log';

export {
  CheckpointGoneError, checkpointPolicy, configureCheckpoints, planRetention,
  type CheckpointListing, type CheckpointPolicy, type CheckpointReason, type CheckpointRequest,
  type ProjectCheckpoint, type RetentionPlan,
} from './project-checkpoints';

const PROJECT_SCHEMA = 2;
const log = createLogger('projects');

export interface ProjectManifest {
  schema: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  documentHash: string;
  /** The account that created this map. Stable user ids survive display-name and username changes. A map
   *  created before ownership was introduced has no owner and remains a server-managed legacy map. */
  ownerId?: string;
  /** Absent means every server editor may edit. Present means only these editor accounts may edit, in
   *  addition to the owner and moderator/admin overrides. An empty array therefore means owner/mods only. */
  editorIds?: string[];
  /** Every name this map has been called before this one. A rename retires the name it moved off, so from
   *  then on it is taken by every OTHER map; this is the record that lets THIS map take it back, which is what
   *  a restore of a revision authored under an older name puts back. */
  formerNames?: string[];
}

/** The identity facts map policy needs, deliberately smaller than an HTTP/session identity. */
export interface ProjectActor { id: string; role: Role }

/** Owners manage their map; moderators and admins can recover/manage any map. */
export const canManageProject = (project: ProjectManifest, actor: ProjectActor): boolean =>
  project.ownerId === actor.id || holds(actor.role, 'moderator');

/** Server role is the floor. A restricted map then narrows ordinary editors by stable account id, while its
 *  owner and operational roles retain access. */
export const canEditProject = (project: ProjectManifest, actor: ProjectActor): boolean =>
  holds(actor.role, 'editor') && (project.editorIds === undefined
    || project.ownerId === actor.id || holds(actor.role, 'moderator') || project.editorIds.includes(actor.id));

export class ProjectPermissionError extends Error {
  readonly statusCode = 403;

  constructor(message: string) { super(message); }
}

export interface ProjectSnapshot {
  project: ProjectManifest & { folder: string };
  document: EditDoc;
}

export class ProjectConflictError extends Error {
  constructor(public readonly snapshot: ProjectSnapshot) {
    super(`Project changed on disk (current revision ${snapshot.project.revision})`);
  }
}

/**
 * A document's name, taken over its canonical text (docs/039).
 *
 * The hash is what tells "somebody edited this on disk" from "this is the document I already hold", so it has
 * to answer for the mountain rather than for the route the mountain arrived by. `JSON.stringify` cannot: it
 * writes an object's keys in the order they were inserted and a float to its last bit, so a document read off
 * disk and the same document rebuilt by applying changes to it hash differently while holding identical
 * terrain. Sorted keys and a fixed number format are the whole fix, and they make an edit smaller than a
 * nanometre no edit at all — which is the right answer for a value nobody could have authored.
 */
const hashJson = (json: string) => createHash('sha256').update(json).digest('hex');
const hashDocument = (doc: unknown) => hashJson(canonicalJson(doc));

function safeSlug(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'mountain';
}

/**
 * The name a document asks its map to be stored under.
 *
 * Sanitised, because a map's name is a folder an export bakes, so what the author typed and what the library
 * holds have to be the same alphabet — otherwise every save of `Storage Test` reads as a rename of
 * `StorageTest`. A document carrying nothing usable asks for no name at all, which leaves the map called
 * whatever it is called.
 */
const nameAsked = (document: EditDoc): string => safeDataName(document.name ?? '');

/** Whether two names are one name: a name and its case variants address one file on a case-insensitive
 *  filesystem, and retire together (`routes/safe-name.ts`). */
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The names a map has held, with the one it is moving off added — what lets it take that name back later. */
function formerNames(manifest: ProjectManifest, retiring?: string): string[] {
  const held = manifest.formerNames ?? [];
  if (!retiring || held.some(name => sameName(name, retiring))) return held;
  return [...held, retiring];
}

async function projectRoot(): Promise<string> { return join((await ensureWorkspace()).workspaceRoot, 'projects'); }
async function sessionFile(): Promise<string> { return join((await ensureWorkspace()).workspaceRoot, 'session.json'); }
const manifestFile = (dir: string) => join(dir, 'project.json');
const documentFile = (dir: string) => join(dir, 'mountain.slope.json');

async function projectDirectories(): Promise<string[]> {
  const root = await projectRoot();
  const dirs = (await listSubdirectories(root)).map(name => join(root, name));
  const manifested = await mapLimit(dirs, READ_CONCURRENCY, dir => pathExists(manifestFile(dir)));
  return dirs.filter((_dir, index) => manifested[index]);
}

/** Project ids are immutable and this process owns additions/removals. Remember their folders so a room
 * snapshot does not rescan every manifest every 450 ms. A miss refreshes the catalogue, preserving hand-added
 * projects and tests that populate a workspace outside this module. */
let projectLocations: { root: string; byId: Map<string, string> } | null = null;

function locationsFor(root: string): Map<string, string> {
  if (!projectLocations || projectLocations.root !== root) projectLocations = { root, byId: new Map() };
  return projectLocations.byId;
}

function rememberLocations(root: string, dirs: readonly string[], manifests: readonly (ProjectManifest | null)[]): void {
  const locations = locationsFor(root);
  for (let index = 0; index < dirs.length; index++) {
    const id = manifests[index]?.id;
    if (id) locations.set(id, dirs[index]);
  }
}

async function readManifest(dir: string): Promise<ProjectManifest> {
  const parsed = await readJson<ProjectManifest>(manifestFile(dir));
  if (!parsed?.id || !Number.isInteger(parsed.revision)) throw new Error(`Invalid project manifest: ${dir}`);
  return parsed;
}

async function findProject(id: string): Promise<string> {
  const root = await projectRoot();
  const cached = locationsFor(root).get(id);
  if (cached) return cached;
  const dirs = await projectDirectories();
  const manifests = await mapLimit(dirs, READ_CONCURRENCY,
    dir => readJsonOr<ProjectManifest | null>(manifestFile(dir), null));
  rememberLocations(root, dirs, manifests);
  const dir = dirs.find((_candidate, index) => manifests[index]?.id === id);
  if (!dir) throw new Error(`Unknown project: ${id}`);
  return dir;
}

/**
 * A document as the editor holds it: keyed channels named by array index.
 *
 * Both things that reach here — a file off disk and a save posted by a client — arrive as whatever
 * `migrateMountain` can read, and it is also the load half of the keying boundary (docs/039), so a stored
 * mountain's id-named channels come back index-named here and nowhere else in this file.
 */
function normalizedDocument(value: unknown): EditDoc {
  if (!value || typeof value !== 'object') throw new Error('Project document must be a JSON object');
  return migrateMountain(value);
}

/** A document as it is stored: keyed channels named by stable id, so a topology edit made after this save
 *  cannot make its paint, tiles or creases name different geometry when it is read back (docs/039). Hashes and
 *  revisions are taken over the index-named form on both sides, so the two stay comparable. */
const storedDocument = (document: EditDoc) => serializeMountain(document);

interface PreparedDocument {
  /** Canonical editor-form JSON, used for equality, hashing and checkpoint change size. */
  canonical: string;
  /** Pretty storage-form JSON, ready for the atomic document write. */
  storedJson: string;
}

interface PreparedRead {
  document: EditDoc;
  canonical: string;
}

let warnedDocumentWorker = false;

/** Whole-document walks do not belong on the socket thread while several rooms are snapshotting. Retain a
 * local path as a correctness fallback for hosts that cannot start workers (and emit one useful warning). */
async function prepareDocument(document: EditDoc): Promise<PreparedDocument> {
  try {
    return await runInWorker({ kind: 'document', document }) as PreparedDocument;
  } catch (error) {
    if (error instanceof WorkerTaskError) throw error;
    if (!warnedDocumentWorker) {
      warnedDocumentWorker = true;
      log.warn('document worker unavailable; snapshots will use the main thread', { error });
    }
    return {
      canonical: canonicalJson(document),
      storedJson: `${JSON.stringify(storedDocument(document), null, 2)}\n`,
    };
  }
}

/** JSON parsing, schema migration and canonicalization are the other whole-document half of a snapshot. */
async function readPreparedDocument(dir: string): Promise<PreparedRead> {
  try {
    return await runInWorker({ kind: 'document-read', file: documentFile(dir) }) as PreparedRead;
  } catch (error) {
    if (error instanceof WorkerTaskError) throw error;
    if (!warnedDocumentWorker) {
      warnedDocumentWorker = true;
      log.warn('document worker unavailable; snapshots will use the main thread', { error });
    }
    const document = normalizedDocument(await readJson<unknown>(documentFile(dir)));
    return { document, canonical: canonicalJson(document) };
  }
}

/**
 * Reading a project is queued against writing it.
 *
 * The document is replaced by an atomic write — a temp file renamed over the old one — and on Windows that
 * rename fails outright while another handle has the destination open for reading. A live register room writes
 * its snapshot every few hundred milliseconds, so "somebody opened this map while it was being written" stops
 * being a rare interleaving and becomes an ordinary one. Taking the same per-project queue the write takes
 * makes the two mutually exclusive, which costs a read only the write it would have collided with.
 */
const projectKey = (dir: string) => `project:${dir}`;

const readSnapshot = async (dir: string): Promise<ProjectSnapshot> => {
  const snapshot = await serialize(projectKey(dir), () => snapshotFromDirectory(dir));
  noteRevision(snapshot.project.id, snapshot.project.revision);
  return snapshot;
};

interface ProjectRead { snapshot: ProjectSnapshot; canonical: string }

/** Caller holds `projectKey(dir)`. */
async function snapshotFromDirectory(dir: string): Promise<ProjectSnapshot> {
  return (await snapshotStateFromDirectory(dir)).snapshot;
}

/** The canonical text is already paid for to reconcile the manifest. Keep it for a write's change-span rather
 * than walking the same document a second time moments later. Caller holds `projectKey(dir)`. */
async function snapshotStateFromDirectory(dir: string): Promise<ProjectRead> {
  const [stored, prepared] = await Promise.all([readManifest(dir), readPreparedDocument(dir)]);
  let manifest = stored;
  const { document, canonical } = prepared;
  const actualHash = hashJson(canonical);
  // A hand edit or a crash between the document and manifest renames must never reuse a revision. Reconcile it
  // as an external edit on first read, preserving optimistic-concurrency safety.
  if (actualHash !== manifest.documentHash) {
    manifest = { ...manifest, revision: manifest.revision + 1, documentHash: actualHash, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(manifestFile(dir), manifest);
  }
  return { snapshot: { project: { ...manifest, folder: dir }, document }, canonical };
}

/**
 * Which project each client is editing.
 *
 * This is keyed by client rather than held as one global value because a second browser tab is an ordinary
 * thing to have open, and a single `activeProjectId` means whichever tab last opened a project silently
 * reassigns the other one — the first tab keeps autosaving into a project the user is no longer looking at.
 * A client that sends no id gets the shared default entry, which is what a single tab has always had.
 */
interface SessionFile {
  clients?: Record<string, { activeProjectId: string; lastSeen: string }>;
  /** Written by a Slopesmith that predates per-client sessions; read as the default client's project. */
  activeProjectId?: string;
}

const DEFAULT_CLIENT = 'default';
const clientKey = (clientId?: string) => clientId?.trim() || DEFAULT_CLIENT;

async function readSession(): Promise<SessionFile> {
  return await readJsonOr<SessionFile>(await sessionFile(), {});
}

function activeProjectOf(session: SessionFile, clientId?: string): string | null {
  const key = clientKey(clientId);
  return session.clients?.[key]?.activeProjectId
    // A record written before this file was keyed carries one project; it belongs to whoever asks first.
    ?? (key === DEFAULT_CLIENT ? session.activeProjectId ?? null : null);
}

async function setActiveProject(id: string, clientId?: string): Promise<void> {
  const file = await sessionFile();
  // Read-modify-write: without a queue, two clients activating at once lose one of the two entries.
  await serialize(`session:${file}`, async () => {
    const session = await readJsonOr<SessionFile>(file, {});
    const clients = { ...session.clients, [clientKey(clientId)]: { activeProjectId: id, lastSeen: new Date().toISOString() } };
    await writeJsonAtomic(file, { clients });
  });
}

/** Which map a tab was last on, read off the record the activate route writes. A session joining the channel
 *  seeds its presence from this rather than waiting to be told, so "which map is this person on" is answered
 *  by the same field the editor already keeps. */
export async function activeProjectFor(clientId?: string): Promise<string | null> {
  return activeProjectOf(await readSession(), clientId);
}

/**
 * A revision has landed, and everyone else on that map needs it.
 *
 * The write path raises this rather than reaching for a socket, so the session layer subscribes and this file
 * stays a store. `by` is the tab that wrote it, which is the one client a push must skip — it already holds
 * exactly this document and would otherwise replace its own live edit with an echo of it.
 */
export interface ProjectWrite {
  snapshot: ProjectSnapshot;
  by?: string;
}

const writeListeners = new Set<(write: ProjectWrite) => void>();

export function onProjectWritten(listener: (write: ProjectWrite) => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

function announceWrite(write: ProjectWrite): void {
  noteRevision(write.snapshot.project.id, write.snapshot.project.revision);
  for (const listener of writeListeners) {
    try { listener(write); } catch (error) { log.error('a revision listener failed', { error }); }
  }
}

/**
 * The newest revision this process has SEEN for a project — read or written, announced or not.
 *
 * The file watcher below is the only reader, and it exists to answer one question: is this manifest newer
 * than anything we know about, or is it the write we just made? A room snapshot does not announce and a read
 * does not either, so tracking only announcements would make the watcher re-announce our own work.
 */
const seenRevision = new Map<string, number>();
const noteRevision = (id: string, revision: number): void => {
  if ((seenRevision.get(id) ?? -1) < revision) seenRevision.set(id, revision);
};

/**
 * Watch the projects folder for writes this process did not make.
 *
 * `announceWrite` is an in-process event: an import, a checkpoint restore or a save inside THIS server reaches
 * every listener, and a write from anywhere else — a headless recipe, a second server, a restored backup —
 * reaches the file and nothing at all. A live register room then holds a document older than the file and its
 * next snapshot writes over it under a higher revision number, which is a lost update the optimistic check
 * cannot see because the room is the one that is behind.
 *
 * So the watcher turns an outside write into the event the rest of the server already handles: rooms adopt it
 * ([039](../../docs/039-concurrent-editing.md)), connected clients are told the new revision, and nothing had
 * to learn a second mechanism. Only the manifest is watched, because `writeDocument` writes the document
 * first — seeing `project.json` means the document beside it is already there.
 *
 * Losing the watch costs freshness, never correctness: the room's snapshot still carries the revision it last
 * saw, so an outside write it never heard about makes that write CONFLICT rather than disappear.
 */
export async function watchProjectWrites(): Promise<() => void> {
  const root = await projectRoot();
  if (!await pathExists(root)) return () => {};
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const reconcile = async (dir: string): Promise<void> => {
    pending.delete(dir);
    try {
      const manifest = await readManifest(dir);
      if ((seenRevision.get(manifest.id) ?? -1) >= manifest.revision) return;
      announceWrite({ snapshot: await readSnapshot(dir) });
    } catch {
      // A manifest caught mid-rename, or a folder removed under us. The next event re-reads it, and a room
      // that never hears is protected by its own base revision.
    }
  };

  // Canonical, because a recursive watch opened on an 8.3 short path aborts the process — see `canonicalDir`.
  // Only the handle needs it: what comes back is relative to the watched directory either way, so the folder
  // this reconciles stays the one the rest of the store names.
  const watcher = watch(await canonicalDir(root), { recursive: true }, (_event, filename) => {
    if (filename === null) return;
    const parts = filename.toString().split(/[\\/]/);
    if (parts.length !== 2 || basename(parts[1]) !== 'project.json') return;
    const dir = join(root, parts[0]);
    // Debounced per project: an atomic write is a temp file plus a rename, and several events for one save.
    clearTimeout(pending.get(dir));
    pending.set(dir, setTimeout(() => { void reconcile(dir); }, 150));
  });
  watcher.on('error', error => log.warn('the projects watch stopped', { error }));
  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    watcher.close();
  };
}

/**
 * A map is gone, and everybody watching it has to be taken off it.
 *
 * Raised the way a revision is, and for the same reason: the store announces and the session layer subscribes,
 * so this file stays a store. What travels is the manifest as it last stood, because a listener has to name
 * the map to the people who were on it after the folder that held its name has been removed.
 */
const deleteListeners = new Set<(project: ProjectManifest & { folder: string }) => void>();

export function onProjectDeleted(listener: (project: ProjectManifest & { folder: string }) => void): () => void {
  deleteListeners.add(listener);
  return () => deleteListeners.delete(listener);
}

function announceDeleted(project: ProjectManifest & { folder: string }): void {
  for (const listener of deleteListeners) {
    try { listener(project); } catch (error) { log.error('a deletion listener failed', { error }); }
  }
}

/** A map's ownership/edit allow-list changed. The session channel listens so already-open tabs gain or lose
 *  write access immediately rather than keeping the policy captured when they joined. */
const permissionListeners = new Set<(project: ProjectManifest & { folder: string }) => void>();

export function onProjectPermissionsChanged(
  listener: (project: ProjectManifest & { folder: string }) => void,
): () => void {
  permissionListeners.add(listener);
  return () => permissionListeners.delete(listener);
}

function announcePermissions(project: ProjectManifest & { folder: string }): void {
  for (const listener of permissionListeners) {
    try { listener(project); }
    catch (error) { log.error('a permission listener failed', { error }); }
  }
}

export async function listProjects(): Promise<Array<ProjectManifest & { folder: string }>> {
  const root = await projectRoot();
  const dirs = await projectDirectories();
  const manifests = await mapLimit(dirs, READ_CONCURRENCY,
    dir => readJsonOr<ProjectManifest | null>(manifestFile(dir), null));
  rememberLocations(root, dirs, manifests);
  return dirs
    .flatMap((dir, index) => {
      const manifest = manifests[index];
      // An unreadable manifest is skipped rather than failing the whole listing.
      return manifest?.id && Number.isInteger(manifest.revision) ? [{ ...manifest, folder: dir }] : [];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function currentProject(clientId?: string): Promise<ProjectSnapshot | null> {
  const active = activeProjectOf(await readSession(), clientId);
  if (!active) return null;
  return readSnapshot(await findProject(active));
}

export async function openProject(id: string, activate = false, clientId?: string): Promise<ProjectSnapshot> {
  const snapshot = await readSnapshot(await findProject(id));
  if (activate) await setActiveProject(id, clientId);
  return snapshot;
}

/** Read the small policy-bearing manifest without walking the mountain document. */
export async function projectManifest(id: string): Promise<ProjectManifest & { folder: string }> {
  const folder = await findProject(id);
  return { ...await readManifest(folder), folder };
}

export async function requireProjectEdit(id: string, actor: ProjectActor): Promise<ProjectManifest & { folder: string }> {
  const project = await projectManifest(id);
  if (!canEditProject(project, actor)) {
    throw new ProjectPermissionError(project.editorIds === undefined
      ? 'Changing this map needs the editor role.'
      : 'This map is restricted to editors selected by its owner.');
  }
  return project;
}

export async function requireProjectManager(id: string, actor: ProjectActor): Promise<ProjectManifest & { folder: string }> {
  const project = await projectManifest(id);
  if (!canManageProject(project, actor)) {
    throw new ProjectPermissionError('Only this map\'s owner or a moderator can manage it.');
  }
  return project;
}

/** Restrict editing to a stable-id allow-list, or pass null to admit every server editor again. Permission
 *  metadata is not a mountain-document revision, so this updates the manifest atomically without advancing
 *  the document's revision line. */
export async function setProjectEditors(id: string, editorIds: readonly string[] | null):
  Promise<ProjectManifest & { folder: string }> {
  const dir = await findProject(id);
  const normalized = editorIds === null ? null : [...new Set(editorIds
    .map(value => value.trim()).filter(Boolean))].slice(0, 1_000).sort();
  const next = await serialize(projectKey(dir), async () => {
    const manifest = await readManifest(dir);
    const { editorIds: _previous, ...withoutEditors } = manifest;
    const written: ProjectManifest = {
      ...withoutEditors,
      schema: PROJECT_SCHEMA,
      ...(normalized === null ? {} : { editorIds: normalized }),
    };
    await writeJsonAtomic(manifestFile(dir), written);
    return { ...written, folder: dir };
  });
  announcePermissions(next);
  return next;
}

/** What a project owns from the moment it exists, so nothing writes into a folder that is not there yet. */
const PROJECT_FOLDERS = [
  '', 'autosaves', 'build', 'assets', 'assets/skies', 'assets/textures', 'assets/props',
  'assets/music', 'assets/sounds',
];

/**
 * Create a project under a map name that is free.
 *
 * A map is one of the things names never overwrite (docs/038): a second MOUNTAIN01 lands as MOUNTAIN01_2 and
 * the author is told which name it got, and a deleted map's name is retired rather than handed to the next
 * one. That is the same rule and the same record the texture, sound and prop libraries use, so the projects
 * folder keeps its retired stems in `projects.retired.json` beside itself.
 *
 * The name the map lands under goes into the document as well as the manifest, because the document's name
 * is what the next save writes back — a manifest renamed on its own would be undone by the first autosave.
 */
export async function createProject(value: unknown, clientId?: string, activate = true,
  ownerId = 'owner', name?: string): Promise<ProjectSnapshot> {
  const requested = normalizedDocument(value);
  // A caller-supplied name outranks the document's own (the default mountain arrives called MOUNTAIN01) and
  // then walks the same free-name path below, so it behaves exactly as a later g/name rename would:
  // sanitised, and suffixed _2 and up when the stem is spoken for.
  if (name?.trim()) requested.name = name.trim();
  const root = await projectRoot();
  // Read once inside the name lock: the loop that walks _2, _3 … asks repeatedly, and every answer comes
  // from the same listing the free name was chosen against.
  let taken: Set<string> | null = null;
  const { stored } = await storeUnderFreeName<ProjectSnapshot>({
    library: root,
    name: requested.name || 'mountain',
    fallback: 'mountain',
    taken: async stem => {
      taken ??= new Set((await listProjects()).map(project => project.name.toLowerCase()));
      return taken.has(stem.toLowerCase());
    },
    write: async name => {
      const document = { ...requested, name };
      const id = randomUUID();
      const dir = join(root, `${safeSlug(name)}-${id.slice(0, 8)}`);
      await Promise.all(PROJECT_FOLDERS.map(folder => ensureDir(join(dir, folder))));
      const now = new Date().toISOString();
      const manifest: ProjectManifest = {
        schema: PROJECT_SCHEMA, id, name, createdAt: now, updatedAt: now,
        revision: 1, documentHash: hashDocument(document), ownerId,
      };
      // The document lands before the manifest that names its hash, so a crash between the two leaves a
      // project whose next read reconciles as an external edit rather than one with no document at all.
      await writeJsonAtomic(documentFile(dir), storedDocument(document));
      await writeJsonAtomic(manifestFile(dir), manifest);
      locationsFor(root).set(id, dir);
      return { project: { ...manifest, folder: dir }, document };
    },
  });
  if (activate) await setActiveProject(stored.project.id, clientId);
  return stored;
}

/** Finish assembling a just-created project's revision 1 without manufacturing a revision 2. Portable
 * mountain import creates the ownership boundary first, installs assets inside it, then uses this seam to
 * commit the document after any imported model ids/names have been retargeted. */
export async function finishProjectCreation(id: string, value: unknown): Promise<ProjectSnapshot> {
  const dir = await findProject(id);
  return serialize(projectKey(dir), async () => {
    const manifest = await readManifest(dir);
    if (manifest.revision !== 1) throw new Error('only a new mountain can finish project creation');
    const requested = normalizedDocument(value);
    const document = { ...requested, name: manifest.name };
    const prepared = await prepareDocument(document);
    const next: ProjectManifest = { ...manifest, documentHash: hashJson(prepared.canonical) };
    await writeJsonAtomic(documentFile(dir), JSON.parse(prepared.storedJson));
    await writeJsonAtomic(manifestFile(dir), next);
    return { project: { ...next, folder: dir }, document };
  });
}

/**
 * Delete a map, retiring its name.
 *
 * Retiring is the half that matters: a name returned to the pool is a URL that answers with different bytes
 * than it did yesterday, so the next MOUNTAIN01 lands as MOUNTAIN01_2 exactly as it would have while the
 * original was still there. Clients sitting on the deleted project are released rather than left pointing at
 * a folder that is gone, which would fail every read of the active project instead of showing none — the
 * record of which map each tab had open here, and the live sessions, rooms and presence the announcement
 * takes off it.
 */
export async function deleteProject(id: string): Promise<ProjectManifest & { folder: string }> {
  const dir = await findProject(id);
  const manifest = await readManifest(dir);
  const root = await projectRoot();
  await retireName(root, manifest.name, async () => {
    await serialize(projectKey(dir), () => rm(dir, { recursive: true, force: true }));
    locationsFor(root).delete(id);
    clearCheckpointCadence(dir);
    return true;
  });
  const deleted = { ...manifest, folder: dir };
  // Announced as soon as the folder is gone, because until it is heard a live room goes on writing snapshots
  // into it on a timer of its own.
  announceDeleted(deleted);
  const file = await sessionFile();
  await serialize(`session:${file}`, async () => {
    const session = await readJsonOr<SessionFile>(file, {});
    const clients = Object.fromEntries(Object.entries(session.clients ?? {})
      .filter(([, entry]) => entry.activeProjectId !== id));
    await writeJsonAtomic(file, { clients });
  });
  return deleted;
}

// ---- checkpoints (docs/040) ----

/** What the History panel lists for one project. */
export async function listCheckpoints(id: string): Promise<CheckpointListing> {
  return listProjectCheckpoints(await findProject(id));
}

/** One checkpoint's whole document, migrated exactly like the live one so an older schema still opens. */
export async function readCheckpoint(id: string, file: string):
  Promise<{ checkpoint: ProjectCheckpoint; document: EditDoc }> {
  return readProjectCheckpoint(await findProject(id), file, normalizedDocument);
}

/** Set the project aside as it stands, right now. */
export async function checkpointNow(id: string, request: CheckpointRequest): Promise<ProjectCheckpoint | null> {
  const dir = await findProject(id);
  return serialize(projectKey(dir), async () => {
    const { revision } = await readManifest(dir);
    return checkpointProjectNow(dir, revision, request);
  });
}

/** Set aside the work of a session when its last editor disconnects. */
export async function checkpointOnSessionEnd(id: string, members: string[] = []): Promise<ProjectCheckpoint | null> {
  return checkpointNow(id, { reason: 'idle', members, note: 'the last editor left' });
}

/** Name a checkpoint, which also pins it against scheduled pruning. */
export async function nameCheckpoint(id: string, file: string, note: string, by = ''): Promise<ProjectCheckpoint> {
  return nameProjectCheckpoint(await findProject(id), file, note, by);
}

/** A restore that changed nothing is not a write: the project already holds exactly that document. */
export type RestoreResult = ProjectSnapshot & { unchanged: boolean };

/**
 * Make a checkpoint the newest revision.
 *
 * Restoring is forward-only: r12 restored while the project sits at r47 is written as r48 whose content is
 * r12's, and the counter never rewinds. Every client holds an expectation about where the revision line is,
 * so rewinding it would let a client still holding r47 have a stale write accepted as a fresh one. Going
 * through the ordinary write keeps that true by construction — same queue, same optimistic check — and the
 * document being replaced is set aside as a pinned checkpoint on the way through, so a restore nobody wanted
 * is undone by another restore however long it takes to notice.
 */
export async function restoreCheckpoint(id: string, baseRevision: number, file: string, by?: string,
  allowRename = true):
  Promise<RestoreResult> {
  const { checkpoint, document } = await readCheckpoint(id, file);
  const written = await writeDocument(id, document, {
    baseRevision, by, allowRename,
    forced: { reason: 'restore', note: `replaced by a restore of the checkpoint from ${checkpoint.takenAt}` },
  });
  return { ...written.snapshot, unchanged: written.unchanged };
}

/** What a write is besides its document: the revision it expects to find, whether it is announced, and any
 *  checkpoint it forces. A write with no `baseRevision` skips the optimistic check, which is what the live
 *  register room's own snapshots are — the room holds the authoritative document while it is open, so there
 *  is no revision for it to be behind. */
interface WriteOptions {
  baseRevision?: number;
  forced?: CheckpointRequest;
  by?: string;
  /** False for a snapshot every participant already holds as registers, so nobody is pushed a document that
   *  would replace the edit they are in the middle of. */
  announce?: boolean;
  /** A room already holds an EditDoc. Clone it synchronously instead of migrating it, because it may receive
   * another register assignment while this snapshot is waiting for its project queue or worker. */
  roomSnapshot?: boolean;
  /** False for a writer who may edit this map but does not own/moderate it. A checkpoint or whole-document
   *  save can then restore content without smuggling a map rename through that larger payload. */
  allowRename?: boolean;
}

/**
 * The one write path: the optimistic check, whatever checkpoint that write is owed, then the document and the
 * manifest that names its hash.
 *
 * The optimistic check and the write that depends on it must be one indivisible step. With awaits between
 * them, two concurrent saves of the same project both read revision N, both pass the check, and both write
 * N+1 — one author's edit silently replacing the other's under a revision number that claims otherwise.
 * Queued per project directory, so saving one mountain never waits on another.
 *
 * A map's name lives in the document, so a rename IS a save (the Info panel binds it), and a map is one of the
 * things names never overwrite (docs/038). A save asking for a name this map is not already called therefore
 * goes through the same free-name helper creating one goes through: it lands on a free name, it is told which,
 * and the name it moved off is retired. Every other save keeps the name the manifest holds, which is what
 * makes the manifest the authority on what a map is called.
 */
async function writeDocument(id: string, value: unknown,
  options: WriteOptions = {}): Promise<{ snapshot: ProjectSnapshot; unchanged: boolean }> {
  const { baseRevision, forced, by, announce = true, roomSnapshot = false, allowRename = true } = options;
  if (!value || typeof value !== 'object') throw new Error('Project document must be a JSON object');
  // This must precede every await. A live room intentionally continues accepting edits while an older
  // snapshot is queued; cloning later could persist some nested values from each side of that boundary.
  const document = roomSnapshot ? structuredClone(value as EditDoc) : normalizedDocument(value);
  const asked = allowRename ? nameAsked(document) : '';
  const dir = await findProject(id);

  /** Everything the write is, under the name it lands on. `claimed` is set by the rename path only. */
  const commit = (claimed?: string) => serialize(projectKey(dir), async () => {
    const currentRead = await snapshotStateFromDirectory(dir);
    const current = currentRead.snapshot;
    if (baseRevision !== undefined && current.project.revision !== baseRevision) {
      throw new ProjectConflictError(current);
    }
    // A write that did not claim a name cannot change one, so a save landing behind a rename of the same map
    // stores what that rename settled on rather than quietly renaming it back. A name and its case variants
    // are one name, so the case a save asks for is simply stored.
    const name = claimed
      ?? (asked && sameName(asked, current.project.name) ? asked : current.project.name);
    const named = { ...document, name };
    const prepared = await prepareDocument(named);
    const documentHash = hashJson(prepared.canonical);
    // Nothing changed, so there is nothing to record: no revision, and no checkpoint of a document that is
    // about to be written back over itself.
    if (documentHash === current.project.documentHash) return { snapshot: current, unchanged: true };
    await checkpointOutgoing(dir, current.project.revision,
      changedDocumentSpan(currentRead.canonical, prepared.canonical), forced);
    const held = formerNames(current.project, claimed ? current.project.name : undefined);
    const manifest: ProjectManifest = {
      schema: PROJECT_SCHEMA,
      id: current.project.id,
      name,
      createdAt: current.project.createdAt,
      updatedAt: new Date().toISOString(),
      revision: current.project.revision + 1,
      documentHash,
      ...(current.project.ownerId ? { ownerId: current.project.ownerId } : {}),
      ...(current.project.editorIds !== undefined ? { editorIds: current.project.editorIds } : {}),
      ...(held.length ? { formerNames: held } : {}),
    };
    // The name the map lands under goes into the document as well as the manifest, for the reason
    // `createProject` gives: the document's name is what the next save writes back, so a manifest renamed on
    // its own would be undone by the first autosave after it.
    await writeFileAtomic(documentFile(dir), prepared.storedJson);
    await writeJsonAtomic(manifestFile(dir), manifest);
    return { snapshot: { project: { ...manifest, folder: dir }, document: named }, unchanged: false };
  });

  const held = await readManifest(dir);
  const written = asked && !sameName(asked, held.name)
    ? await commitRenamed(id, held, asked, commit)
    : await commit();
  // Announced outside the queue: a listener that pushes to sockets must not hold up the next save.
  if (!written.unchanged && announce) announceWrite({ snapshot: written.snapshot, by });
  // A room snapshot does not announce, and the file watcher must still know it was ours rather than somebody
  // else's — otherwise every snapshot the room takes comes straight back to it as an external write.
  else noteRevision(written.snapshot.project.id, written.snapshot.project.revision);
  return written;
}

/**
 * Commit a write under a map name that is free, retiring the one it moves off.
 *
 * **The library's name lock is the outer one.** `deleteProject` takes the library and then the project queue,
 * so a rename that resolved its name from INSIDE the project queue would take the same two in the opposite
 * order — a delete holding the library while it waits for the project, a save holding the project while it
 * waits for the library, and neither ever moving. Taking the library first and doing the whole queued commit
 * inside it orders every pair of these one way. Only a save that actually changes the name comes here, so an
 * ordinary save never waits on the whole library either.
 */
async function commitRenamed<T>(id: string, held: ProjectManifest, asked: string,
  commit: (name: string) => Promise<T>): Promise<T> {
  const root = await projectRoot();
  // Read once inside the name lock: the loop that walks _2, _3 … asks repeatedly, and every answer comes from
  // the same listing the free name was chosen against.
  let taken: Set<string> | null = null;
  const { stored } = await storeUnderFreeName<T>({
    library: root,
    name: asked,
    fallback: held.name,
    // Every OTHER map. A map does not collide with itself, so a rename that changes nothing but a name's case
    // is not answered with a suffixed variant of the name the map already wears.
    taken: async stem => {
      taken ??= new Set((await listProjects())
        .flatMap(project => project.id === id ? [] : [project.name.toLowerCase()]));
      return taken.has(stem.toLowerCase());
    },
    // Names this map has held are retired for every other map and free for this one, so restoring a revision
    // authored under an older name puts that name back instead of claiming a suffixed variant of it.
    reclaims: [...(held.formerNames ?? []), held.name],
    write: commit,
    retires: held.name,
  });
  return stored;
}

export async function saveProject(id: string, baseRevision: number, value: unknown, by?: string,
  allowRename = true):
  Promise<ProjectSnapshot> {
  return (await writeDocument(id, value, { baseRevision, by, allowRename })).snapshot;
}

/**
 * The live register room's snapshot of the document it holds (docs/039).
 *
 * While a room is open it, not the file, is the authoritative copy: participants send absolute register
 * assignments, the room applies them in arrival order, and this is what makes that durable — a revisioned
 * write every so many accepted changes, so the stored format, the revision line and the checkpoint ring go on
 * working exactly as they do for a save. It is not announced, because everybody on the map already holds
 * these values.
 *
 * It carries the revision the room last saw all the same, and that is not a formality. `announceWrite` is an
 * in-process event, so the room hears an import, a checkpoint restore or another save in ITS server and
 * adopts it — but a write from a different process (a headless recipe, a second server, a restored backup)
 * reaches the file and nothing else. Without the check the room's next snapshot would write its older
 * document over that one under a higher revision number, which is a silent lost update of exactly the kind
 * the optimistic check exists to prevent. With it, the room is told, and re-reads.
 */
export async function saveRoomDocument(id: string, value: unknown,
  baseRevision?: number): Promise<ProjectSnapshot> {
  return (await writeDocument(id, value, { announce: false, roomSnapshot: true, baseRevision })).snapshot;
}

export async function activateProject(id: string, clientId?: string): Promise<ProjectSnapshot> {
  const snapshot = await openProject(id);
  await setActiveProject(id, clientId);
  return snapshot;
}
