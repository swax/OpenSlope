import { migrateMountain, blankMountain } from '../../core/doc/mountain';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { ProjectBundle } from '../../core/project/transfer';
import type { ImportedPropRecord } from '../../core/props/imported';
import { sanitizePropBehaviour } from '../../core/props/defaults';
import { bundleProps } from '../public/bundle-assets';
import { sha256 } from '../../core/reference/asset-hash';
import type { ClientProject } from './project-sync';
import {
  acceptMountainFolderSnapshot,
  disconnectMountainFolder,
  queueMountainFolderSave,
  readLinkedMountainFolder,
} from './folder-autosave';

interface LocalProject {
  project: ClientProject;
  bundle: ProjectBundle;
  source?: string;
  sourceRevision?: number;
  isoAliases?: Record<string, string>;
  nextPropId?: number;
}

/** Local projects have their own database and identities; a public source id is never a writable project. */
export async function openLocalProjects({ restoreActive = true }: { restoreActive?: boolean } = {}) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('slopesmith-local-workspace', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'project.id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const rows = await new Promise<LocalProject[]>((resolve, reject) => {
    const request = db.transaction('projects').objectStore('projects').getAll();
    request.onsuccess = () => resolve(request.result as LocalProject[]);
    request.onerror = () => reject(request.error);
  });
  const projects = new Map(rows.map(row => [row.project.id, row]));
  // A tab can close before its debounced IndexedDB write. Its synchronous, project-scoped recovery wins.
  for (const row of projects.values()) {
    if (row.isoAliases) row.bundle.isoAliases ??= row.isoAliases;
    try {
      const recovery = localStorage.getItem(`slopesmith.localRecovery:${row.project.id}`);
      if (!recovery) continue;
      const document = migrateMountain(JSON.parse(recovery));
      row.bundle.document = document;
      row.project.name = row.bundle.name = document.name;
    } catch {
      /* a corrupt recovery entry leaves the IndexedDB document intact */
    }
  }
  let active: LocalProject | undefined;
  try {
    if (restoreActive) active = projects.get(sessionStorage.getItem('slopesmith.localProject') ?? '');
  } catch {
    /* optional */
  }
  const snapshot = (row: LocalProject) => ({ project: row.project, document: row.bundle.document });
  async function store(row: LocalProject) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Browser storage is full or unavailable.'));
    });
    projects.set(row.project.id, row);
  }
  function activate(row: LocalProject) {
    active = row;
    try {
      sessionStorage.setItem('slopesmith.localProject', row.project.id);
    } catch {
      /* optional */
    }
    return snapshot(row);
  }
  function makeRow(document: EditDoc, bundle?: ProjectBundle, source?: string, isoAliases?: Record<string, string>) {
    const now = new Date().toISOString();
    const row: LocalProject = {
      project: {
        id: `local-${crypto.randomUUID()}`,
        name: document.name,
        revision: 0,
        folder: '',
        createdAt: now,
        updatedAt: now,
        documentHash: '',
      },
      bundle: {
        kind: 'slopesmith-project',
        schema: 1,
        assets: [],
        ...bundle,
        name: document.name,
        revision: 0,
        takenAt: now,
        document: structuredClone(document),
        ...((isoAliases ?? bundle?.isoAliases) ? { isoAliases: isoAliases ?? bundle?.isoAliases } : {}),
      },
      ...(source ? { source } : {}),
      ...((isoAliases ?? bundle?.isoAliases) ? { isoAliases: isoAliases ?? bundle?.isoAliases } : {}),
    };
    return row;
  }
  async function create(
    document: EditDoc,
    bundle?: ProjectBundle,
    source?: string,
    isoAliases?: Record<string, string>,
    select = true,
  ) {
    const row = makeRow(document, bundle, source, isoAliases);
    await store(row);
    void navigator.storage?.persist?.().catch(() => false);
    return select ? activate(row) : snapshot(row);
  }
  async function createNew() {
    const document = blankMountain();
    const names = new Set([...projects.values()].map(row => row.project.name.toLowerCase()));
    let number = 1;
    while (names.has(`mountain${String(number).padStart(2, '0')}`)) number++;
    document.name = `MOUNTAIN${String(number).padStart(2, '0')}`;
    return create(document);
  }
  /** Allocate copies in one transaction so two tabs cannot claim the same revision name. */
  async function copyPublic(bundle: ProjectBundle, source: string, isoAliases?: Record<string, string>) {
    const row = await new Promise<LocalProject>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const read = store.getAll();
      let copy: LocalProject;
      read.onsuccess = () => {
        const rows = read.result as LocalProject[];
        const names = new Set(rows.map(row => row.project.name.toLowerCase()));
        let revision =
          1 + Math.max(0, ...rows.filter(row => row.source === source).map(row => row.sourceRevision ?? 1));
        const name = () => {
          const suffix = `_REV_${revision}`;
          return `${bundle.document.name.slice(0, 64 - suffix.length)}${suffix}`;
        };
        while (names.has(name().toLowerCase())) revision++;
        const document = structuredClone(bundle.document);
        document.name = name();
        copy = makeRow(document, bundle, source, isoAliases);
        copy.sourceRevision = revision;
        store.put(copy);
      };
      tx.oncomplete = () => resolve(copy);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Browser storage is full or unavailable.'));
    });
    projects.set(row.project.id, row);
    void navigator.storage?.persist?.().catch(() => false);
    return activate(row);
  }
  async function seed(document: EditDoc, bundle?: ProjectBundle, source?: string, isoAliases?: Record<string, string>) {
    const previous = source && [...projects.values()].find(row => row.source === source);
    if (previous) return activate(previous);
    const names = new Set([...projects.values()].map(row => row.project.name.toLowerCase()));
    const copy = structuredClone(document);
    let number = 1;
    while (names.has(copy.name.toLowerCase())) {
      const suffix = `_${++number}`;
      copy.name = `${document.name.slice(0, 64 - suffix.length)}${suffix}`;
    }
    return create(copy, bundle, source, isoAliases);
  }
  async function remove(id: string) {
    await disconnectMountainFolder(id);
    const row = projects.get(id);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    projects.delete(id);
    try {
      localStorage.removeItem(`slopesmith.localRecovery:${id}`);
      const recoveryKey = 'slopesmith-local-mountain-v1';
      const recovery = JSON.parse(localStorage.getItem(recoveryKey) ?? 'null') as { name?: string } | null;
      if (row && recovery?.name === row.project.name) localStorage.removeItem(recoveryKey);
    } catch {
      /* optional */
    }
    try {
      if (sessionStorage.getItem('slopesmith.localProject') === id)
        sessionStorage.removeItem('slopesmith.localProject');
    } catch {
      /* optional */
    }
    if (active?.project.id === id) active = undefined;
  }
  async function request(url: URL, init?: RequestInit): Promise<Response | null> {
    const path = url.pathname,
      method = init?.method?.toUpperCase() ?? 'GET';
    if (path === '/api/custom-prop-import' && method === 'POST' && !url.searchParams.has('adopt')) {
      const projectId = active?.project.id;
      if (!projectId || (url.searchParams.has('project') && url.searchParams.get('project') !== projectId))
        return Response.json({ error: 'Open a local mountain before importing props.' }, { status: 404 });
      let record: ImportedPropRecord;
      try {
        const text = await new Response(init?.body).text();
        if (text.length > 96 * 1024 ** 2) throw new Error('Model is too large.');
        record = JSON.parse(text) as ImportedPropRecord;
        if (
          !record ||
          typeof record.name !== 'string' ||
          !Array.isArray(record.subs) ||
          !record.subs.length ||
          !Array.isArray(record.materials) ||
          !Number.isFinite(record.tris) ||
          record.tris < 1
        )
          throw new Error('Invalid model.');
      } catch {
        return Response.json({ error: 'Choose a valid imported prop.' }, { status: 400 });
      }
      // Reserve a number before hashing the record. Concurrent tabs cannot issue the same id, and an
      // interrupted import spends its number rather than letting a later model inherit a placement.
      const model = await new Promise<number | undefined>((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite'),
          store = tx.objectStore('projects');
        const read = store.get(projectId);
        let model: number | undefined;
        read.onsuccess = () => {
          const row = read.result as LocalProject | undefined;
          if (!row) return;
          model = Math.max(row.nextPropId ?? 0, ...bundleProps(row.bundle).models.map(model => model.id + 1));
          row.nextPropId = model + 1;
          store.put(row);
        };
        tx.oncomplete = () => resolve(model);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Browser storage is full or unavailable.'));
      });
      if (model === undefined) return Response.json({ error: 'This local mountain was deleted.' }, { status: 404 });
      const { defaults: rawDefaults, ...rest } = record;
      const defaults = sanitizePropBehaviour(rawDefaults);
      const imported = { ...rest, ...(defaults ? { defaults } : {}), id: model };
      const bytes = new TextEncoder().encode(JSON.stringify(imported));
      const hash = await sha256(bytes);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const blob = btoa(binary);
      const stem =
        (url.searchParams.get('name') ?? '')
          .replace(/\.(glb|gltf|json)$/i, '')
          .replace(/[^a-z0-9_-]/gi, '')
          .slice(0, 80) || 'prop';
      const saved = await new Promise<LocalProject | undefined>((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite'),
          store = tx.objectStore('projects');
        const read = store.get(projectId);
        let saved: LocalProject | undefined;
        read.onsuccess = () => {
          const row = read.result as LocalProject | undefined;
          if (!row) return;
          const used = new Set(
            row.bundle.assets.filter(asset => asset.kind === 'prop').map(asset => asset.name.toLowerCase()),
          );
          let name = `${stem}.json`,
            suffix = 1;
          while (used.has(name.toLowerCase())) name = `${stem}_${++suffix}.json`;
          row.bundle.assets.push({ kind: 'prop', name, model, hash, size: bytes.length });
          (row.bundle.blobs ??= {})[hash] = blob;
          store.put(row);
          saved = row;
        };
        tx.oncomplete = () => resolve(saved);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Browser storage is full or unavailable.'));
      });
      if (!saved) return Response.json({ error: 'This local mountain was deleted.' }, { status: 404 });
      projects.set(projectId, saved);
      if (active?.project.id === projectId) active = saved;
      void queueMountainFolderSave(projectId, saved.bundle).catch(console.error);
      return Response.json({ id: model, name: imported.name });
    }
    if (path === '/api/texture-upload' && method === 'POST') {
      const id = active?.project.id;
      if (!id || (url.searchParams.get('project') && url.searchParams.get('project') !== id))
        return Response.json({ error: 'Open a local mountain before adding textures.' }, { status: 404 });
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      if (
        bytes.length > 32 * 1024 ** 2 ||
        bytes.length < 24 ||
        [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value)
      )
        return Response.json({ error: 'Choose a PNG image smaller than 32 MB.' }, { status: 400 });
      const hash = await sha256(bytes);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const blob = btoa(binary);
      const stem =
        (url.searchParams.get('name') ?? '')
          .replace(/\.png$/i, '')
          .replace(/[^a-z0-9_-]/gi, '')
          .slice(0, 80) || 'texture';
      const saved = await new Promise<{ row: LocalProject; name: string } | undefined>((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite');
        const store = tx.objectStore('projects');
        const read = store.get(id);
        let saved: { row: LocalProject; name: string } | undefined;
        read.onsuccess = () => {
          const current = read.result as LocalProject | undefined;
          if (!current) return;
          const row = structuredClone(current);
          const used = new Set(
            row.bundle.assets.filter(asset => asset.kind === 'texture').map(asset => asset.name.toLowerCase()),
          );
          let name = `${stem}.png`,
            suffix = 1;
          while (used.has(name.toLowerCase())) name = `${stem}_${++suffix}.png`;
          row.bundle.assets.push({ kind: 'texture', name, hash, size: bytes.length });
          (row.bundle.blobs ??= {})[hash] = blob;
          store.put(row);
          saved = { row, name };
        };
        tx.oncomplete = () => resolve(saved);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Browser storage is full or unavailable.'));
      });
      if (!saved) return Response.json({ error: 'This local mountain was deleted.' }, { status: 404 });
      projects.set(id, saved.row);
      if (active?.project.id === id) active = saved.row;
      void queueMountainFolderSave(id, saved.row.bundle).catch(console.error);
      return Response.json({ name: saved.name });
    }
    if (!path.startsWith('/api/projects')) return null;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as {
          document?: EditDoc;
          bundle?: ProjectBundle;
          name?: string;
          baseRevision?: number;
        })
      : {};
    if (path === '/api/projects/current')
      return active ? Response.json(await activateSaved(active)) : new Response(null, { status: 204 });
    if (path === '/api/projects') {
      if (method === 'GET') return Response.json({ projects: [...projects.values()].map(row => row.project) });
      if (method === 'POST') return Response.json(await create(migrateMountain(body.document ?? blankMountain())));
    }
    if (path === '/api/projects/transfer' && method === 'POST' && body.bundle) {
      const document = migrateMountain(body.bundle.document);
      document.name = body.name || document.name;
      return Response.json({ ...(await create(document, body.bundle)), stored: [], absent: body.bundle.missing ?? [] });
    }
    const [, id, operation] = /^\/api\/projects\/([^/]+)(?:\/([^/]+))?$/.exec(path) ?? [];
    const row = projects.get(id);
    if (!row) return Response.json({ error: 'Local mountain not found.' }, { status: 404 });
    if (operation === 'activate' && method === 'POST') return Response.json(await activateSaved(row));
    if (operation === 'document' && method === 'PUT' && body.document) {
      const document = migrateMountain(body.document);
      // Another tab may have deleted or saved this map since this workspace opened. Check and write
      // together, so a still-open editor cannot recreate a map deleted from the catalogue.
      const result = await new Promise<{ row?: LocalProject; status: number }>((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite');
        const store = tx.objectStore('projects');
        const read = store.get(id);
        let result: { row?: LocalProject; status: number } = { status: 404 };
        read.onsuccess = () => {
          const current = read.result as LocalProject | undefined;
          if (!current) return;
          if (body.baseRevision !== current.project.revision) {
            result = { row: current, status: 409 };
            return;
          }
          const next = structuredClone(current);
          next.project = {
            ...current.project,
            name: document.name,
            revision: current.project.revision + 1,
            updatedAt: new Date().toISOString(),
          };
          next.bundle = {
            ...next.bundle,
            ...(next.isoAliases ? { isoAliases: next.isoAliases } : {}),
            document,
            name: document.name,
            revision: next.project.revision,
            takenAt: next.project.updatedAt,
          };
          store.put(next);
          result = { row: next, status: 200 };
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      const next = result.row;
      if (!next) return Response.json({ error: 'This local mountain was deleted.' }, { status: 404 });
      projects.set(id, next);
      if (active?.project.id === id) active = next;
      if (result.status === 200) void queueMountainFolderSave(id, next.bundle).catch(console.error);
      return Response.json(snapshot(next), { status: result.status });
    }
    if (operation === 'download' && method === 'GET') return Response.json(row.bundle);
    if (operation === 'duplicate' && method === 'POST') {
      const document = structuredClone(row.bundle.document);
      document.name = url.searchParams.get('name') || `${document.name}_copy`;
      return Response.json({
        ...(await create(document, row.bundle, undefined, row.isoAliases)),
        stored: [],
        absent: row.bundle.missing ?? [],
      });
    }
    if (!operation && method === 'DELETE') {
      await remove(id);
      return Response.json({ deleted: { id, name: row.project.name } });
    }
    if (operation === 'checkpoints' && method === 'POST') return Response.json({ checkpoint: null });
    if (operation === 'checkpoints' && method === 'GET')
      return Response.json({ checkpoints: [], budget: { bytes: 0, limit: 0 } });
    return Response.json({ error: 'This operation requires a server workspace.' }, { status: 403 });
  }
  function openNamed(name: string): boolean {
    const row = [...projects.values()].find(row => row.project.name.toLowerCase() === name.toLowerCase());
    if (!row) return false;
    activate(row);
    return true;
  }
  function open(id: string): boolean {
    const row = projects.get(id);
    if (!row) return false;
    activate(row);
    return true;
  }
  async function restore(bundle: ProjectBundle, select = true) {
    const document = migrateMountain(bundle.document);
    const names = new Set([...projects.values()].map(row => row.project.name.toLowerCase()));
    const base = document.name;
    let number = 1;
    while (names.has(document.name.toLowerCase())) {
      const suffix = `_${++number}`;
      document.name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }
    return create(document, bundle, undefined, undefined, select);
  }

  /** Disk updates replace the same local identity. Unsaved browser changes get their own recovery map. */
  async function refreshFolder(id: string, ask = false): Promise<void> {
    const row = projects.get(id);
    if (!row) throw new Error('This local mountain is no longer saved on this device.');
    const source = await readLinkedMountainFolder(id, row.bundle, ask);
    if (!source) return;
    let backup: string | undefined;
    if (source.browserChanged) {
      const bundle = structuredClone(row.bundle);
      bundle.document.name = `${bundle.document.name.slice(0, 47)}_browser_recovery`;
      backup = (await restore(bundle, false)).project.name;
    }
    const document = migrateMountain(source.bundle.document);
    const next: LocalProject = {
      ...row,
      project: {
        ...row.project,
        name: document.name,
        revision: row.project.revision + 1,
        updatedAt: new Date().toISOString(),
      },
      bundle: { ...structuredClone(source.bundle), document },
      isoAliases: source.bundle.isoAliases,
    };
    next.bundle.revision = next.project.revision;
    next.bundle.name = document.name;
    // A second editor may have saved while the folder was being read. Preserve its revision too.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const read = store.get(id);
      let conflict = false;
      read.onsuccess = () => {
        if ((read.result as LocalProject | undefined)?.project.revision !== row.project.revision) {
          conflict = true;
          tx.abort();
        } else store.put(next);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          conflict ? new Error('This map changed in another editor. Open it again to load the latest copy.') : tx.error,
        );
    });
    projects.set(id, next);
    if (active?.project.id === id) active = next;
    try {
      localStorage.setItem(`slopesmith.localRecovery:${id}`, JSON.stringify(document));
    } catch {
      /* the complete copy is already stored in IndexedDB */
    }
    await acceptMountainFolderSnapshot(id, next.bundle, source.hash, backup);
  }

  async function activateSaved(row: LocalProject) {
    // Unavailable folders leave the recovery copy usable, with folder autosave visibly paused.
    await refreshFolder(row.project.id).catch(() => {});
    const current = projects.get(row.project.id)!;
    void queueMountainFolderSave(current.project.id, current.bundle).catch(console.error);
    return activate(current);
  }
  return {
    request,
    seed,
    open,
    openNamed,
    createNew,
    copyPublic,
    remove,
    restore,
    refreshFolder,
    list: () => [...projects.values()].map(row => row.project).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    activeProject: () => active?.project,
    current: () => active?.bundle,
    bundle: (id: string) => projects.get(id)?.bundle,
    isoAliases: () => active?.isoAliases ?? {},
    close: () => db.close(),
  };
}

/** The catalogue reads browser projects independently of authentication and closes its database connection. */
export async function listLocalProjects(): Promise<ClientProject[]> {
  const projects = await openLocalProjects();
  try {
    return projects.list();
  } finally {
    projects.close();
  }
}

/** Solo playback reads a snapshot without activating a workspace or starting autosave. */
export async function readLocalProject(id: string): Promise<ProjectBundle | null> {
  const projects = await openLocalProjects();
  try {
    if (projects.bundle(id)) await projects.refreshFolder(id);
    return structuredClone(projects.bundle(id) ?? null);
  } finally {
    projects.close();
  }
}

/** Delete directly from browser storage, regardless of whether the visitor is signed in. */
export async function deleteLocalProject(id: string): Promise<void> {
  const projects = await openLocalProjects();
  try {
    await projects.remove(id);
  } finally {
    projects.close();
  }
}
