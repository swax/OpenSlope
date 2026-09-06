import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { canonicalJson } from '../src/core/doc/canonical';
import { changeSummary } from '../src/core/doc/compare';
import { authoredPatches, authoredReferenceMesh } from '../src/app/reference/authored';
import {
  CheckpointGoneError, createProjectSync,
  type ClientProject, type ProjectConflict, type ProjectSaveState, type RevertRequest,
} from '../src/app/state/project-sync';
import { check, failures } from './check';

// project-sync is browser code, but its timer contract is deliberately the platform timer contract. A tiny
// window alias keeps this focused test free of a DOM implementation.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

let doc = defaultMountain();
doc.name = 'Recovered Browser Mountain';
let active: { project: ClientProject; document: typeof doc } | null = null;
let listedProjects: ClientProject[] | null = null;
let projects = 0;
let writes = 0;
let lastServerDocumentName = '';
const states: ProjectSaveState[] = [];
const conflicts: ProjectConflict[] = [];
/** Every document the host was handed to render because somebody else wrote it (docs/038). */
const followedDocuments: Array<typeof doc> = [];

// One checkpoint on the server's ring, as the History panel reads it.
const checkpointDocument = { ...defaultMountain(), name: 'Checkpoint Document' };
const CHECKPOINT = {
  file: 'r000003-2026-07-24T15-43-01-123Z-timer.slope.json.gz',
  revision: 3,
  takenAt: '2026-07-24T15:43:01.123Z',
  bytes: 4096,
  reason: 'timer' as const,
  pinned: false,
  members: [] as string[],
};
/** A checkpoint a listing carried and the ring has thinned since. */
const THINNED = 'r000002-2026-07-24T15-40-00-000Z-timer.slope.json.gz';
/** Every scope a revert was asked for, so what the panel sent can be read back. */
const reverts: RevertRequest[] = [];
/** Every checkpoint the client asked the server to take, so the request behind each one can be read back. */
const taken: Array<{ note?: string; reason?: string }> = [];

const project = (name: string, revision: number): ClientProject => ({
  id: `project-${++projects}`,
  name,
  revision,
  folder: `C:/workspace/projects/${name}`,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date().toISOString(),
  documentHash: `hash-${revision}`,
});

