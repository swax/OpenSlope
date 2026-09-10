import type { EditDoc } from '../../core/doc/doc-edit';
import type { ChangeSummary } from '../../core/doc/compare';
import type { ProjectBundle } from '../../core/project/transfer';
import { clientFetch, setClientProjectId } from '../net/client';

export { clientId } from '../net/client';

export type ProjectSaveState =
  'loading' | 'saving' | 'saved' | 'recovery-only' | 'conflict' | 'error' | 'following' | 'shared';

export interface ClientProject {
  id: string;
  name: string;
  revision: number;
  folder: string;
  createdAt: string;
  updatedAt: string;
  documentHash: string;
  ownerId?: string;
  /** Undefined admits every server editor; an array is the owner's explicit allow-list. */
  editorIds?: string[];
}

interface ProjectSnapshot {
  project: ClientProject;
  document: EditDoc;
  error?: string;
}

/** One whole document set aside, as the server lists it (docs/040). */
export interface ProjectCheckpoint {
  file: string;
  revision: number;
  takenAt: string;
  bytes: number;
  /** Why it was taken, which is also what the panel says about it. */
  reason: 'timer' | 'named' | 'restore' | 'revert' | 'bulk' | 'idle';
  /** Kept whatever the thinning schedule says. */
  pinned: boolean;
  /** The members whose work it holds. */
  members: string[];
  note?: string;
  namedBy?: string;
}

/**
 * How the map differs from one checkpoint, as the server reads it off the register model (docs/040).
 *
 * This is what answers *"which checkpoint do I actually want"* without downloading each one: the counts, the
 * same counts said in words, and who the room currently credits registers to — which is who a scoped revert
 * may be aimed at.
 */
export interface CheckpointChanges {
  checkpoint: ProjectCheckpoint;
  summary: ChangeSummary;
  described: string[];
  writers: string[];
}

/** How far a revert reaches: one participant's work, a selection of geometry, or both. */
export interface RevertRequest {
  by?: string;
  vertices?: string[];
  quads?: string[];
}

/** What a scoped revert did. */
export interface RevertOutcome {
  document: EditDoc;
  /** How many registers were put back. */
  reverted: number;
  /** Nothing in the scope differed, so no revision was written and nothing was set aside. */
  unchanged: boolean;
  /** The pinned checkpoint holding the document the revert replaced — how a revert nobody wanted is undone. */
  checkpoint: ProjectCheckpoint | null;
  /** What STILL differs from the checkpoint, in words: for a scoped revert, everybody else's work. */
  described: string[];
}

/** The ring as a whole: every checkpoint, what they cost, and whether the byte budget has had to decide. */
export interface CheckpointListing {
  checkpoints: ProjectCheckpoint[];
  budget: { bytes: number; limit: number; droppedAt?: string; dropped?: number };
}

/**
 * A checkpoint that was in the listing and is not on disk any more — thinned while the panel sat open on it.
 * Its own type because the answer is to re-read the listing rather than to report a failure.
 */
export class CheckpointGoneError extends Error {}

/**
 * A save the server refused because the project moved on without this tab — most often the same mountain open
 * in a second tab. It carries what a resolution needs: the revision to rebase onto and the document to adopt.
 */
export interface ProjectConflict {
  project: ClientProject;
  document: EditDoc;
  message: string;
}

/** What importing a self-contained mountain created, including any custom assets it could not restore. */
export interface MountainImportResult extends ProjectSnapshot {
  stored: Array<{ kind: string; from: string; to: string }>;
  absent: string[];
}

export interface DeletedMountain { id: string; name: string }

const SAVE_DELAY_MS = 450;

/**
 * This tab's identity, so the server can keep an active project per editor rather than one globally.
 *
 * Two tabs are two independent replicas — each with its own undo history and its own open mountain — so the
 * id lives in `sessionStorage`, which is per tab, rather than `localStorage`, which every tab of the profile
 * would share. A duplicated tab inherits the value and is corrected on first use, since a fresh id is minted
 * only when the slot is empty. A browser that refuses storage falls back to a per-load id, which is still
 * distinct per tab.
 */
const DEVICE_LABEL_KEY = 'slopesmith.deviceLabel';
const defaultDeviceLabel = (): string => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'phone';
  return 'computer';
};

