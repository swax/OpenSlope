import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ownerIdentity } from '../src/server/accounts/guard';
import type { ApiRequest } from '../src/server/app';
import { workspaceRoutes } from '../src/server/api/workspace';
import { defaultMountain } from '../src/core/doc/mountain';
import { collisionLabMountain } from '../src/core/collision/lab';
import { IMPORTED_PROP_LEVEL } from '../src/core/props/imported';
import {
  ProjectConflictError, checkpointNow, checkpointPolicy, configureCheckpoints, createProject, currentProject,
  listCheckpoints, listProjects, openProject, planRetention, readCheckpoint, restoreCheckpoint, saveProject,
  type ProjectCheckpoint,
} from '../src/server/projects';
import { assign, closeRoom, configureRooms, forgetRooms, joinRoom, takeSnapshot } from '../src/server/session/room';
import { globalRegister, quadRegister, readRegister, vertexRegister } from '../src/core/doc/registers';
import { canonicalJson } from '../src/core/doc/canonical';
import { encodePng } from '../src/server/routes/png';
import type { EditDoc } from '../src/core/doc/doc-edit';
import { setQuadsLocked } from '../src/core/mesh/locks';
import { ensureWorkspace, forgetWorkspaceConfig, workspaceConfig } from '../src/server/workspace-config';
import { migrateLegacyProjectAssets, withProjectAssets } from '../src/server/project-assets';
import { duplicateProject, downloadProject } from '../src/server/project-transfer';
import { readCharacterModelBytes, characterLibraryDir } from '../src/server/routes/characters';
import { listImportedProps, saveImportedProp } from '../src/server/routes/imported-props';
import { readTextureBytes, saveCustomTexture } from '../src/server/routes/textures';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-projects-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
// Static imports are evaluated before these assignments, so drop anything the resolved config already memoised.
forgetWorkspaceConfig();

/** Call a project route the way app.ts does: the `/api/projects` mount is stripped, so the handler is handed
 *  the remainder of the path, and the principal the guard established is hung on the request. This is the
 *  route table itself under test, not the store beneath it. */
async function callProjects(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = {};
  (req as ApiRequest).identity = ownerIdentity();
  let status = 0;
  let text = '';
  const res = {
    statusCode: 200,
    setHeader() { /* the fake response keeps only what the assertions read */ },
    end(chunk?: string) { status = res.statusCode; text = chunk ?? ''; },
  };
  await workspaceRoutes['/api/projects'](req, res as unknown as ServerResponse);
  return { status, json: text ? JSON.parse(text) : null };
}