/** Another editor — in practice this same mountain in a second tab — saves the project out from under us. */
function externalSave(name: string): void {
  active = {
    project: { ...active!.project, name, revision: active!.project.revision + 1 },
    document: { ...structuredClone(active!.document), name },
  };
  lastServerDocumentName = name;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === '/api/projects/current') return new Response(null, { status: 204 });
  if (url === '/api/projects' && (!init?.method || init.method === 'GET')) {
    return Response.json({ projects: listedProjects ?? (active ? [active.project] : []) });
  }
  if (url === '/api/projects' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as { document: typeof doc };
    active = { project: project(body.document.name, 1), document: structuredClone(body.document) };
    lastServerDocumentName = body.document.name;
    return Response.json(active, { status: 201 });
  }
  if (/\/api\/projects\/[^/]+\/activate$/.test(url) && init?.method === 'POST' && active) {
    return Response.json(active);
  }
  if (/\/api\/projects\/[^/]+\/document$/.test(url) && init?.method === 'PUT' && active) {
    const body = JSON.parse(String(init.body)) as { baseRevision: number; document: typeof doc };
    if (body.baseRevision !== active.project.revision) return Response.json(active, { status: 409 });
    writes++;
    lastServerDocumentName = body.document.name;
    active = {
      project: { ...active.project, name: body.document.name, revision: active.project.revision + 1 },
      document: structuredClone(body.document),
    };
    return Response.json(active);
  }
  if (/^\/api\/projects\/[^/]+$/.test(url) && init?.method === 'DELETE' && active) {
    const deleted = { id: active.project.id, name: active.project.name };
    active = null;
    return Response.json({ deleted });
  }
  if (/\/api\/projects\/[^/]+\/checkpoints\/[^/]+\/restore$/.test(url) && init?.method === 'POST' && active) {
    const body = JSON.parse(String(init.body)) as { baseRevision: number };
    if (body.baseRevision !== active.project.revision) return Response.json(active, { status: 409 });
    // The project already holds exactly that document, so there is no revision to write.
    if (active.document.name === checkpointDocument.name) return Response.json({ ...active, unchanged: true });
    writes++;
    lastServerDocumentName = checkpointDocument.name;
    active = {
      project: { ...active.project, name: checkpointDocument.name, revision: active.project.revision + 1 },
      document: structuredClone(checkpointDocument),
    };
    return Response.json({ ...active, unchanged: false });
  }
  // What changed since a checkpoint (docs/040): counted off the register model, said in words, and naming
  // whoever the room credits a register to — who a scoped revert may be aimed at.
  if (/\/api\/projects\/[^/]+\/checkpoints\/[^/]+\/changes$/.test(url) && active) {
    return Response.json({
      checkpoint: CHECKPOINT,
      summary: changeSummary(migrateMountain(checkpointDocument), migrateMountain(active.document)),
      described: ['1 global differs'], writers: ['Ada L', 'Bob'],
    });
  }
  // A scoped revert: ordinary assignments on the server's side, an ordinary revision on this one.
  if (/\/api\/projects\/[^/]+\/checkpoints\/[^/]+\/revert$/.test(url) && init?.method === 'POST' && active) {
    reverts.push(JSON.parse(String(init.body)) as RevertRequest);
    writes++;
    lastServerDocumentName = checkpointDocument.name;
    active = {
      project: { ...active.project, name: checkpointDocument.name, revision: active.project.revision + 1 },
      document: structuredClone(checkpointDocument),
    };
    return Response.json({
      ...active, reverted: 3, unchanged: false, described: ['1 corner moved'],
      checkpoint: { ...CHECKPOINT, reason: 'revert', pinned: true },
    });
  }
  if (/\/api\/projects\/[^/]+\/checkpoints\/[^/]+\/name$/.test(url) && init?.method === 'POST' && active) {
    const body = JSON.parse(String(init.body)) as { note: string };
    return Response.json({
      checkpoint: { ...CHECKPOINT, file: CHECKPOINT.file.replace('-timer', '-named'), reason: 'named', pinned: true, note: body.note },
    });
  }
  if (/\/api\/projects\/[^/]+\/checkpoints$/.test(url) && init?.method === 'POST' && active) {
    const body = JSON.parse(String(init.body)) as { note?: string; reason?: string };
    taken.push(body);
    return Response.json({
      checkpoint: {
        ...CHECKPOINT, file: `r000009-2026-07-24T16-00-00-000Z-${body.reason}.slope.json.gz`,
        reason: body.reason, pinned: body.reason === 'named', note: body.note,
      },
    }, { status: 201 });
  }
  if (/\/api\/projects\/[^/]+\/checkpoints$/.test(url) && active) {
    return Response.json({ checkpoints: [CHECKPOINT], budget: { bytes: CHECKPOINT.bytes, limit: 64 * 1024 * 1024 } });
  }
  if (/\/api\/projects\/[^/]+\/checkpoints\/[^/]+$/.test(url) && active) {
    if (url.endsWith(encodeURIComponent(THINNED))) {
      return Response.json({ error: `That checkpoint is no longer on disk: ${THINNED}` }, { status: 410 });
    }
    return Response.json({ checkpoint: CHECKPOINT, document: checkpointDocument });
  }
  if (/^\/api\/projects\/[^/]+$/.test(url) && active) return Response.json(active);
  throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
};