/** Stable for this browser profile, while tabs remain separate editors through `clientId` above. */
export const deviceLabel = (() => {
  try { return localStorage.getItem(DEVICE_LABEL_KEY)?.trim().slice(0, 32) || defaultDeviceLabel(); }
  catch { return defaultDeviceLabel(); }
})();

export function setDeviceLabel(value: string): string {
  // eslint-disable-next-line no-control-regex -- strips control characters from a user-typed label
  const label = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 32) || defaultDeviceLabel();
  try { localStorage.setItem(DEVICE_LABEL_KEY, label); } catch { /* storage is an optional convenience */ }
  return label;
}

/** Every project request carries the tab id; the server has no other way to tell two editors apart. */
function projectFetch(url: string, init?: RequestInit): Promise<Response> {
  return clientFetch(url, init);
}

async function responseError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    return body.error || `${res.status} ${res.statusText}`;
  } catch { return `${res.status} ${res.statusText}`; }
}

/**
 * A live editor replica backed by one revisioned project on the local Slopesmith server. Rendering and input
 * remain synchronous; full-document snapshots coalesce in the background and localStorage remains the crash
 * recovery path when the local service is unavailable.
 */
export function createProjectSync(deps: {
  getDoc: () => EditDoc;
  onState?: (state: ProjectSaveState, detail?: string) => void;
  /** Raised the moment a save is refused, so the host can put the three outcomes in front of the author
   *  rather than leaving autosave stopped behind a toast. */
  onConflict?: (conflict: ProjectConflict) => void;
  /** A revision somebody else wrote, already applied to this replica as a whole-document replace. The host
   *  renders it and resets undo history — the states it recorded were built on a document that is no longer
   *  the project's, which is the same rule a project switch uses (docs/038). */
  onFollow?: (document: EditDoc) => void;
  /** Send whatever the register replica is holding, right now. Called where a whole-document save would once
   *  have been flushed — before a project switch, a checkpoint or a preview — so what is about to be read off
   *  disk holds the edit that was in the coalescing window (docs/039). */
  flushShared?: () => void;
}) {
  let project: ClientProject | null = null;
  let lastSavedJson = '';
  let dirty = false;
  let blocked = false;
  let pending: ProjectConflict | null = null;
  let previewing = false;
  let saveTimer = 0;
  let inFlight: Promise<void> | null = null;
  let retryDelay = SAVE_DELAY_MS;
  /**
   * Whether this tab may write (docs/039).
   *
   * It starts true and stays true until something says otherwise, because that is what editing alone has to
   * look like: on a server with no accounts and nobody else connected, nothing ever says otherwise, so
   * autosave behaves exactly as it always has.
   */
  let writable = true;
  let readOnlyReason = '';
  /**
   * Whether this project's edits travel as registers rather than as whole documents (docs/039).
   *
   * While they do, this module stops being the transport: the register replica sends absolute assignments as
   * they are made and the SERVER writes the revisioned snapshots, so the 450 ms debounce below is no longer a
   * save timer. Everything else here — creating, opening, checkpoints, previews, the conflict resolution and
   * the recovery-only fallback — is unchanged, and a tab whose channel is not up drops straight back to
   * whole-document autosave, which is what keeps a single author editing offline exactly as before.
   */
  let shared = false;
  let projectChoiceNeeded = false;
  /** A map the URL named that this server does not have, so the host can say so rather than quietly opening a
   *  different mountain than the address asked for. */
  let missingMap = '';

  const state = (next: ProjectSaveState, detail?: string) => deps.onState?.(next, detail);

  async function requestSnapshot(url: string, init?: RequestInit): Promise<ProjectSnapshot> {
    const res = await projectFetch(url, init);
    if (!res.ok) throw new Error(await responseError(res));
    return await res.json() as ProjectSnapshot;
  }

  /** The editor now holds this project's own document — the one point where autosave starts tracking again,
   *  so it is also where a conflict and a preview stop applying. */
  function accept(snapshot: ProjectSnapshot): EditDoc {
    projectChoiceNeeded = false;
    project = snapshot.project;
    setClientProjectId(project.id);
    lastSavedJson = JSON.stringify(snapshot.document);
    dirty = false;
    blocked = false;
    pending = null;
    previewing = false;
    retryDelay = SAVE_DELAY_MS;
    state(shared ? 'shared' : 'saved',
      shared ? `${project.name} · shared` : `${project.name} · revision ${project.revision}`);
    return snapshot.document;
  }

  /**
   * Open this tab's active project — or the map the URL names, which wins over it.
   *
   * The URL is what makes a load deterministic: a bookmarked address opens that mountain every time, rather
   * than whichever one this browser last activated here (`state/map-url.ts`). Opening it activates it too, so
   * a later visit to the plain address lands back on the map the author was actually working on. A name no map
   * on this server holds is recorded rather than obeyed, and the ordinary path below runs — which is what a
   * link to a map that has been renamed, or that lives on somebody else's server, should do.
   *
   * Failing that, a new device adopts the only existing project, asks when there are several, and creates from
   * browser recovery only when this server genuinely has no projects yet.
   */
  async function initialize(recoveryDocument: EditDoc, wanted = '', wantedId = ''): Promise<EditDoc> {
    state('loading', wanted ? `Opening ${wanted}` : 'Opening local mountain');
    try {
      if (wantedId) return await open(wantedId);
      if (wanted) {
        const named = (await list()).find(entry => entry.name.toLowerCase() === wanted.toLowerCase());
        if (named) return await open(named.id);
        missingMap = wanted;
      }
      const current = await projectFetch('/api/projects/current');
      if (current.status === 204) {
        const projects = await list();
        if (projects.length === 1) return await open(projects[0].id);
        if (projects.length > 1) {
          projectChoiceNeeded = true;
          state('loading', 'Choose a mountain to open');
          return recoveryDocument;
        }
        return accept(await requestSnapshot('/api/projects', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ document: recoveryDocument }),
        }));
      }
      if (!current.ok) throw new Error(await responseError(current));
      return accept(await current.json() as ProjectSnapshot);
    } catch (error) {
      state('recovery-only', `Local mountain service unavailable: ${error instanceof Error ? error.message : error}`);
      return recoveryDocument;
    }
  }

  /** A newly authored or forked mountain receives its own durable project directory. */
  async function create(document: EditDoc): Promise<void> {
    clearTimeout(saveTimer);
    await flushBeforeSwitch();
    state('saving', 'Creating mountain');
    try {
      accept(await requestSnapshot('/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document }),
      }));
    } catch (error) {
      state(project ? 'error' : 'recovery-only', `Mountain creation failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  async function list(): Promise<ClientProject[]> {
    const res = await projectFetch('/api/projects');
    if (!res.ok) throw new Error(await responseError(res));
    return (await res.json() as { projects: ClientProject[] }).projects;
  }

  /** Flush the old replica, activate a different disk project, then hand its document to the host to render. */
  async function open(id: string): Promise<EditDoc> {
    clearTimeout(saveTimer);
    await flushBeforeSwitch();
    state('loading', 'Opening local mountain');
    return accept(await requestSnapshot(`/api/projects/${encodeURIComponent(id)}/activate`, { method: 'POST' }));
  }

  /**
   * Snapshot the current durable revision with the complete mountain-local asset catalogue. The browser turns this internal
   * JSON transport into the public `.slopesmith.zip`; no map export or lighting bake is involved.
   */
  async function mountainBundle(withBytes: boolean): Promise<ProjectBundle> {
    if (!project) throw new Error('No mountain is open.');
    await flushBeforeSwitch();
    const exporting = project;
    const res = await projectFetch(`/api/projects/${encodeURIComponent(exporting.id)}/download${withBytes ? '?assets=bytes' : ''}`);
    if (!res.ok) throw new Error(await responseError(res));
    return await res.json() as ProjectBundle;
  }

  const exportMountain = (): Promise<ProjectBundle> => mountainBundle(true);

  /** Import one portable mountain as a fresh workspace project and follow the newly created revision. */
  async function importMountain(bundle: ProjectBundle, name: string): Promise<MountainImportResult> {
    clearTimeout(saveTimer);
    await flushBeforeSwitch();
    state('saving', 'Importing mountain');
    try {
      const res = await projectFetch('/api/projects/transfer', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundle, name }),
      });
      if (!res.ok) throw new Error(await responseError(res));
      const imported = await res.json() as MountainImportResult;
      accept(imported);
      return imported;
    } catch (error) {
      state(project ? 'error' : 'recovery-only', `Mountain import failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  /** Fork the current mountain on this server. The server copies project-local assets without a browser round trip. */
  async function duplicateMountain(name: string): Promise<MountainImportResult> {
    if (!project) throw new Error('No mountain is open.');
    clearTimeout(saveTimer);
    await flushBeforeSwitch();
    state('saving', 'Duplicating mountain');
    try {
      const res = await projectFetch(
        `/api/projects/${encodeURIComponent(project.id)}/duplicate?name=${encodeURIComponent(name)}`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(await responseError(res));
      const duplicated = await res.json() as MountainImportResult;
      accept(duplicated);
      return duplicated;
    } catch (error) {
      state(project ? 'error' : 'recovery-only', `Mountain duplicate failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  /** Delete the open mountain. The host follows the server's `gone` event onto another project afterward. */
  async function deleteMountain(id: string): Promise<DeletedMountain> {
    if (!project || project.id !== id) throw new Error('That mountain is not open.');
    clearTimeout(saveTimer);
    state('saving', `Deleting ${project.name}`);
    try {
      const res = await projectFetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await responseError(res));
      const deleted = (await res.json() as { deleted: DeletedMountain }).deleted;
      // Nothing queued for a project that no longer exists may leak into the replacement mountain. Keep the
      // project identity momentarily so the host's `gone` handoff can recognise it, but abandon its edit state.
      dirty = false;
      blocked = false;
      pending = null;
      previewing = false;
      return deleted;
    } catch (error) {
      state('error', `Mountain deletion failed: ${error instanceof Error ? error.message : error}`);
      if (dirty && !shared) schedule();
      throw error;
    }
  }

  /** Never abandon a dirty/conflicted project merely because the user asked to switch. A read-only tab has
   *  nothing to abandon: what it has rendered is somebody else's work. */
  async function flushBeforeSwitch(): Promise<void> {
    if (!project) return;
    if (!writable) { dirty = false; return; }
    if (blocked) throw new Error('Resolve the mountain conflict (File ▸ Resolve conflict…) before switching mountains.');
    if (dirty) await flush();
    if (dirty) throw new Error('The current mountain could not be saved, so the mountain switch was cancelled.');
  }

  // ---- following read-only (docs/039) ----

  /** Stop writing and start following. Whatever was pending is dropped rather than queued — a follower's
   *  edits are not the project's, and there is no second revision line for them to land on later. */
  function follow(reason: string): void {
    clearTimeout(saveTimer);
    writable = false;
    readOnlyReason = reason;
    dirty = false;
    state('following', reason);
  }

  /**
   * Whether this tab may change the map it is on.
   *
   * Called by the session channel when the room answers a join, and by nothing else. Two things say no: the
   * viewer role, and a build whose document or core version differs from the server's, which would evaluate
   * this mountain differently from everybody else on it (docs/039). Setting it back to true resumes from the
   * document as it now stands, so this tab never writes something the author cannot see.
   */
  function setWritable(next: boolean, reason = ''): void {
    if (next === writable) { if (!next && reason) readOnlyReason = reason; return; }
    if (!next) { follow(reason || 'This map is open read-only.'); return; }
    writable = true;
    readOnlyReason = '';
    dirty = false;
    retryDelay = SAVE_DELAY_MS;
    if (project) state('saved', `${project.name} · revision ${project.revision}`);
  }

  /**
   * A revision somebody else wrote, applied as a whole-document replace.
   *
   * This is `accept()` — the very thing that already replaces the whole document when a project is opened —
   * triggered by a push instead of by a response. Safe by construction: there is one revision line, the
   * server orders it, and a follower's replica is simply set to whatever it now holds.
   *
   * A push for another map, or one this replica already has, is ignored rather than applied backwards.
   */
  function applyPush(push: { project: ClientProject; document: EditDoc }): EditDoc | null {
    if (!project || !push?.project || push.project.id !== project.id) return null;
    if (push.project.revision <= project.revision) return null;
    const document = accept({ project: push.project, document: push.document });
    if (!writable) state('following', readOnlyReason || `${push.project.name} · revision ${push.project.revision}`);
    deps.onFollow?.(document);
    return document;
  }

  /** Ownership/edit policy changes live beside the document and do not manufacture a document revision. */
  function applyProjectMetadata(next: ClientProject): boolean {
    if (!project || next.id !== project.id) return false;
    project = next;
    return true;
  }

  async function setProjectEditors(editorIds: string[] | null): Promise<ClientProject> {
    if (!project) throw new Error('No mountain is open.');
    const res = await projectFetch(`/api/projects/${encodeURIComponent(project.id)}/permissions`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ editorIds }),
    });
    if (!res.ok) throw new Error(await responseError(res));
    const answer = await res.json() as { project: ClientProject };
    applyProjectMetadata(answer.project);
    return answer.project;
  }

  /** Mark the in-memory document dirty. The existing rebuild/history funnel calls this after a realized edit.
   *  A preview is showing a checkpoint rather than the project, so nothing it renders may be saved, and a
   *  follower is watching somebody else's map rather than writing one. */
  function schedule(): void {
    if (previewing || !writable) return;
    dirty = true;
    if (!project || blocked) return;
    // Shared: the register replica is the transport and the server writes the revisions, so there is no save
    // to arm here. The document is still marked dirty, because a project switch and a checkpoint both need to
    // know an edit is outstanding.
    if (shared) return;
    retryDelay = SAVE_DELAY_MS;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void flush(); }, SAVE_DELAY_MS);
  }

  /**
   * Whether this tab's edits travel as registers.
   *
   * Turned on when the room on this map is open and this tab may write to it, and off the moment the channel
   * drops — at which point whatever is outstanding is saved whole, exactly as it would have been all along.
   */
  function setShared(next: boolean): void {
    if (next === shared) return;
    shared = next;
    if (shared) {
      clearTimeout(saveTimer);
      if (project) state('shared', `${project.name} · shared`);
      return;
    }
    if (project) state('saved', `${project.name} · revision ${project.revision}`);
    if (dirty) schedule();
  }

  async function runSave(keepalive: boolean): Promise<void> {
    if (!project || !dirty || blocked || !writable) return;
    const savingProject = project;
    const document = deps.getDoc();
    const json = JSON.stringify(document);
    dirty = false;
    if (json === lastSavedJson) { state('saved', `${project.name} · revision ${project.revision}`); return; }
    state('saving', `${project.name} · revision ${project.revision}`);
    try {
      const res = await projectFetch(`/api/projects/${encodeURIComponent(project.id)}/document`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, keepalive,
        body: JSON.stringify({
          baseRevision: savingProject.revision,
          updateId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
          document,
        }),
      });
      if (res.status === 409) {
        const server = await res.json() as ProjectSnapshot;
        if (server.project) project = server.project;
        // What the server holds is now the last saved document, so a resolution compares the in-memory
        // document against what is actually on disk rather than against this tab's last write.
        if (server.document) lastSavedJson = JSON.stringify(server.document);
        blocked = true;
        dirty = true;
        pending = {
          project: server.project, document: server.document,
          message: server.error || 'The mountain changed on disk; browser recovery was preserved.',
        };
        state('conflict', pending.message);
        deps.onConflict?.(pending);
        return;
      }
      if (!res.ok) throw new Error(await responseError(res));
      const saved = await res.json() as ProjectSnapshot;
      // A project switch while this request was in flight makes the acknowledgement stale.
      if (project?.id !== savingProject.id) return;
      project = saved.project;
      lastSavedJson = JSON.stringify(saved.document);
      retryDelay = SAVE_DELAY_MS;
      state('saved', `${project.name} · revision ${project.revision}`);
    } catch (error) {
      dirty = true;
      retryDelay = Math.min(30_000, Math.max(2_000, retryDelay * 2));
      state('error', `Autosave failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Serialize writes; an edit made while one is in flight becomes the next coalesced snapshot. */
  async function flush(keepalive = false): Promise<void> {
    clearTimeout(saveTimer);
    // Shared: what is outstanding is a coalescing window's worth of register assignments, so flushing means
    // sending those rather than writing a document the server would have to reconcile against everybody
    // else's. The revision follows on the room's own cadence.
    if (shared) { deps.flushShared?.(); dirty = false; return; }
    if (inFlight) {
      await inFlight;
      if (dirty && !blocked) return await flush(keepalive);
      return;
    }
    inFlight = runSave(keepalive).finally(() => { inFlight = null; });
    await inFlight;
    if (dirty && !blocked && project) {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { void flush(); }, retryDelay);
    }
  }

  // ---- conflict resolution (docs/038) ----
  // A refused save stops autosave until one of three outcomes is chosen; each one ends with the editor
  // tracking a project again, so the editor is never left with nowhere to write.

  /** Keep mine: rebase the in-memory document onto the revision the server now holds and write it there. */
  async function keepMine(): Promise<void> {
    if (!pending) return;
    project = pending.project;
    pending = null;
    blocked = false;
    dirty = true;
    retryDelay = SAVE_DELAY_MS;
    await flush();
  }

  /** Take theirs: adopt the project as it now stands on disk. The caller renders the returned document and
   *  resets undo history the same way a project switch does — the states it recorded were built on a
   *  document that is no longer the project's. */
  async function takeTheirs(): Promise<EditDoc> {
    if (!project) throw new Error('No mountain is open.');
    const conflicted = pending;
    state('loading', 'Opening the saved mountain');
    try {
      return accept(await requestSnapshot(`/api/projects/${encodeURIComponent(project.id)}`));
    } catch (error) {
      if (conflicted) state('conflict', conflicted.message); // still blocked, so the dialog remains reachable
      throw error;
    }
  }

  /** Keep both: the in-memory document becomes a project of its own and the editor follows it there, leaving
   *  the conflicted project exactly as the other editor saved it. */
  async function saveMineAsNewProject(): Promise<void> {
    const conflicted = pending;
    state('saving', 'Creating mountain');
    try {
      accept(await requestSnapshot('/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document: deps.getDoc() }),
      }));
    } catch (error) {
      if (conflicted) state('conflict', conflicted.message);
      throw error;
    }
  }

  // ---- history (docs/040) ----

  /** A checkpoint request, with a 410 read as what it is: the listing this call was made from is stale. */
  async function checkpointFetch(url: string, init?: RequestInit): Promise<Response> {
    const res = await projectFetch(url, init);
    if (res.status === 410) throw new CheckpointGoneError(await responseError(res));
    if (!res.ok) throw new Error(await responseError(res));
    return res;
  }

  /** The checkpoints this project holds, newest first, and what the ring costs. */
  async function checkpoints(): Promise<CheckpointListing> {
    if (!project) throw new Error('No mountain is open.');
    const res = await checkpointFetch(`/api/projects/${encodeURIComponent(project.id)}/checkpoints`);
    return await res.json() as CheckpointListing;
  }

  const checkpointUrl = (id: string, file: string) =>
    `/api/projects/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(file)}`;

  /** One checkpoint's whole document, for a preview or a fork. Reads only; the project is untouched. */
  async function readCheckpoint(file: string): Promise<EditDoc> {
    if (!project) throw new Error('No mountain is open.');
    const res = await checkpointFetch(checkpointUrl(project.id, file));
    return (await res.json() as { document: EditDoc }).document;
  }

  /** Export one historical revision through the same self-contained mountain bundle as the live revision. */
  async function exportCheckpoint(file: string): Promise<ProjectBundle> {
    if (!project) throw new Error('No mountain is open.');
    const res = await checkpointFetch(`${checkpointUrl(project.id, file)}/download?assets=bytes`);
    return await res.json() as ProjectBundle;
  }

  /** Set the project aside as it stands: a checkpoint someone named, or the forced one a bulk destructive edit
   *  takes before it runs. Pending edits land first, so the checkpoint holds the document about to be changed
   *  rather than the one last written. */
  async function checkpointNow(note: string, reason: 'named' | 'bulk' = 'named'): Promise<ProjectCheckpoint | null> {
    if (!project) throw new Error('No mountain is open.');
    await flushBeforeSwitch();
    const res = await checkpointFetch(`/api/projects/${encodeURIComponent(project.id)}/checkpoints`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note, reason }),
    });
    return (await res.json() as { checkpoint: ProjectCheckpoint | null }).checkpoint;
  }

  /** Name a checkpoint already on the ring, which is what keeps it from ever being thinned. */
  async function nameCheckpoint(file: string, note: string): Promise<ProjectCheckpoint> {
    if (!project) throw new Error('No mountain is open.');
    const res = await checkpointFetch(`${checkpointUrl(project.id, file)}/name`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }),
    });
    return (await res.json() as { checkpoint: ProjectCheckpoint }).checkpoint;
  }

  /** Make a checkpoint the newest revision. Pending edits land first, so nothing written a moment ago can
   *  arrive after the restore and quietly undo it. A checkpoint identical to what the project already holds
   *  writes no revision, and says so rather than reporting a restore that did nothing. */
  async function restoreCheckpoint(file: string): Promise<{ document: EditDoc; unchanged: boolean }> {
    if (!project) throw new Error('No mountain is open.');
    await flushBeforeSwitch();
    const target = project;
    state('saving', `${target.name} · restoring a checkpoint`);
    const res = await checkpointFetch(`${checkpointUrl(target.id, file)}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: target.revision }),
    });
    const restored = await res.json() as ProjectSnapshot & { unchanged?: boolean };
    return { document: accept(restored), unchanged: restored.unchanged === true };
  }

  /** How the map differs from one checkpoint, without downloading it: the counts read off the register model,
   *  the same thing in words, and who the room credits registers to (docs/040). */
  async function checkpointChanges(file: string): Promise<CheckpointChanges> {
    if (!project) throw new Error('No mountain is open.');
    const res = await checkpointFetch(`${checkpointUrl(project.id, file)}/changes`);
    return await res.json() as CheckpointChanges;
  }

  /**
   * Put part of the map back to a checkpoint (docs/040).
   *
   * Scoped rather than whole: rolling an hour back to undo one person's mistake would discard everyone else's
   * good work from that hour. What travels is register assignments — the checkpoint's values for exactly the
   * registers the scope names — so it lands the way any edit lands and everyone else on the map is pushed it
   * as ordinary registers. Pending edits go first, so nothing written a moment ago arrives after the revert
   * and quietly undoes it.
   */
  async function revertCheckpoint(file: string, scope: RevertRequest = {}): Promise<RevertOutcome> {
    if (!project) throw new Error('No mountain is open.');
    await flushBeforeSwitch();
    const target = project;
    state('saving', `${target.name} · reverting to a checkpoint`);
    const res = await checkpointFetch(`${checkpointUrl(target.id, file)}/revert`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scope),
    });
    const outcome = await res.json() as ProjectSnapshot & {
      reverted: number; unchanged: boolean; checkpoint: ProjectCheckpoint | null; described: string[];
    };
    return {
      document: accept(outcome), reverted: outcome.reverted, unchanged: outcome.unchanged === true,
      checkpoint: outcome.checkpoint, described: outcome.described ?? [],
    };
  }

  /** Enter a preview: the editor is about to render a document that is not the project's, so every write is
   *  held until it ends. Outstanding edits are flushed first rather than carried into the preview. */
  async function beginPreview(): Promise<void> {
    await flushBeforeSwitch();
    clearTimeout(saveTimer);
    previewing = true;
    state('saved', `${project?.name ?? 'Preview'} · previewing a checkpoint`);
  }

  /** Leave a preview by reopening the project as it stands on disk. */
  async function endPreview(): Promise<EditDoc> {
    if (!project) { previewing = false; throw new Error('No mountain is open.'); }
    state('loading', 'Reopening the mountain');
    return accept(await requestSnapshot(`/api/projects/${encodeURIComponent(project.id)}`));
  }

  return {
    initialize, create, list, open, exportMountain, importMountain, duplicateMountain, deleteMountain, schedule, flush,
    keepMine, takeTheirs, saveMineAsNewProject,
    checkpoints, readCheckpoint, exportCheckpoint, checkpointNow, nameCheckpoint, restoreCheckpoint,
    checkpointChanges, revertCheckpoint, beginPreview, endPreview,
    setWritable, setShared, applyPush, applyProjectMetadata, setProjectEditors,
    isShared: () => shared,
    current: () => project,
    conflict: () => pending,
    isPreviewing: () => previewing,
    isRecoveryOnly: () => !project,
    needsProjectChoice: () => projectChoiceNeeded,
    missingMapName: () => missingMap,
    isWritable: () => writable,
    readOnlyReason: () => readOnlyReason,
  };
}

export type ProjectSync = ReturnType<typeof createProjectSync>;