try {
  const config = workspaceConfig();
  check(config.workspaceRoot === root, 'environment override selects an isolated workspace');
  await ensureWorkspace();
  check(existsSync(join(root, 'projects')) && existsSync(join(root, 'library')), 'workspace layout is created');

  const doc = defaultMountain();
  doc.name = 'Storage Test';
  const created = await createProject(doc);
  check(created.project.revision === 1, 'new project begins at revision 1');
  // A map is one of the things names never overwrite (docs/038), so creation goes through the same free-name
  // helper the texture, sound and prop libraries use — and lands under the name that helper gives it.
  check(created.project.name === 'StorageTest' && created.document.name === created.project.name,
    'a new project takes its map name from the shared library alphabet, in the document as well as the manifest');
  check(existsSync(join(created.project.folder, 'project.json')), 'project manifest is written');
  check(existsSync(join(created.project.folder, 'mountain.slope.json')), 'editable mountain is written');
  check(existsSync(join(created.project.folder, 'assets', 'skies')), 'project-owned asset folders are created');
  check((await currentProject())?.project.id === created.project.id, 'new project becomes the active session project');

  // A map's name lives in the document, so a rename IS a save — and it goes through the free-name helper the
  // same way creating one does, landing in the shared library alphabet rather than as whatever was typed.
  const edited = structuredClone(doc);
  edited.name = 'Storage Test Renamed';
  const lockedQuad = 4;
  setQuadsLocked(edited, [lockedQuad], true);
  const renamed = 'StorageTestRenamed';
  const saved = await saveProject(created.project.id, 1, edited);
  check(saved.project.revision === 2 && saved.project.name === renamed, 'save advances revision and metadata');
  const storedMountain = JSON.parse(readFileSync(join(created.project.folder, 'mountain.slope.json'), 'utf8')) as {
    name: string; quadLocked?: Record<string, true>;
  };
  check(storedMountain.name === renamed,
    'atomic document replacement persists the edit, under the name the map landed on');
  check(storedMountain.quadLocked?.[edited.quadIds[lockedQuad]] === true,
    'a patch lock is written to disk under the patch stable id');
  check(existsSync(join(created.project.folder, 'autosaves')),
    'the project owns a checkpoint ring');

  // ---- a rename is a save, and names never overwrite (docs/038) ----
  //
  // A map's name comes from its document and the Info panel binds it, so renaming one IS an ordinary save. It
  // goes through the same free-name helper creating a map goes through: onto a name another map holds it lands
  // beside it, the name it moved off is retired, and a name differing only in case is the name it already has.
  const one = await createProject({ ...defaultMountain(), name: 'ONE' });
  const two = await createProject({ ...defaultMountain(), name: 'TWO' });
  const collided = await saveProject(two.project.id, two.project.revision, { ...two.document, name: 'ONE' });
  check(collided.project.name === 'ONE_2' && collided.document.name === 'ONE_2',
    'renaming a map onto a name another map holds lands beside it, in the document as well as the manifest');
  check((await openProject(one.project.id)).project.name === 'ONE', 'and never over it');
  const recased = await saveProject(two.project.id, collided.project.revision,
    { ...collided.document, name: 'one_2' });
  check(recased.project.name === 'one_2',
    'a rename that changes nothing but a name’s case is the name the map already has, not a suffixed variant');
  check((await createProject({ ...defaultMountain(), name: 'TWO' })).project.name === 'TWO_2',
    'the name a rename moved off is retired, so the next map asking for it lands beside it');

  let conflict = false;
  try { await saveProject(created.project.id, 1, doc); }
  catch (error) { conflict = error instanceof ProjectConflictError && error.snapshot.project.revision === 2; }
  check(conflict, 'stale base revisions are rejected with the current snapshot');
  const reopened = await openProject(created.project.id);
  check(reopened.document.name === renamed, 'project reopens from disk');
  check(reopened.document.quadLocked?.[lockedQuad] === true,
    'a patch lock is restored by a fresh project open');
  check((await listProjects()).some(project => project.id === created.project.id), 'project appears in the workspace catalogue');

  // ---- authored assets belong to one mountain -------------------------------------------------------
  const pixel = (r: number, g: number, b: number) => encodePng({ w: 1, h: 1,
    data: new Uint8Array([r, g, b, 255]) });
  const assetOne = await createProject({ ...defaultMountain(), name: 'Asset One' });
  const assetTwo = await createProject({ ...defaultMountain(), name: 'Asset Two' });
  await withProjectAssets(assetOne, () => saveCustomTexture('same-name', pixel(240, 10, 10)));
  await withProjectAssets(assetTwo, () => saveCustomTexture('same-name', pixel(10, 20, 240)));
  const firstBytes = await withProjectAssets(assetOne,
    () => readTextureBytes('Custom', 'same-name.png'));
  const secondBytes = await withProjectAssets(assetTwo,
    () => readTextureBytes('Custom', 'same-name.png'));
  check(!firstBytes.equals(secondBytes)
    && existsSync(join(assetOne.project.folder, 'assets', 'textures', 'same-name.png'))
    && existsSync(join(assetTwo.project.folder, 'assets', 'textures', 'same-name.png')),
  'equal authored names resolve to different bytes inside their respective mountain asset folders');
  check(!existsSync(join(root, 'Custom', 'Textures', 'same-name.png')),
    'new authored textures never write into the legacy Maps/Custom folder');

  const portableProp = await withProjectAssets(assetOne, () => saveImportedProp('portable cookie', {
    name: 'portable cookie', tris: 0, subs: [], materials: [],
  }));
  await saveProject(assetOne.project.id, assetOne.project.revision, {
    ...assetOne.document,
    props: [{ level: IMPORTED_PROP_LEVEL, model: portableProp.record.id, name: portableProp.record.name,
      pos: [0, 0, 0], yaw: 0, scale: 1 }],
  });
  // Reproduce the dangerous condition from a server upgraded out of Maps/Custom: a different global prop
  // happens to have the same model number as this mountain's local record.
  const legacyPropsDir = join(root, 'Custom', 'Props');
  mkdirSync(legacyPropsDir, { recursive: true });
  writeFileSync(join(legacyPropsDir, 'wrong-global-prop.json'), JSON.stringify({
    id: portableProp.record.id, name: 'wrong global prop', tris: 0, subs: [], materials: [],
  }));

  const portableBundle = await downloadProject(assetOne.project.id, true);
  check(portableBundle.assets.some(asset => asset.kind === 'texture' && asset.name === 'same-name.png')
    && portableBundle.blobs?.[portableBundle.assets.find(asset => asset.name === 'same-name.png')!.hash] !== undefined,
  'portable export includes an unused file from the mountain local library');
  check(portableBundle.assets.filter(asset => asset.kind === 'prop').length === 1,
    'legacy migration does not copy a global prop over a model id already owned by the mountain');
  const copied = await duplicateProject(assetOne.project.id, undefined, 'ASSET_ONE_COPY');
  const copiedBytes = await withProjectAssets(copied.snapshot,
    () => readTextureBytes('Custom', 'same-name.png'));
  check(copiedBytes.equals(firstBytes) && copied.snapshot.project.name === 'ASSET_ONE_COPY'
    && copied.snapshot.project.folder !== assetOne.project.folder,
  'duplicating a mountain copies its local library into a distinct project-owned folder');
  // An imported mountain is native project-owned storage from birth. Even if its first asset request runs
  // legacy migration explicitly, the sealed marker must keep the unrelated global id out of its catalogue.
  await migrateLegacyProjectAssets(copied.snapshot);
  const copiedProps = await withProjectAssets(copied.snapshot, () => listImportedProps());
  check(copiedProps.length === 1 && copiedProps[0]?.record.name === portableProp.record.name
    && existsSync(join(copied.snapshot.project.folder, 'assets', '.legacy-library-migrated-v1.json')),
  'portable import stays sealed from legacy props whose ids collide with its freshly assigned ids');

  // A dependency used only by a retained checkpoint is still needed when that checkpoint is downloaded.
  const legacyDir = join(root, 'Custom', 'Textures');
  mkdirSync(legacyDir, { recursive: true });
  const legacyDoc = { ...defaultMountain(), name: 'Legacy Assets', quadTex: { 0: 'Custom/later.png' } };
  const legacy = await createProject(legacyDoc);
  await saveProject(legacy.project.id, legacy.project.revision,
    { ...legacy.document, quadTex: {} });
  await migrateLegacyProjectAssets(await openProject(legacy.project.id));
  check(!existsSync(join(legacy.project.folder, 'assets', 'textures', 'later.png')),
    'a missing legacy dependency is recorded without manufacturing a file');
  const laterBytes = pixel(30, 180, 80);
  writeFileSync(join(legacyDir, 'later.png'), laterBytes);
  await migrateLegacyProjectAssets(await openProject(legacy.project.id));
  check(readFileSync(join(legacy.project.folder, 'assets', 'textures', 'later.png')).equals(laterBytes),
    'legacy migration retries missing checkpoint dependencies and copies a restored file locally');

  const legacyCharacters = join(root, 'Custom', 'Characters');
  mkdirSync(legacyCharacters, { recursive: true });
  const avatarBytes = Buffer.from('legacy-avatar');
  writeFileSync(join(legacyCharacters, 'Rider.glb'), avatarBytes);
  const avatarDir = await characterLibraryDir();
  check(avatarDir === join(root, 'library', 'characters')
    && (await readCharacterModelBytes('Rider.glb')).equals(avatarBytes),
  'legacy avatars migrate once into the server-wide workspace character library');

  // ---- history: cadence, compression, thinning and the things done with a checkpoint (docs/040) ----
  const defaults = { ...checkpointPolicy };
  const ring = join(created.project.folder, 'autosaves');
  const ringFiles = () => readdirSync(ring).filter(name => name.startsWith('r0'));

  // Cadence is a timer with accumulated change, not one checkpoint per save: a project whose ring is empty
  // takes its baseline on the first save, and the saves inside the interval that follows take nothing.
  check(ringFiles().length === 1, 'the first save of an empty ring sets the document it began with aside');
  let revision = saved.project.revision;
  for (const name of ['Third Draft', 'Fourth Draft', 'Fifth Draft']) {
    revision = (await saveProject(created.project.id, revision, { ...edited, name })).project.revision;
  }
  check(ringFiles().length === 1, 'saves inside the checkpoint interval add nothing to the ring');
  const baseline = (await listCheckpoints(created.project.id)).checkpoints[0];
  check(baseline.revision === 1 && baseline.reason === 'timer' && !baseline.pinned
    && baseline.bytes > 0 && !Number.isNaN(Date.parse(baseline.takenAt)) && baseline.members.length === 0,
    'a checkpoint carries the revision it holds, when it was taken, what it costs and who contributed to it');
  check((await readCheckpoint(created.project.id, baseline.file)).document.name === created.document.name,
    'a checkpoint reads back as the whole document it set aside');
  let refused = false;
  try { await readCheckpoint(created.project.id, '../mountain.slope.json'); } catch { refused = true; }
  check(refused, 'a name outside the ring’s own naming is not a checkpoint');

  // Compression: a checkpoint is the document's own bytes gzipped, and comes back as those exact bytes.
  const live = readFileSync(join(created.project.folder, 'mountain.slope.json'));
  const compressed = await checkpointNow(created.project.id, { reason: 'named', note: 'compression', by: 'storage test' });
  check(compressed?.file.endsWith('.slope.json.gz') ?? false, 'a checkpoint is written compressed');
  check(gunzipSync(readFileSync(join(ring, compressed!.file))).equals(live),
    'a checkpoint gunzips back to the document byte for byte');
  const labBytes = Buffer.from(JSON.stringify(collisionLabMountain('COLLISION_LAB'), null, 2) + '\n');
  const labPacked = gzipSync(labBytes);
  console.log(`     COLLISION_LAB: ${labBytes.length} bytes → ${labPacked.length} gzipped `
    + `(${(labBytes.length / labPacked.length).toFixed(1)}:1)`);
  check(labBytes.length / labPacked.length > 4, 'a real project document compresses several times over');

  // A checkpoint stored plain is still a checkpoint: the ring reads whichever shape it finds.
  const plain = `r000009-${new Date().toISOString().replace(/[:.]/g, '-')}-timer.slope.json`;
  writeFileSync(join(ring, plain), JSON.stringify({ ...edited, name: 'Plain On Disk' }, null, 2));
  check((await readCheckpoint(created.project.id, plain)).document.name === 'Plain On Disk',
    'a checkpoint stored uncompressed reads exactly like a compressed one');
  check((await listCheckpoints(created.project.id)).checkpoints.some(entry => entry.file === plain),
    'both stored shapes stand in one listing');

  // Restoring is forward-only, and the document it replaces is pinned rather than left to the schedule.
  const before = await openProject(created.project.id);
  const restored = await restoreCheckpoint(created.project.id, before.project.revision, baseline.file);
  check(restored.project.revision === before.project.revision + 1 && restored.project.revision > baseline.revision
    && !restored.unchanged,
    'restoring writes a NEW revision instead of rewinding the counter');
  check(JSON.stringify(restored.document) === JSON.stringify((await readCheckpoint(created.project.id, baseline.file)).document),
    'the new revision holds the checkpoint’s document');
  const preRestore = (await listCheckpoints(created.project.id)).checkpoints.find(entry => entry.reason === 'restore');
  check(preRestore?.pinned === true && preRestore.revision === before.project.revision
    && (await readCheckpoint(created.project.id, preRestore.file)).document.name === before.document.name,
    'the document a restore replaced is itself a checkpoint, and one thinning may never take');

  // Restoring what the project already holds writes nothing, and says so rather than reporting a restore.
  const noop = await restoreCheckpoint(created.project.id, restored.project.revision, baseline.file);
  check(noop.unchanged && noop.project.revision === restored.project.revision,
    'restoring a checkpoint identical to the live document writes no revision and reports it unchanged');
  check((await listCheckpoints(created.project.id)).checkpoints.filter(entry => entry.reason === 'restore').length === 1,
    'a restore that changes nothing sets nothing aside either');

  const undone = await restoreCheckpoint(created.project.id, restored.project.revision, preRestore!.file);
  check(undone.project.revision === restored.project.revision + 1 && undone.document.name === before.document.name,
    'restoring the pre-restore checkpoint puts the project back, forward again');

  const fork = await createProject((await readCheckpoint(created.project.id, baseline.file)).document);
  check(fork.project.id !== created.project.id && fork.project.revision === 1,
    'forking a checkpoint creates a project of its own at revision 1');
  await saveProject(fork.project.id, fork.project.revision, { ...fork.document, name: 'Fork Diverged' });
  const source = await openProject(created.project.id);
  check(source.project.revision === undone.project.revision && source.document.name === before.document.name,
    'editing the fork leaves the project it came from untouched');

  // The routes the History panel calls, over the route table itself.
  const path = `/${source.project.id}/checkpoints`;
  const listed = await callProjects('GET', path);
  check(listed.status === 200 && listed.json.checkpoints.length > 0
    && listed.json.budget.limit === checkpointPolicy.budgetBytes && listed.json.budget.bytes > 0,
    'GET /api/projects/:id/checkpoints answers the listing and what the ring costs');
  const bulk = await callProjects('POST', path, { reason: 'bulk', note: 'before regenerating the terrain' });
  check(bulk.status === 201 && bulk.json.checkpoint.reason === 'bulk' && !bulk.json.checkpoint.pinned,
    'POST /api/projects/:id/checkpoints sets the project aside as it stands');
  const held: string = bulk.json.checkpoint.file;
  const read = await callProjects('GET', `${path}/${encodeURIComponent(held)}`);
  check(read.status === 200 && read.json.document?.name === source.document.name,
    'GET /api/projects/:id/checkpoints/:file answers the whole document');
  const portable = await callProjects('GET', `${path}/${encodeURIComponent(held)}/download?assets=bytes`);
  check(portable.status === 200 && portable.json.kind === 'slopesmith-project'
    && portable.json.revision === bulk.json.checkpoint.revision
    && portable.json.takenAt === bulk.json.checkpoint.takenAt
    && portable.json.document?.name === source.document.name && portable.json.blobs !== undefined,
    'GET /api/projects/:id/checkpoints/:file/download answers the portable mountain bundle');
  const named = await callProjects('POST', `${path}/${encodeURIComponent(held)}/name`,
    { note: 'before I redid the finish area', by: 'somebody else entirely' });
  check(named.status === 200 && named.json.checkpoint.pinned === true
    && named.json.checkpoint.note === 'before I redid the finish area',
    'POST /api/projects/:id/checkpoints/:file/name keeps a checkpoint under the note that names it');
  check(named.json.checkpoint.namedBy === 'owner',
    'and credits it to the principal the request was made by, not to whoever the body claimed (docs/038)');
  const gone = await callProjects('GET', `${path}/${encodeURIComponent(held)}`);
  check(gone.status === 410,
    'a checkpoint a listing named and the ring no longer holds answers 410, not a missing file');
  const conflicted = await callProjects('POST', `${path}/${encodeURIComponent(plain)}/restore`, { baseRevision: 1 });
  check(conflicted.status === 409 && conflicted.json.project?.revision === source.project.revision,
    'a restore from a stale base revision is refused with the current snapshot');
  const forward = await callProjects('POST', `${path}/${encodeURIComponent(plain)}/restore`,
    { baseRevision: source.project.revision });
  check(forward.status === 200 && forward.json.project.revision === source.project.revision + 1
    && forward.json.document.name === 'PlainOnDisk' && forward.json.unchanged === false,
    'POST /api/projects/:id/checkpoints/:file/restore writes the checkpoint forward as the next revision');

  // ---- comparing against a checkpoint, and reverting part of the map back to one (docs/040) ----
  //
  // A revert is an ordinary write over the register room: the checkpoint's values, assigned to exactly the
  // registers named. Snapshots are pinned to the explicit flushes the route takes, so what lands on disk is a
  // consequence of the route rather than of a timer firing mid-assertion.
  configureRooms({ snapshotIdleMs: 50_000, snapshotChanges: 1_000_000 });
  const projectId = source.project.id;
  const room = await joinRoom(projectId);
  const marked = await callProjects('POST', path, { reason: 'bulk', note: 'the mark two people edit past' });
  const mark: string = marked.json.checkpoint.file;
  const wasThere = structuredClone(room.doc);

  // Two people's work, credited the way the room credits an assignment that lands over the channel.
  const bobsCorner = vertexRegister(room.doc.vertexIds[3]);
  const bobsFace = quadRegister(room.doc.quadIds[2], 'paint');
  const adasCorner = vertexRegister(room.doc.vertexIds[9]);
  assign(room, [[bobsCorner, [11, 11, 11]], [bobsFace, 6]], 'Bob');
  assign(room, [[adasCorner, [22, 22, 22]], [globalRegister('name'), 'Ada Renamed It']], 'Ada');

  const changes = await callProjects('GET', `${path}/${encodeURIComponent(mark)}/changes`);
  check(changes.status === 200 && changes.json.summary.vertices.moved === 2
    && changes.json.summary.quads.paint === 1 && changes.json.summary.globals.includes('name'),
    'GET /api/projects/:id/checkpoints/:file/changes says what changed since a checkpoint, off the registers');
  check(changes.json.described.some((phrase: string) => phrase.includes('2 corners moved'))
    && canonicalJson(changes.json.writers) === canonicalJson(['Ada', 'Bob']),
    'and says it in words, naming everybody the room credits a register to — who a revert may be aimed at');

  const beforeRevert = (await listCheckpoints(projectId)).checkpoints.length;
  const bobsRevert = await callProjects('POST', `${path}/${encodeURIComponent(mark)}/revert`, { by: 'Bob' });
  const afterBob = bobsRevert.json.document as EditDoc;
  check(bobsRevert.status === 200 && bobsRevert.json.reverted === 2,
    'POST /api/projects/:id/checkpoints/:file/revert puts back exactly the registers one person last wrote');
  check(canonicalJson(readRegister(afterBob, bobsCorner)) === canonicalJson(readRegister(wasThere, bobsCorner))
    && readRegister(afterBob, bobsFace) === readRegister(wasThere, bobsFace),
    'so the corner Bob moved and the face he painted hold what the checkpoint held');
  check(canonicalJson(readRegister(afterBob, adasCorner)) === canonicalJson([22, 22, 22])
    && readRegister(afterBob, globalRegister('name')) === 'AdaRenamedIt',
    'and every register Ada wrote in the same span is left standing — which whole-document restore could not do');
  check(bobsRevert.json.project.revision > source.project.revision,
    'a revert is forward-only like every other write: it lands as a new revision');

  const revertRing = await listCheckpoints(projectId);
  const preRevert = revertRing.checkpoints.find(entry => entry.reason === 'revert');
  check(revertRing.checkpoints.length === beforeRevert + 1 && preRevert?.pinned === true,
    'and is itself checkpointed, pinned, so a revert nobody wanted outlives the thinning schedule');
  check(canonicalJson(readRegister((await readCheckpoint(projectId, preRevert!.file)).document, bobsCorner))
    === canonicalJson([11, 11, 11]),
    'the checkpoint it left behind holding the document the revert replaced');

  // Reverting the revert: the pinned checkpoint, reverted whole, is how a bad revert is undone.
  const undoneRevert = await callProjects('POST',
    `${path}/${encodeURIComponent(preRevert!.file)}/revert`, {});
  check(undoneRevert.status === 200
    && canonicalJson(readRegister(undoneRevert.json.document as EditDoc, bobsCorner)) === canonicalJson([11, 11, 11]),
    'reverting the checkpoint a revert left behind puts the revert back — undone exactly as a bad restore is');
  const emptyRevert = await callProjects('POST',
    `${path}/${encodeURIComponent(preRevert!.file)}/revert`, {});
  check(emptyRevert.status === 200 && emptyRevert.json.reverted === 0 && emptyRevert.json.unchanged === true
    && emptyRevert.json.checkpoint === null,
    'a revert with nothing to put back writes no revision and sets nothing aside, and says so');

  // Bounded by a selection: the corners and faces named, and nothing beside them.
  const selectionMark = await callProjects('POST', path, { reason: 'bulk', note: 'before the selection edit' });
  const selectionFile: string = selectionMark.json.checkpoint.file;
  const nearby = vertexRegister(room.doc.vertexIds[30]), beyond = vertexRegister(room.doc.vertexIds[31]);
  assign(room, [[nearby, [3, 3, 3]], [beyond, [4, 4, 4]], [globalRegister('aiSeed'), 77]], 'Bob');
  const bounded = await callProjects('POST', `${path}/${encodeURIComponent(selectionFile)}/revert`,
    { by: 'Bob', vertices: [room.doc.vertexIds[30]] });
  const afterBounded = bounded.json.document as EditDoc;
  check(bounded.status === 200 && bounded.json.reverted === 1
    && canonicalJson(readRegister(afterBounded, nearby)) !== canonicalJson([3, 3, 3]),
    'a selection-bounded revert puts back only the geometry the selection names');
  check(canonicalJson(readRegister(afterBounded, beyond)) === canonicalJson([4, 4, 4])
    && readRegister(afterBounded, globalRegister('aiSeed')) === 77,
    'and leaves the corner beside it, and every global, exactly where they were');

  await closeRoom(projectId);
  forgetRooms();

  // A rename that travels as a register rather than as a document. The room asks for a name another map holds,
  // is stored under a free one and adopts it — a room that went on holding the name it asked for would ask for
  // it again on its next snapshot, and climb another suffix every time anybody edited.
  const twinRoom = await joinRoom(two.project.id);
  assign(twinRoom, [[globalRegister('name'), 'ONE']], 'Ada');
  await takeSnapshot(twinRoom);
  check(twinRoom.doc.name === 'ONE_2' && (await openProject(two.project.id)).project.name === 'ONE_2',
    'a room renamed onto a taken name is stored under a free one, and adopts the name it was stored under');
  assign(twinRoom, [[globalRegister('spacing'), 19]], 'Ada');
  await takeSnapshot(twinRoom);
  check((await openProject(two.project.id)).project.name === 'ONE_2',
    'so its next snapshot asks for the name it now has, rather than being suffixed again');
  await closeRoom(two.project.id);
  forgetRooms();

  // ---- the thinning schedule, driven with injected timestamps rather than an hour of waiting ----
  const MINUTES = 60_000, HOURS = 60 * MINUTES, DAYS = 24 * HOURS;
  const now = Date.parse('2026-07-24T12:00:00.000Z');
  let synthetic = 0;
  const aged = (age: number, reason: ProjectCheckpoint['reason'] = 'timer'): ProjectCheckpoint => {
    const takenAt = new Date(now - age).toISOString();
    return {
      file: `r${String(++synthetic).padStart(6, '0')}-${takenAt.replace(/[:.]/g, '-')}-${reason}.slope.json.gz`,
      revision: synthetic, takenAt, bytes: 1_000, reason, pinned: reason !== 'timer', members: [],
    };
  };
  const lastHour = [aged(1 * MINUTES), aged(20 * MINUTES), aged(59 * MINUTES)];
  const hourly = [aged(2 * HOURS + 30 * MINUTES), aged(5 * HOURS + 10 * MINUTES), aged(5 * HOURS + 50 * MINUTES)];
  const daily = [aged(30 * HOURS), aged(36 * HOURS), aged(40 * HOURS)];
  const weekly = Array.from({ length: 10 }, (_entry, week) => aged((8 + week * 7) * DAYS));
  const pinned = [aged(45 * DAYS, 'restore'), aged(60 * DAYS, 'named')];
  const plan = planRetention([...lastHour, ...hourly, ...daily, ...weekly, ...pinned], now);
  const kept = new Set(plan.keep.map(entry => entry.file));
  check(lastHour.every(entry => kept.has(entry.file)), 'every checkpoint from the last hour is kept');
  check(kept.has(hourly[0].file) && kept.has(hourly[1].file) && !kept.has(hourly[2].file),
    'the day behind that keeps one checkpoint an hour — the newest of each hour');
  check(kept.has(daily[0].file) && !kept.has(daily[1].file) && kept.has(daily[2].file),
    'the week behind that keeps one checkpoint a day');
  check(weekly.filter(entry => kept.has(entry.file)).length === checkpointPolicy.weeklyKeep
    && kept.has(weekly[0].file) && !kept.has(weekly[9].file),
    'older than a week keeps one a week, newest first, to a bounded count');
  check(pinned.every(entry => kept.has(entry.file)),
    'a named checkpoint and the one a restore left behind are kept at any age');
  check(plan.thinned.length === 4 && plan.overBudget.length === 0 && plan.bytes === plan.keep.length * 1_000,
    'the plan accounts for every checkpoint it drops and what the survivors cost');
  const tight = planRetention(plan.keep, now, { ...checkpointPolicy, budgetBytes: 4_000 });
  check(tight.overBudget.length > 0 && tight.keep.includes(plan.keep[0])
    && pinned.every(entry => tight.keep.includes(entry)),
    'the byte budget drops the oldest unnamed checkpoints, never a named one and never the newest');

  // ---- thinning on disk, and the budget behind it ----
  const beforeSweep = (await listCheckpoints(source.project.id)).checkpoints;
  const pinnedFiles = beforeSweep.filter(entry => entry.pinned).map(entry => entry.file);
  check(pinnedFiles.length > 1 && beforeSweep.some(entry => !entry.pinned),
    'the ring holds both kinds before the schedule is tightened onto it');
  configureCheckpoints({ everyMs: 0, hourlyMs: 0, dailyMs: 0, weeklyKeep: 1 });
  await checkpointNow(source.project.id, { reason: 'bulk', note: 'the pass that sweeps the ring' });
  const swept = (await listCheckpoints(source.project.id)).checkpoints;
  check(pinnedFiles.every(file => swept.some(entry => entry.file === file)),
    'every named and pre-restore checkpoint survives a schedule that reaches everything else');
  check(swept.filter(entry => !entry.pinned).length === 1,
    'a schedule that reaches everything else takes the unnamed checkpoints');
  check(swept.some(entry => entry.note === 'before I redid the finish area' && entry.namedBy === 'owner'),
    'a named checkpoint keeps its note and who named it through a pruning pass');

  configureCheckpoints({ ...defaults, budgetBytes: 1 });
  await checkpointNow(source.project.id, { reason: 'bulk', note: 'the one that blows the budget' });
  const squeezed = await listCheckpoints(source.project.id);
  check(squeezed.budget.dropped === 1 && !!squeezed.budget.droppedAt && squeezed.budget.limit === 1,
    'the byte budget says what it dropped rather than thinning further than the schedule, silently');
  check(squeezed.checkpoints.filter(entry => !entry.pinned).length === 1
    && pinnedFiles.every(file => squeezed.checkpoints.some(entry => entry.file === file)),
    'the budget drops the oldest unnamed checkpoints first and leaves the named ones alone');
  configureCheckpoints(defaults);
} finally {
  delete process.env.SLOPESMITH_WORKSPACE_ROOT;
  delete process.env.SLOPESMITH_MAPS_ROOT;
  rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
else console.log('PROJECT STORAGE PASS');