try {
  const sync = createProjectSync({
    getDoc: () => doc,
    onState: state => states.push(state),
    onConflict: conflict => conflicts.push(conflict),
    onFollow: document => followedDocuments.push(document as typeof doc),
  });
  const restored = await sync.initialize(doc);
  check(restored.name === doc.name && sync.current()?.revision === 1,
    'first run migrates browser recovery into a revisioned project');

  const projectCount = projects;
  const phoneRecovery = { ...defaultMountain(), name: 'Phone Recovery Copy' };
  const phone = createProjectSync({ getDoc: () => phoneRecovery });
  const openedOnPhone = await phone.initialize(phoneRecovery);
  check(projects === projectCount && phone.current()?.id === sync.current()?.id
    && openedOnPhone.name === restored.name,
  'a fresh device opens the only workspace project instead of creating a duplicate from its local recovery');

  listedProjects = [active!.project, { ...active!.project, id: 'project-already-on-server', name: 'Other Map' }];
  const tabletRecovery = { ...defaultMountain(), name: 'Tablet Recovery Copy' };
  const tablet = createProjectSync({ getDoc: () => tabletRecovery });
  const awaitingChoice = await tablet.initialize(tabletRecovery);
  check(awaitingChoice.name === tabletRecovery.name && tablet.current() === null && tablet.needsProjectChoice(),
    'a fresh device facing several projects waits for an explicit choice and creates none of them');
  listedProjects = null;

  doc.name = 'Autosaved Mountain';
  sync.schedule();
  await sync.flush();
  check(writes === 1 && sync.current()?.revision === 2 && lastServerDocumentName === doc.name,
    'dirty browser document flushes to the local project and advances its revision');

  sync.schedule();
  await sync.flush();
  check(writes === 1, 'an identical realized document does not write another revision');

  doc.name = 'Old Project Final Edit';
  sync.schedule();
  const next = defaultMountain(); next.name = 'Second Project';
  await sync.create(next);
  check(writes === 2 && sync.current()?.name === next.name && sync.current()?.revision === 1,
    'creating a project flushes the old browser replica before switching');
  check(states.includes('saving') && states.at(-1) === 'saved', 'save lifecycle reports saving and saved states');
  doc = next; // the host renders the document it handed to create()

  // ---- the three ways out of a refused save (docs/038) ----
  // Keep mine: the local document is written on top of the revision the project has reached.
  externalSave('Their First Edit');
  doc.name = 'Mine After Conflict';
  sync.schedule();
  await sync.flush();
  check(conflicts.length === 1 && sync.conflict()?.project.revision === active!.project.revision,
    'a refused save raises the conflict carrying the revision the project is now at');
  check(writes === 2, 'a refused save writes nothing');
  let before = writes;
  await sync.keepMine();
  check(!sync.conflict() && writes === before + 1 && lastServerDocumentName === doc.name,
    'keep mine rebases onto the server revision and writes the local document');
  doc.name = 'Kept Mine, Edited Again';
  sync.schedule();
  await sync.flush();
  check(writes === before + 2 && lastServerDocumentName === doc.name, 'autosave resumes after keeping mine');

  // Take theirs: the project as it stands on disk replaces the local document.
  externalSave('Their Second Edit');
  doc.name = 'Mine, Refused Again';
  sync.schedule();
  await sync.flush();
  check(conflicts.length === 2 && !!sync.conflict(), 'a second refused save raises its own conflict');
  before = writes;
  doc = await sync.takeTheirs(); // the host renders what it is handed and resets undo history
  check(!sync.conflict() && doc.name === 'Their Second Edit' && sync.current()?.revision === active!.project.revision,
    'take theirs adopts the project as it stands on disk');
  doc.name = 'Edited After Taking Theirs';
  sync.schedule();
  await sync.flush();
  check(writes === before + 1 && lastServerDocumentName === doc.name, 'autosave resumes after taking theirs');

  // Save mine as a new project: both documents survive and the editor follows the local one.
  externalSave('Their Third Edit');
  doc.name = 'Mine, Kept Separately';
  sync.schedule();
  await sync.flush();
  const conflicted = sync.current()?.id;
  check(conflicts.length === 3 && !!sync.conflict(), 'a third refused save raises its own conflict');
  before = writes;
  await sync.saveMineAsNewProject();
  check(!sync.conflict() && sync.current()?.id !== conflicted && sync.current()?.revision === 1
    && lastServerDocumentName === doc.name,
    'save mine as a new project keeps both documents and follows the local one');
  doc.name = 'Edited In The New Project';
  sync.schedule();
  await sync.flush();
  check(writes === before + 1 && lastServerDocumentName === doc.name, 'autosave resumes into the new project');

  // ---- history (docs/040) ----
  const listing = await sync.checkpoints();
  check(listing.checkpoints.length === 1 && listing.checkpoints[0].revision === CHECKPOINT.revision
    && listing.checkpoints[0].bytes === CHECKPOINT.bytes && listing.budget.limit > 0,
    'the client lists the project’s checkpoints with their revision and size, and what the ring costs');

  before = writes;
  const previewed = await sync.readCheckpoint(listing.checkpoints[0].file);
  await sync.beginPreview();
  doc = previewed;
  sync.schedule();
  await sync.flush();
  check(sync.isPreviewing() && writes === before, 'a checkpoint preview writes nothing to the project');
  doc = await sync.endPreview();
  check(!sync.isPreviewing() && doc.name === 'Edited In The New Project',
    'leaving a preview reopens the project as it stands on disk');

  // Named checkpoints: one taken of the project as it stands, and one applied to a checkpoint already on the ring.
  const note = 'before I redid the finish area';
  const marked = await sync.checkpointNow(note);
  check(marked?.note === note && marked?.pinned === true && taken.at(-1)?.reason === 'named',
    'naming a checkpoint sets the project aside as it stands, kept for good');
  await sync.checkpointNow('before regenerating the terrain', 'bulk');
  check(taken.at(-1)?.reason === 'bulk', 'a bulk destructive edit forces a checkpoint of its own');
  const renamed = await sync.nameCheckpoint(listing.checkpoints[0].file, 'keep this one');
  check(renamed.pinned && renamed.note === 'keep this one' && renamed.file !== listing.checkpoints[0].file,
    'naming a checkpoint already on the ring keeps it');

  // A listing goes stale under an open panel: the row is gone, which is a different repair from a failure.
  let stale = false;
  try { await sync.readCheckpoint(THINNED); }
  catch (error) { stale = error instanceof CheckpointGoneError; }
  check(stale, 'a checkpoint thinned since the listing was read is reported as gone rather than as an error');

  const beforeRestore = sync.current()!.revision;
  const rolledBack = await sync.restoreCheckpoint(listing.checkpoints[0].file);
  doc = rolledBack.document;
  check(!rolledBack.unchanged && doc.name === checkpointDocument.name
    && sync.current()?.revision === beforeRestore + 1,
    'restoring a checkpoint writes a NEW revision holding its document');
  const repeated = await sync.restoreCheckpoint(listing.checkpoints[0].file);
  check(repeated.unchanged && sync.current()?.revision === beforeRestore + 1,
    'restoring a checkpoint the project already holds reports it unchanged instead of writing a revision');

  // ---- comparing against a checkpoint, and reverting part of the map back to it (docs/040) ----
  //
  // Comparison reuses the authored-map reference layer rather than growing a viewer of its own: the checkpoint
  // becomes the same patch records an extracted level's `Patches.json` carries, so then-and-now sit in one
  // viewport with the placement controls that already exist.
  doc.name = 'Live While Comparing';
  const liveBefore = canonicalJson(doc);
  const compared = migrateMountain(structuredClone(checkpointDocument));
  const patches = authoredPatches(compared);
  const quilt = authoredReferenceMesh(compared);
  check(patches.length === compared.quadIds.length && patches.every(patch => patch.Points.length === 16),
    'a checkpoint tessellates into one reference patch per face, each carrying its sixteen control points');
  check(quilt.patchCount === compared.quadIds.length && quilt.positions.length > 0
    && patches.every(patch => patch.TexturePath === undefined),
    'and into the quilt the reference slot holds — geometry and surface type, with no level art to resolve');
  check(canonicalJson(doc) === liveBefore && writes === before + 1
    && canonicalJson(compared) === canonicalJson(migrateMountain(structuredClone(checkpointDocument))),
    'and nothing about the live project is touched: no write, no edit, and the checkpoint read back unchanged');

  const changes = await sync.checkpointChanges(listing.checkpoints[0].file);
  check(changes.described.length > 0 && changes.writers.includes('Bob')
    && typeof changes.summary.registers === 'number',
    'the client reads what changed since a checkpoint, and who the room credits registers to');

  before = writes;
  const beforeRevert = sync.current()!.revision;
  const outcome = await sync.revertCheckpoint(listing.checkpoints[0].file,
    { by: 'Bob', vertices: ['v1'], quads: ['q1'] });
  doc = outcome.document;
  check(canonicalJson(reverts.at(-1)) === canonicalJson({ by: 'Bob', vertices: ['v1'], quads: ['q1'] }),
    'a revert sends the scope and nothing else — whose work, and which corners and faces bound it');
  check(outcome.reverted === 3 && !outcome.unchanged && outcome.checkpoint?.reason === 'revert'
    && outcome.checkpoint.pinned && writes === before + 1
    && sync.current()?.revision === beforeRevert + 1 && states.at(-1) === 'saved',
    'and comes back as an ordinary revision, with the pinned checkpoint holding the document it replaced');

  // ---- following read-only (docs/039) ----
  // This tab may not change the map — a viewer, or a build that would evaluate this mountain differently —
  // so it stops writing and applies pushed revisions whole.
  before = writes;
  sync.setWritable(false, 'Following read-only: changing a map needs the editor role.');
  doc.name = 'Edited While Following';
  sync.schedule();
  await sync.flush();
  check(writes === before && sync.isWritable() === false && states.at(-1) === 'following'
    && /read-only/i.test(sync.readOnlyReason()),
    'a tab told it may not write stops autosave and puts itself into following');
  doc.name = 'Edited Again While Following';
  sync.schedule();
  await sync.flush();
  check(writes === before,
    'a follower writes nothing at all — there is no offline path, so nothing is queued for later either');

  // The writer's revision lands on the server, and the server pushes it here rather than answering a request.
  externalSave('Their Pushed Revision');
  const pushedProject = active!.project;
  const pushedDocument = active!.document;
  const applied = sync.applyPush({ project: pushedProject, document: pushedDocument as typeof doc });
  doc = applied!;
  check(applied?.name === 'Their Pushed Revision' && followedDocuments.at(-1)?.name === 'Their Pushed Revision'
    && sync.current()?.revision === pushedProject.revision,
    'a pushed revision is applied as a whole-document replace and handed to the host to render');
  check(sync.applyPush({ project: pushedProject, document: pushedDocument as typeof doc }) === null
    && sync.applyPush({ project: { ...pushedProject, id: 'another-project' }, document: pushedDocument as typeof doc })
      === null,
    'a push this replica already has, or one for another map, is ignored rather than applied backwards');

  // Writable again: autosave resumes from the document as it now stands, which is the pushed revision.
  sync.setWritable(true);
  check(sync.isWritable() && !sync.readOnlyReason(), 'being told it may write makes this tab writable again');
  doc.name = 'Mine Again';
  sync.schedule();
  await sync.flush();
  check(writes === before + 1 && lastServerDocumentName === 'Mine Again',
    'and autosave resumes on top of the revision that was pushed, never on the document it was following from');

  const deleting = sync.current()!;
  const deleted = await sync.deleteMountain(deleting.id);
  check(deleted.id === deleting.id && deleted.name === deleting.name && active === null,
    'deleting the open mountain returns its identity so the host can leave it for another project');
} finally {
  globalThis.fetch = originalFetch;
}

if (failures) process.exitCode = 1;
else console.log('PROJECT SYNC PASS');
