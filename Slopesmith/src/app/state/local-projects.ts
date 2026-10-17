import { migrateMountain, defaultMountain } from '../../core/doc/mountain';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { ProjectBundle } from '../../core/project/transfer';
import type { ClientProject } from './project-sync';
import { disconnectMountainFolder, queueMountainFolderSave } from './folder-autosave';

interface LocalProject {
  project: ClientProject;
  bundle: ProjectBundle;
  source?: string;
  sourceRevision?: number;
  isoAliases?: Record<string, string>;
}

/** Local projects have their own database and identities; a public source id is never a writable project. */
export async function openLocalProjects() {
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
    active = projects.get(sessionStorage.getItem('slopesmith.localProject') ?? '');
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
    void queueMountainFolderSave(row.project.id, row.bundle).catch(console.error);
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
  ) {
    const row = makeRow(document, bundle, source, isoAliases);
    await store(row);
    return activate(row);
  }
  async function createNew() {
    const document = defaultMountain();
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
      return active ? Response.json(snapshot(active)) : new Response(null, { status: 204 });
    if (path === '/api/projects') {
      if (method === 'GET') return Response.json({ projects: [...projects.values()].map(row => row.project) });
      if (method === 'POST') return Response.json(await create(migrateMountain(body.document ?? defaultMountain())));
    }
    if (path === '/api/projects/transfer' && method === 'POST' && body.bundle) {
      const document = migrateMountain(body.bundle.document);
      document.name = body.name || document.name;
      return Response.json({ ...(await create(document, body.bundle)), stored: [], absent: body.bundle.missing ?? [] });
    }
    const [, id, operation] = /^\/api\/projects\/([^/]+)(?:\/([^/]+))?$/.exec(path) ?? [];
    const row = projects.get(id);
    if (!row) return Response.json({ error: 'Local mountain not found.' }, { status: 404 });
    if (operation === 'activate' && method === 'POST') return Response.json(activate(row));
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
  async function restore(bundle: ProjectBundle) {
    const document = migrateMountain(bundle.document);
    const names = new Set([...projects.values()].map(row => row.project.name.toLowerCase()));
    const base = document.name;
    let number = 1;
    while (names.has(document.name.toLowerCase())) {
      const suffix = `_${++number}`;
      document.name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }
    return create(document, bundle);
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
    list: () => [...projects.values()].map(row => row.project).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    activeProject: () => active?.project,
    current: () => active?.bundle,
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

/** Delete directly from browser storage, regardless of whether the visitor is signed in. */
export async function deleteLocalProject(id: string): Promise<void> {
  const projects = await openLocalProjects();
  try {
    await projects.remove(id);
  } finally {
    projects.close();
  }
}
