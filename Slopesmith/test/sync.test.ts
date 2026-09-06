import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetAccounts } from '../src/server/accounts/store';
import { configureCheckpoints } from '../src/server/projects';
import { configureSessions, forgetSessions } from '../src/server/session/presence';
import { configureRooms, forgetRooms, roomFor } from '../src/server/session/room';
import { startApiService, type ApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import {
  createRegisterSync, COALESCE_MS, EDITING_MS, REPLAY_THRESHOLD_MS, type Reconciliation, type RegisterSync,
} from '../src/app/net/register-sync';
import { createAwareness, type AwarenessFrame, type AwarenessPublisher } from '../src/app/net/awareness';
import {
  createSessionChannel, type PeerAwareness, type RegisterAssignment, type SessionChannel,
} from '../src/app/net/session-channel';
import { collisionLabMountain } from '../src/core/collision/lab';
import { clearTex, getVertex, moveVertex, setSurf, setTex, setOrient, type EditDoc } from '../src/core/doc/doc-edit';
import { meshSmoothVertices, migrateMountain, defaultMountain } from '../src/core/doc/mountain';
import { digestDocument, textHash } from '../src/core/doc/digest';
import { quadRegister, readRegister, vertexRegister, writeRegister } from '../src/core/doc/registers';
import { reconcileTJunctionGeometry } from '../src/core/mesh/t-junctions';
import { meshAdjacency, meshFromDoc } from '../src/core/mesh/topology';
import { setQuadsLocked } from '../src/core/mesh/locks';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import { applyLoopCut, planLoopCut } from '../src/core/mesh/ops/loop-cut';
import { check, failures, recordFailure } from './check';

/**
 * Register sync end to end (docs/039), over real sockets.
 *
 * Two replicas of one mountain, each running the editor's own client — `createSessionChannel` for the
 * transport and `createRegisterSync` for the policy — against a real `startApiService`. Nothing is stubbed
 * between them but the editor's rendering: what is under test is the path a browser actually takes.
 *
 * The claims are the ones the model rests on. Two people editing different registers never collide. Two
 * editing the SAME register get last-writer-wins with a defined outcome, so no edit is ever refused for
 * having lost a race. The relative tools resolve into absolute values before anything is sent, and a drag's
 * intermediate positions never reach the wire at all. Topology, which cannot be last-writer-wins, takes a
 * compare-and-swap over the ids it consumes: one participant wins, the other reverts to the geometry that
 * won without passing back through its own. Drift is detected against a two-level hash and repaired by
 * refetching one chunk. Undo is inverse assignments, so it can put back a value somebody else has since
 * changed. And a reconnection past the threshold summarises what it held instead of replaying it blind.
 */

const root = mkdtempSync(join(tmpdir(), 'slopesmith-sync-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
forgetAccounts();
configureSessions({ presenceTtlMs: 120_000, sweepMs: 1_000 });
// Snapshots on a short leash, so durability is exercised rather than waited out.
configureRooms({ snapshotIdleMs: 40, snapshotChanges: 50 });
configureCheckpoints({ intervalMs: 60_000, changeBytes: 1 << 30 });

const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

async function until(test: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (test()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- one replica of the editor -----------------------------------------------------------------------------

/** What one client sent, in the shape it went out — the whole of what an assertion about "the wire" reads. */
interface Sent {
  kind: 'assign' | 'claim' | 'fetch';
  changes?: RegisterAssignment[];
  ids?: string[];
  sections?: string[];
  /** The frame's size in bytes, as the channel serialises it. What an assertion about cost reads. */
  bytes: number;
}

interface Client {
  name: string;
  doc: EditDoc;
  sync: RegisterSync;
  channel: SessionChannel;
  sent: Sent[];
  /** What this replica told the room it was doing, in the order it said it. */
  aware: AwarenessFrame[];
  /** What it heard everybody else was doing. */
  peers: PeerAwareness[];
  awareness: AwarenessPublisher;
  /** What this replica has picked by hand, as the editor's store would hold it. */
  picked: { vertices: string[]; quads: string[] };
  /** One pass of the editor's render funnel, which is where the T-node records are re-seated and the sync is
   *  told the document moved. Everything an edit costs is measured with this in the loop, because it is the
   *  pass that used to hand the document a fresh structural array and have every edit read as a topology one. */
  render(): void;
  /** Everything this replica was sent, exactly as it came off the wire — where an assertion about the shape
   *  of a message has to read it, since that is the only place JSON has had its say. */
  received: unknown[][];
  landed: { batch: number; retired: string[]; refused: string[] }[];
  claims: { batch: number; ok: boolean }[];
  diverged: string[];
  repairs: number;
  writable: boolean;
  close(): void;
}

let service: ApiService | null = null;
const opened: Client[] = [];

/** A frame's size on the wire, as the channel serialises it. */
const frameBytes = (message: unknown): number => JSON.stringify(message).length;

async function connect(name: string, projectId: string, document: EditDoc): Promise<Client> {
  const held = {
    name,
    doc: document,
    sent: [] as Sent[],
    received: [] as unknown[][],
    landed: [] as { batch: number; retired: string[]; refused: string[] }[],
    claims: [] as { batch: number; ok: boolean }[],
    diverged: [] as string[],
    repairs: 0,
    writable: false,
    aware: [] as AwarenessFrame[],
    peers: [] as PeerAwareness[],
    picked: { vertices: [] as string[], quads: [] as string[] },
  };
  let joined = false;
  const sync = createRegisterSync({
    getDoc: () => held.doc,
    setDoc: doc => { held.doc = doc; },
    channel: {
      assign: (changes, batch) => {
        held.sent.push({
          kind: 'assign', changes: structuredClone(changes),
          bytes: frameBytes({ t: 'assign', batch, changes }),
        });
        return channel.assign(changes, batch);
      },
      claim: (ids, doc, batch) => {
        held.sent.push({ kind: 'claim', ids: [...ids], bytes: frameBytes({ t: 'claim', ids, at: 0, document: doc, batch }) });
        return channel.claim(ids, doc, batch);
      },
      checkDrift: digest => channel.checkDrift(digest),
      fetchSections: sections => {
        held.sent.push({ kind: 'fetch', sections: [...sections], bytes: frameBytes({ t: 'fetch', sections }) });
        return channel.fetchSections(sections);
      },
    },
  });
  // Awareness as the editor publishes it: what this tab has picked, plus what its own assignments are naming
  // (main.ts). Driven by hand here rather than on its interval, so a frame count is a statement about what
  // changed rather than about how long a test took.
  const awareness = createAwareness({
    selection: () => ({ vertices: [...held.picked.vertices], quads: [...held.picked.quads] }),
    editing: () => sync.editing(),
    cursor: () => null, // no pointer over a canvas in a harness; the room is told so
    player: () => null, // this headless replica has no rendered camera/body
    send: frame => {
      const went = channel.aware(frame);
      if (went) held.aware.push(structuredClone(frame));
      return went;
    },
  });
  const channel = createSessionChannel({
    clientId: name,
    url: () => `ws://127.0.0.1:${service!.port}/api/session?client=${encodeURIComponent(name)}`,
    onJoined: view => { joined = true; held.writable = view.writable; if (view.writable) sync.connect(); },
    onSync: push => { held.received.push(...push.changes as unknown as unknown[][]); sync.applySync(push.changes, push.by); },
    onLanded: ack => { held.landed.push(ack); sync.landed(ack); },
    onClaim: result => { held.claims.push(result); sync.claimed(result); },
    onTopology: push => sync.applyTopology(migrateMountain(push.document)),
    onDigest: answer => { held.diverged.splice(0, held.diverged.length, ...sync.compareDigest(answer)); },
    onSections: repair => { held.repairs++; sync.repair(repair); },
    onCaughtUp: missed => sync.caughtUp(missed),
    onAware: peer => { held.peers.push(peer); },
  });
  channel.start();
  await until(() => channel.isOpen(), `${name} to connect`);
  channel.watch(projectId);
  await until(() => joined, `${name} to join the room`);
  sync.adopt(held.doc);
  // Getters rather than a spread: every field below is read after the fact, and a copy taken now would be a
  // copy of what the replica looked like before the test did anything to it.
  const client: Client = {
    name,
    get doc() { return held.doc; },
    set doc(value: EditDoc) { held.doc = value; },
    get sent() { return held.sent; },
    get received() { return held.received; },
    get landed() { return held.landed; },
    get claims() { return held.claims; },
    get diverged() { return held.diverged; },
    get repairs() { return held.repairs; },
    get writable() { return held.writable; },
    get aware() { return held.aware; },
    get peers() { return held.peers; },
    get picked() { return held.picked; },
    render: () => { reconcileTJunctionGeometry(held.doc); sync.noteEdit(); },
    awareness,
    sync, channel,
    close: () => { awareness.stop(); channel.close(); },
  };
  opened.push(client);
  return client;
}

/**
 * An editor that is running and has nothing to say.
 *
 * The funnel renders, the sync compares and awareness publishes, at the rate the editor does all three — which
 * is the state a replica spends most of its life in, and the one an assertion about cost has to be made
 * against. A replica with nothing outstanding sends nothing at all through this, however long it runs.
 */
async function idle(clients: readonly Client[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const client of clients) { client.render(); client.sync.flush(); client.awareness.publish(); }
    await wait(COALESCE_MS);
  }
}

/** The document as the service now holds it — what a fresh participant would load. */
async function serverDocument(projectId: string): Promise<EditDoc> {
  const res = await fetch(`http://127.0.0.1:${service!.port}/api/projects/${projectId}`);
  return (await res.json() as { document: EditDoc }).document;
}

/** The stored document, once it says what it is being asked about. The room writes its snapshots on a cadence
 *  rather than per change, so what the file holds catches up a moment after the replicas do. */
async function storedOnce(projectId: string, test: (doc: EditDoc) => boolean, what: string,
  ms = 5_000): Promise<EditDoc> {
  const deadline = Date.now() + ms;
  for (;;) {
    const doc = await serverDocument(projectId);
    if (test(doc)) return doc;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(40);
  }
}

try {
  service = await startApiService({ port: 0, host: '127.0.0.1' });

  // A real mountain, carrying creases so the tools that remove them have something to remove, and several
  // vertex chunks so a repair is one chunk rather than the whole mesh.
  const authored = collisionLabMountain('SYNC');
  const [cornerA, cornerB, cornerC] = authored.quads[0];
  authored.edgeHandles = {
    [`${cornerA}>${cornerB}`]: [0.5, 1.25, -0.75],
    [`${cornerA}>${cornerC}`]: [0.25, 0.5, 0.125],
  };
  const created = await fetch(`http://127.0.0.1:${service.port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: migrateMountain(authored) }),
  });
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  const base = await serverDocument(projectId);
  console.log(`\n-- a mountain of ${base.vertexIds.length} corners and ${base.quadIds.length} patches --`);

  const ada = await connect('ada', projectId, migrateMountain(structuredClone(base)));
  const jed = await connect('jed', projectId, migrateMountain(structuredClone(base)));
  check(ada.writable && jed.writable, 'two replicas open the same map and both may write it');

  // ---- the roots agree before anything happens, which is what makes drift detectable at all ----
  ada.sync.checkDrift();
  await until(() => ada.diverged.length === 0 && ada.sent.every(entry => entry.kind !== 'fetch'),
    'the first drift check');
  check(ada.diverged.length === 0,
    'two replicas of one mountain hash to the same root, so a check is silent when nothing is wrong');

  // ---- different registers: no conflict ----
  const adaCorner = base.vertexIds[3], jedQuad = base.quadIds[5];
  const adaIndex = 3, jedIndex = 5;
  moveVertex(ada.doc, adaIndex, [0, 5, 0]);
  ada.sync.noteEdit();
  setSurf(jed.doc, jedIndex, 7);
  jed.sync.noteEdit();
  const adaMoved = getVertex(ada.doc, adaIndex);
  ada.sync.flush();
  jed.sync.flush();
  await until(() => ada.landed.length > 0 && jed.landed.length > 0, 'both batches to land');
  check(ada.landed.every(ack => !ack.refused.length && !ack.retired.length)
    && jed.landed.every(ack => !ack.refused.length && !ack.retired.length),
    'two people assigning different registers both land, with nothing refused on either side');
  await until(() => same(readRegister(jed.doc, vertexRegister(adaCorner)), adaMoved)
    && readRegister(ada.doc, quadRegister(jedQuad, 'paint')) === 7,
    'each replica to receive the other');
  check(same(readRegister(jed.doc, vertexRegister(adaCorner)), adaMoved)
    && readRegister(ada.doc, quadRegister(jedQuad, 'paint')) === 7,
    'and each of them holds the other’s value: disjoint registers never need merging');

  // ---- patch protection is an ordinary shared, durable register ----
  const lockedQuad = 15;
  const lockKey = quadRegister(base.quadIds[lockedQuad], 'lock');
  setQuadsLocked(ada.doc, [lockedQuad], true);
  ada.sync.noteEdit();
  ada.sync.flush();
  await until(() => readRegister(jed.doc, lockKey) === true, 'the patch lock to reach the other replica');
  check(readRegister(ada.doc, lockKey) === true && readRegister(jed.doc, lockKey) === true,
    'locking a patch reaches everyone editing the map');
  const lockedOnDisk = await storedOnce(projectId, doc => readRegister(doc, lockKey) === true,
    'the room to persist the patch lock');
  check(readRegister(lockedOnDisk, lockKey) === true,
    'the shared room writes the patch lock into its durable project snapshot');
  check(!ada.landed.some(ack => ack.refused.includes(lockKey)),
    'the server explicitly accepts the patch-lock register');

  // ---- the same register: last writer wins, with a defined outcome ----
  const contested = base.vertexIds[9], contestedIndex = 9;
  writeRegister(ada.doc, vertexRegister(contested), [11, 11, 11]);
  ada.sync.noteEdit();
  ada.sync.flush();
  await until(() => same(readRegister(jed.doc, vertexRegister(contested)), [11, 11, 11]),
    'the first value to arrive');
  writeRegister(jed.doc, vertexRegister(contested), [22, 22, 22]);
  jed.sync.noteEdit();
  jed.sync.flush();
  await until(() => same(readRegister(ada.doc, vertexRegister(contested)), [22, 22, 22]),
    'the second value to arrive');
  const settled = await storedOnce(projectId,
    doc => same(readRegister(doc, vertexRegister(contested)), [22, 22, 22]), 'the room to write what it settled on');
  check(same(readRegister(ada.doc, vertexRegister(contested)), [22, 22, 22])
    && same(readRegister(jed.doc, vertexRegister(contested)), [22, 22, 22]),
    'two people assigning the SAME register resolve last-writer-wins: both replicas hold the later value');
  check(!ada.landed.some(ack => ack.refused.length) && !jed.landed.some(ack => ack.refused.length),
    'and neither of them was refused — an absolute assignment has no way to lose a race');
  check(same(readRegister(settled, vertexRegister(contested)), [22, 22, 22]),
    'the room writes what it settled on as an ordinary revision, so the file agrees with both replicas');
  void contestedIndex;

  // ---- a relative tool resolves into the values it produces ----
  const before = ada.sent.length;
  const receivedBeforeRelative = jed.received.length;
  const smoothed = base.vertexIds[cornerA];
  meshSmoothVertices(ada.doc, [cornerA]);      // relative: "return these corners to their automatic shape"
  moveVertex(ada.doc, 12, [0.5, -0.25, 2]);    // relative: "nudge this one by a delta"
  moveVertex(ada.doc, 13, [0.5, -0.25, 2]);
  ada.sync.noteEdit();
  ada.sync.flush();
  const relative = ada.sent.slice(before).filter(entry => entry.kind === 'assign');
  const changes = relative.flatMap(entry => entry.changes ?? []);
  const shaped = changes.every(change => Array.isArray(change) && typeof change[0] === 'string'
    && change.length <= 2);
  const absolute = changes.filter(([key]) => key.startsWith('v/'))
    .every(([key, value]) => same(value, readRegister(ada.doc, key)));
  const cleared = changes.filter(([key]) => key.startsWith('h/'));
  check(relative.length === 1 && shaped && absolute && changes.length > 0,
    'a relative tool sends the absolute values it produced: every change is a key and the value that key '
    + 'now holds, and nothing on the wire names an operation');
  check(cleared.length === 2 && cleared.every(([, value]) => value === undefined),
    'and a tool that REMOVES something sends the register holding nothing, rather than an instruction to remove');
  void smoothed;
  await until(() => same(readRegister(jed.doc, vertexRegister(base.vertexIds[12])), getVertex(ada.doc, 12)),
    'the nudged corners to arrive');
  const arrivedClears = jed.received.slice(receivedBeforeRelative)
    .filter(change => String(change[0]).startsWith('h/'));
  check(arrivedClears.length === 2 && arrivedClears.every(change => change.length === 1),
    'which survives JSON as the key alone, so "unpainted" never arrives as an assignment of null');
  check(readRegister(jed.doc, `h/${base.vertexIds[cornerA]}>${base.vertexIds[cornerB]}`) === undefined,
    'the other replica applies both, so a crease removed on one mountain is removed on the other');

  // ---- coalescing: the intermediate positions of a drag never reach the wire ----
  const dragging = 20;
  const dragged = ada.sent.length;
  const dragIndex = 30;
  const start = getVertex(ada.doc, dragIndex);
  for (let step = 0; step < 60; step++) {
    moveVertex(ada.doc, dragIndex, [0, 0.25, 0]);
    ada.sync.noteEdit();
  }
  const landedAt = getVertex(ada.doc, dragIndex);
  ada.sync.flush();
  const dragSent = ada.sent.slice(dragged).filter(entry => entry.kind === 'assign');
  const dragChanges = dragSent.flatMap(entry => entry.changes ?? []);
  const dragKey = vertexRegister(base.vertexIds[dragIndex]);
  const intermediates = dragChanges.filter(([key]) => key === dragKey)
    .filter(([, value]) => !same(value, landedAt));
  check(dragSent.length === 1 && dragChanges.length === 1 && intermediates.length === 0
    && same(dragChanges[0][1], landedAt) && !same(start, landedAt),
    `sixty frames of a drag coalesce into one assignment carrying only where the corner ended up`);
  void dragging;

  // ---- what an ordinary edit costs on the wire ----
  //
  // An edit that leaves the mesh alone must never send the mesh. Painting is the case that matters most: it
  // is the commonest edit there is and the cheapest a register can carry — a tile, a ride feel and an
  // orientation per face, a few dozen bytes each — and it is the one that showed the classification was
  // wrong. Every render re-seats the T-node records, and handing the document a fresh array for them read as
  // a topology edit, so a stroke sent the whole mountain per face. So the render funnel runs in this loop,
  // and the bound is stated per face rather than per frame: a claim is three orders of magnitude over it.
  const PAINT_BUDGET = 256, DRAG_BUDGET = 256; // bytes per face / per corner
  const painted = ada.sent.length;
  const strokeFaces = Array.from({ length: 10 }, (_, at) => 100 + at);
  for (const face of strokeFaces) {
    setTex(ada.doc, face, 'MOUNTAIN/0001.png');
    setOrient(ada.doc, face, null);
    setSurf(ada.doc, face, 2);
    ada.render();  // one rebuild per face, exactly as the editor's funnel does it
    ada.sync.flush();
  }
  const stroke = ada.sent.slice(painted);
  const strokeBytes = stroke.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`   a ${strokeFaces.length}-face paint stroke: ${stroke.length} frames, `
    + `${strokeBytes} bytes (${Math.round(strokeBytes / strokeFaces.length)} per face)`);
  check(stroke.length > 0 && stroke.every(entry => entry.kind === 'assign'),
    'a paint stroke sends assignments and nothing else: painting moves no geometry, so it claims nothing');
  check(strokeBytes / strokeFaces.length < PAINT_BUDGET,
    `and costs under ${PAINT_BUDGET} bytes a face, rather than the mountain it is painted on`);

  const dragCorners = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49];
  const dragFrom = ada.sent.length;
  for (let step = 0; step < 12; step++) {
    for (const corner of dragCorners) moveVertex(ada.doc, corner, [0, 0.1, 0]);
    ada.render();
    ada.sync.flush();
  }
  const drag = ada.sent.slice(dragFrom);
  const dragBytes = drag.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`   a ${dragCorners.length}-corner drag over 12 frames: ${drag.length} frames, ${dragBytes} bytes`);
  check(drag.length > 0 && drag.every(entry => entry.kind === 'assign'),
    'and so does a corner drag, for the same reason: moving a corner does not move which corners exist');
  check(dragBytes / (drag.length * dragCorners.length) < DRAG_BUDGET,
    `each frame carrying its corners for under ${DRAG_BUDGET} bytes apiece`);

  // ---- topology: a compare-and-swap over the ids the operation consumes ----
  const shared = await storedOnce(projectId,
    doc => same(readRegister(doc, vertexRegister(base.vertexIds[dragIndex])), landedAt),
    'the room to write the drag');
  ada.sync.adopt(migrateMountain(structuredClone(shared)));
  jed.sync.adopt(migrateMountain(structuredClone(shared)));
  const firstQuad = 0;
  const neighbourQuad = shared.quads.findIndex((quad, at) =>
    at !== firstQuad && quad.filter(corner => shared.quads[firstQuad].includes(corner)).length >= 2);
  check(neighbourQuad > 0, 'the mountain carries two patches sharing an edge, which is the case a claim is for');
  const adaTarget = shared.quadIds[firstQuad], jedTarget = shared.quadIds[neighbourQuad];

  const adaDeleted = applyMeshDelete(ada.doc, { quads: [firstQuad] });
  const jedDeleted = applyMeshDelete(jed.doc, { quads: [neighbourQuad] });
  check(adaDeleted.ok && jedDeleted.ok, 'both replicas run a topology tool locally, at once');
  if (adaDeleted.ok) ada.doc = adaDeleted.doc;
  if (jedDeleted.ok) jed.doc = jedDeleted.doc;
  ada.render();
  jed.render();
  const claimsBefore = { ada: ada.claims.length, jed: jed.claims.length };
  const claimFrom = { ada: ada.sent.length, jed: jed.sent.length };
  // Both flush in the same tick, so both claims are in the air before either has heard anything.
  ada.sync.flush();
  jed.sync.flush();
  await until(() => ada.claims.length > claimsBefore.ada && jed.claims.length > claimsBefore.jed,
    'both claims to resolve');
  const deleteFrames = [...ada.sent.slice(claimFrom.ada), ...jed.sent.slice(claimFrom.jed)];
  check(deleteFrames.length === 2 && deleteFrames.every(entry => entry.kind === 'claim' && !!entry.ids?.length),
    'a delete, which does move which patches exist, still claims — and names the ids it consumed, which is '
    + 'the whole of what one replica compares against another');
  const adaResult = ada.claims[ada.claims.length - 1], jedResult = jed.claims[jed.claims.length - 1];
  const winner = adaResult.ok ? ada : jed, loser = adaResult.ok ? jed : ada;
  const wonTarget = adaResult.ok ? adaTarget : jedTarget, lostTarget = adaResult.ok ? jedTarget : adaTarget;
  check(adaResult.ok !== jedResult.ok,
    'exactly one topology claim wins — two people subdividing the same corner of the mesh cannot both be right');
  await until(() => !loser.doc.quadIds.includes(wonTarget) && loser.doc.quadIds.includes(lostTarget),
    'the loser to revert');
  check(!winner.doc.quadIds.includes(wonTarget) && winner.doc.quadIds.includes(lostTarget),
    'the winner keeps the geometry it made, having never waited for permission to apply it');
  check(!loser.doc.quadIds.includes(wonTarget) && loser.doc.quadIds.includes(lostTarget),
    'and the loser reverts straight to the geometry that won, rather than back through its own');
  check(loser.doc.quadIds.length === winner.doc.quadIds.length
    && loser.doc.vertexIds.length === winner.doc.vertexIds.length,
    'so both replicas hold one mesh again, with one patch gone rather than two');
  const afterClaim = await storedOnce(projectId, doc => !doc.quadIds.includes(wonTarget),
    'the room to write the winning geometry');
  check(!afterClaim.quadIds.includes(wonTarget) && afterClaim.quadIds.includes(lostTarget),
    'and the room wrote the winning geometry, so a joiner would load exactly that');

  // ---- a loop cut mints geometry as well as rewiring it, and claims for the rewiring ----
  const { mesh: cutMesh } = meshFromDoc(winner.doc);
  const cutAdj = meshAdjacency(cutMesh);
  let cutPlan: ReturnType<typeof planLoopCut> | null = null;
  for (let quad = 0; quad < cutMesh.quads.length && !cutPlan; quad++) {
    for (const corners of [[cutMesh.quads[quad][0], cutMesh.quads[quad][1]],
      [cutMesh.quads[quad][0], cutMesh.quads[quad][2]]] as [number, number][]) {
      const candidate = planLoopCut(cutMesh, cutAdj, quad, corners);
      if (candidate.splits.length && !candidate.poleStops.length) { cutPlan = candidate; break; }
    }
  }
  const cutFrom = winner.sent.length, cutClaims = winner.claims.length;
  const cutQuads = winner.doc.quadIds.length;
  const cut = cutPlan ? applyLoopCut(winner.doc, cutPlan, 0.5) : { ok: false as const, error: 'no plan' };
  if (cut.ok) winner.doc = cut.doc;
  winner.render();
  winner.sync.flush();
  await until(() => winner.claims.length > cutClaims, 'the loop cut to resolve');
  const cutFrames = winner.sent.slice(cutFrom);
  check(cut.ok && winner.doc.quadIds.length > cutQuads && cutFrames.length === 1
    && cutFrames[0].kind === 'claim' && !!cutFrames[0].ids?.length,
    'a loop cut claims as well, naming the corners and patches it rewired — the mechanism is not disabled by '
    + 'anything that keeps an ordinary edit off it');
  await until(() => loser.doc.quadIds.length === winner.doc.quadIds.length,
    'the loop cut to reach the other replica');

  // ---- an edit naming tombstoned geometry is discarded quietly ----
  const stale = loser.landed.length;
  loser.channel.assign([[quadRegister(wonTarget, 'paint'), 4]], 4242);
  await until(() => loser.landed.length > stale, 'the stale edit to be answered');
  const answered = loser.landed[loser.landed.length - 1];
  check(answered.retired.length === 1 && answered.retired[0] === quadRegister(wonTarget, 'paint')
    && answered.refused.length === 0,
    'an edit naming geometry that has since been deleted is discarded quietly: retired, not refused, and no error');
  const echoed = winner.doc;
  check(readRegister(echoed, quadRegister(wonTarget, 'paint')) === undefined,
    'and it is not relayed on to anybody, so a late edit cannot resurrect what it named');

  // ---- drift: detected on idle, repaired one chunk at a time ----
  const drifted = base.vertexIds[900];
  const trueValue = readRegister(winner.doc, vertexRegister(drifted));
  writeRegister(loser.doc, vertexRegister(drifted), [-321, -321, -321]);
  // The replica now believes the room agrees with it, which is exactly what a dropped message looks like.
  loser.sync.adopt(loser.doc);
  loser.diverged.length = 0;
  const fetchesBefore = loser.sent.filter(entry => entry.kind === 'fetch').length;
  loser.sync.checkDrift();
  await until(() => loser.diverged.length > 0, 'the divergence to be found');
  check(loser.diverged.length === 1 && loser.diverged[0].startsWith('vertices/'),
    'a replica that has drifted finds it by comparing roots and descending one level: one section, named');
  await until(() => same(readRegister(loser.doc, vertexRegister(drifted)), trueValue), 'the repair');
  const fetched = loser.sent.filter(entry => entry.kind === 'fetch').slice(fetchesBefore);
  check(fetched.length === 1 && fetched[0].sections?.length === 1
    && same(readRegister(loser.doc, vertexRegister(drifted)), trueValue),
    'and repairs by refetching exactly that chunk, which puts the value back without reloading the mountain');

  // ---- undo: inverse assignments, which can resurrect a value somebody else changed ----
  const own = base.vertexIds[40], ownIndex = 40;
  const wasThere = readRegister(winner.doc, vertexRegister(own));
  writeRegister(winner.doc, vertexRegister(own), [3, 3, 3]);
  winner.sync.noteEdit();
  winner.sync.flush();
  const step = winner.sync.sealStep();
  check(!!step && step.priors.some(([key]) => key === vertexRegister(own))
    && same(step.priors.find(([key]) => key === vertexRegister(own))?.[1], wasThere),
    'a step records the registers it changed together with what they held before');
  await until(() => same(readRegister(loser.doc, vertexRegister(own)), [3, 3, 3]), 'the change to arrive');

  writeRegister(loser.doc, vertexRegister(own), [8, 8, 8]);
  loser.sync.noteEdit();
  loser.sync.flush();
  await until(() => same(readRegister(winner.doc, vertexRegister(own)), [8, 8, 8]),
    'somebody else to override it');
  const sentBeforeUndo = winner.sent.length;
  winner.sync.reassert(step!.priors);
  await until(() => same(readRegister(loser.doc, vertexRegister(own)), wasThere), 'the undo to arrive');
  const undoSent = winner.sent.slice(sentBeforeUndo).filter(entry => entry.kind === 'assign');
  check(undoSent.length === 1
    && undoSent[0].changes!.some(([key, value]) => key === vertexRegister(own) && same(value, wasThere)),
    'undo re-asserts the prior value as a FRESH change, indistinguishable on the wire from any other edit');
  check(same(readRegister(loser.doc, vertexRegister(own)), wasThere)
    && same(readRegister(winner.doc, vertexRegister(own)), wasThere),
    'so it puts back a value somebody else had since changed — which is what "put back what I had" means');
  void ownIndex;

  // ---- a scoped revert is an ordinary assignment (docs/040) ----
  //
  // Set the map aside, edit past it, then put that edit back by name. Nothing new travels: the revert arrives
  // on every replica as a `sync` push of absolute values, indistinguishable from anybody else's edit, which is
  // the whole reason it needs no storage, no new conflict handling and no refusal path of its own.
  const service_ = service;
  const api = (path: string) => `http://127.0.0.1:${service_.port}/api/projects/${projectId}${path}`;
  await storedOnce(projectId, doc => same(readRegister(doc, vertexRegister(own)), wasThere),
    'the room to write everything before the mark is taken');
  const marking = await fetch(api('/checkpoints'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'named', note: 'the mark a revert puts things back to' }),
  });
  const mark = ((await marking.json()) as { checkpoint: { file: string } }).checkpoint.file;

  const reverted = winner.doc.vertexIds[50];
  const stood = readRegister(winner.doc, vertexRegister(reverted));
  writeRegister(winner.doc, vertexRegister(reverted), [55, 55, 55]);
  winner.sync.noteEdit();
  winner.sync.flush();
  await until(() => same(readRegister(loser.doc, vertexRegister(reverted)), [55, 55, 55]),
    'the edit the revert will put back');
  const heard = { winner: winner.received.length, loser: loser.received.length };

  const put = await fetch(api(`/checkpoints/${encodeURIComponent(mark)}/revert`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const outcome = await put.json() as { reverted: number; checkpoint: { reason: string; pinned: boolean } | null };
  check(put.ok && outcome.reverted === 1,
    'a revert names exactly the registers that differ from the checkpoint, and puts those back');
  await until(() => same(readRegister(winner.doc, vertexRegister(reverted)), stood)
    && same(readRegister(loser.doc, vertexRegister(reverted)), stood),
    'the revert to reach both replicas');
  const pushed = [
    ...winner.received.slice(heard.winner), ...loser.received.slice(heard.loser),
  ].filter(change => change[0] === vertexRegister(reverted));
  check(pushed.length === 2 && pushed.every(change => same(change[1], stood)),
    'and reaches every replica as an ordinary register assignment — the author who asked for it included, '
    + 'since the values are as much somebody else’s as anybody else’s');
  check(same(readRegister(await storedOnce(projectId,
    doc => same(readRegister(doc, vertexRegister(reverted)), stood), 'the room to write the revert'),
    vertexRegister(reverted)), stood),
    'the room writes it as an ordinary revision, so the file agrees with both replicas');
  check(outcome.checkpoint?.reason === 'revert' && outcome.checkpoint.pinned === true,
    'and the document it replaced is set aside and pinned, so a revert nobody wanted is undone the way a bad '
    + 'restore is');

  // ---- awareness: said when it changes, and at no other time (docs/039) ----
  //
  // People avoid each other because they can see each other, so this has to be true of the commonest edit
  // there is and free the rest of the time. Both halves are checked here: a tab that is merely rendering says
  // nothing at all, and a paint stroke — which selects nothing, having dropped the paint selection on its
  // first face — names the faces it is putting tiles on.
  await wait(EDITING_MS + 60); // whatever the last edit was naming has gone quiet
  const idleFrom = ada.aware.length;
  for (let render = 0; render < 10; render++) { ada.render(); ada.awareness.publish(); }
  check(ada.aware.length === idleFrom,
    'an editor that is only rendering, with nothing picked, tells the room nothing at all');

  ada.picked.vertices = [ada.doc.vertexIds[7]];
  for (let render = 0; render < 5; render++) { ada.render(); ada.awareness.publish(); }
  check(ada.aware.length === idleFrom + 1
    && same(ada.aware[ada.aware.length - 1].vertices, [ada.doc.vertexIds[7]]),
    'a selection costs one frame however many renders it stands through — one per distinct state, not one '
    + 'per render');

  ada.picked.vertices = [];
  const strokeFrom = ada.aware.length, jedHeard = jed.peers.length;
  const shownFaces = Array.from({ length: 10 }, (_, at) => 200 + at);
  const shownNames = shownFaces.map(face => ada.doc.quadIds[face]);
  for (const face of shownFaces) {
    setTex(ada.doc, face, 'MOUNTAIN/0002.png');
    ada.render();
    ada.sync.flush();
    ada.awareness.publish();
  }
  const strokeAware = ada.aware.slice(strokeFrom);
  const told = new Set(strokeAware.flatMap(frame => frame.quads));
  console.log(`   a ${shownFaces.length}-face paint stroke: ${strokeAware.length} awareness frames, `
    + `naming ${told.size} faces`);
  check(strokeAware.length > 0 && shownNames.every(name => told.has(name)),
    'a paint stroke says which faces it is painting, though it has none of them selected');
  check(strokeAware.some(frame => frame.dragging.some(name => shownNames.includes(name))),
    'and the ones the room has not acknowledged yet are held, which is what a face being drawn softer means');
  await until(() => jed.peers.length > jedHeard, 'the room to relay it');
  check(jed.peers.some(peer => peer.aware.quads.some(name => shownNames.includes(name))),
    'so the other replica can see exactly where on the mountain somebody else is working');

  // Everything the test has done so far arrived by a different route — a lost claim adopting somebody else's
  // mountain whole, a repaired section, an undo re-asserting a prior, a revert pushed from outside the room —
  // and each of them leaves a replica believing something about what the room holds. They agree, or the next
  // comparison finds a difference nobody made.
  await idle([winner, loser], 200);
  check(!winner.sync.pending().length && !loser.sync.pending().length,
    'every replica is settled behind all of that: what each believes the room holds names exactly the '
    + 'registers its own document decomposes into, whichever route the values arrived by');

  // ---- a register cleared back to nothing settles, and the room goes quiet ----
  //
  // "This face is unpainted" is a value like any other, and the two representations that have to agree about it
  // both state it by ABSENCE: the document's decomposition omits a register holding nothing, and so does what a
  // replica believes the room holds. Anything else could not converge — a key one side carries and the other
  // does not is a difference every comparison would find, sending the clear again, and the echo of the clear
  // would put it back — and it would be invisible to the drift detector the whole time, because the DOCUMENTS
  // would agree perfectly. So the assertion is about the bookkeeping as much as the traffic: nothing pending on
  // either replica, nothing on the wire, and a room whose sequence stands still while nobody is editing.
  const unpainted = 300;
  const clearedKey = quadRegister(ada.doc.quadIds[unpainted], 'tex');
  const room = roomFor(projectId)!;
  setTex(ada.doc, unpainted, 'MOUNTAIN/0004.png');
  ada.render();
  ada.sync.flush();
  await until(() => readRegister(jed.doc, clearedKey) === 'MOUNTAIN/0004.png', 'the paint to arrive');
  clearTex(ada.doc, unpainted);
  ada.render();
  ada.sync.flush();
  await until(() => readRegister(jed.doc, clearedKey) === undefined, 'the clear to arrive');
  await idle([ada, jed], EDITING_MS + 200);   // whatever was in the air lands, and the marks it left decay

  const bothFrom = { ada: ada.sent.length, jed: jed.sent.length, at: room.at, aware: ada.aware.length };
  await idle([ada, jed], 1_000);
  const bothSent = (ada.sent.length - bothFrom.ada) + (jed.sent.length - bothFrom.jed);
  console.log(`   a second of two idle replicas after a face was unpainted: ${bothSent} frames, `
    + `room at ${bothFrom.at} -> ${room.at}`);
  check(bothSent === 0,
    'a face painted and then unpainted with two people on it settles: neither replica sends anything over the '
    + 'second that follows, however hard both of them are rendering');
  check(room.at === bothFrom.at,
    'so the room stops sequencing — nobody is editing, and the number every replica measures itself against '
    + 'stands still');
  check(ada.sync.pending().length === 0 && jed.sync.pending().length === 0,
    'and the reason it stops is that both replicas have converged: what each believes the room holds names '
    + 'exactly the registers its own document decomposes into');
  check(ada.aware.length === bothFrom.aware && !ada.sync.editing().quads.length,
    'and the face stops counting as one somebody is working on: nothing holds the mark over it alive, so it '
    + 'decays and awareness falls silent behind it rather than announcing a hand that is not there');

  // ---- and alone, with nobody to echo anything back ----
  jed.close();
  await wait(200);
  const soleFace = 301;
  const soleKey = quadRegister(ada.doc.quadIds[soleFace], 'tex');
  check(readRegister(ada.doc, soleKey) === undefined, 'a face nobody has painted holds nothing');
  setTex(ada.doc, soleFace, 'MOUNTAIN/0005.png');
  ada.render();
  ada.sync.flush();
  await until(() => readRegister(room.doc, soleKey) === 'MOUNTAIN/0005.png', 'the paint to land');
  clearTex(ada.doc, soleFace);
  ada.render();
  ada.sync.flush();
  await until(() => readRegister(room.doc, soleKey) === undefined, 'the clear to land');
  await idle([ada], 200);

  const soleFrom = { sent: ada.sent.length, at: room.at };
  await idle([ada], 1_000);
  console.log(`   a second of one idle replica after a face was painted and cleared: `
    + `${ada.sent.length - soleFrom.sent} frames, room at ${soleFrom.at} -> ${room.at}`);
  check(ada.sent.length === soleFrom.sent && room.at === soleFrom.at && !ada.sync.pending().length,
    'and a replica by itself settles the same way — painting a face that was never painted and clearing it '
    + 'again leaves nothing to say');

  // ---- the room declines to sequence what does not move the document ----
  //
  // Nothing above depends on this, and that is the point of it: a replica that re-asserts a value the room
  // already holds is applied and answered like any other, and bounds itself there rather than driving the
  // sequence, the snapshots and everybody else's inbox from a mountain nobody changed.
  const standing = vertexRegister(ada.doc.vertexIds[60]);
  const already = readRegister(room.doc, standing);
  const repeatFrom = { at: room.at, landed: ada.landed.length };
  ada.channel.assign([[standing, already]], 9001);
  await until(() => ada.landed.length > repeatFrom.landed, 'the repeat to be answered');
  const repeat = ada.landed[ada.landed.length - 1];
  check(repeat.retired.length === 0 && repeat.refused.length === 0 && room.at === repeatFrom.at,
    'an assignment of the value a register already holds is accepted and refused nothing, and takes no '
    + 'sequence number: the sequence counts what the document holds');
  ada.channel.assign([[standing, [61, 62, 63]]], 9002);
  await until(() => room.at > repeatFrom.at, 'a real change to move the room on');
  check(same(readRegister(room.doc, standing), [61, 62, 63]) && room.at === repeatFrom.at + 1,
    'while writing a different value to the same register moves it on exactly once, however many times that '
    + 'register has been written before');

  ada.close();
  await wait(150);
} catch (error) {
  recordFailure();
  console.error('FAIL', error);
} finally {
  for (const client of opened) { try { client.close(); } catch { /* already gone */ } }
  await service?.close();
  forgetSessions();
  forgetRooms();
}

// ---- a topology repair settles after render re-fits a derived T-junction parameter ------------------------
{
  const roomDoc = migrateMountain(defaultMountain());
  const [hostA, hostB, embedded] = roomDoc.quads[0];
  roomDoc.tJunctions = [{ vertex: embedded, edge: [hostA, hostB], t: 0.2 }];
  let doc = structuredClone(roomDoc), fetches = 0;
  const applied: string[] = [];
  const sync = createRegisterSync({
    getDoc: () => doc,
    setDoc: next => { doc = next; },
    channel: {
      assign: () => true,
      claim: () => true,
      checkDrift: () => true,
      fetchSections: () => { fetches++; return true; },
    },
    onApplied: what => applied.push(what),
  });
  sync.connect();
  sync.adopt(doc);

  // This is the order in the app: the fetched topology is adopted, `onApplied('document')` launches the
  // progressive render, and that render re-fits the derived parameter before the next drift check.
  sync.repair({ registers: [], document: structuredClone(roomDoc) });
  doc.tJunctions![0].t = 0.800000271;
  sync.noteEdit();
  sync.flush();
  const diverged = sync.compareDigest(digestDocument(roomDoc, textHash));
  check(applied.join() === 'document' && diverged.length === 0 && fetches === 0,
    'a topology repair followed by render-time T-junction re-fitting converges instead of fetching forever');
  sync.stop();
}

// ---- the reconnection decision, on an injected clock -------------------------------------------------------
//
// Whether held changes are replayed is a decision about elapsed time, so it is exercised against a clock this
// test moves rather than against a socket it waits on. No service is involved: the question is entirely one
// of what the replica does with what it was holding.
{
  let doc = migrateMountain(defaultMountain());
  let replacements = 0;
  const applied: string[] = [];
  const sync = createRegisterSync({
    getDoc: () => doc,
    setDoc: next => { doc = next; replacements++; },
    channel: {
      assign: () => true, claim: () => true, checkDrift: () => true, fetchSections: () => true,
    },
    onApplied: what => applied.push(what),
  });
  sync.connect();
  sync.caughtUp({ changes: [], document: structuredClone(doc) });
  check(replacements === 0 && applied.length === 0,
    'an identical whole-document catch-up rebases quietly instead of loading the mountain again');

  const changed = structuredClone(doc);
  changed.name = `${changed.name} remote`;
  sync.caughtUp({ changes: [], document: changed });
  check(replacements === 1 && applied.length === 1 && applied[0] === 'document' && doc.name === changed.name,
    'a changed whole-document catch-up still replaces and rebuilds the mountain');
  sync.stop();
}

{
  let clock = 1_000_000;
  const sent: RegisterAssignment[][] = [];
  let doc = migrateMountain(defaultMountain());
  let summary: Reconciliation | null = null;
  const key = vertexRegister(doc.vertexIds[2]);
  const sync = createRegisterSync({
    getDoc: () => doc,
    setDoc: next => { doc = next; },
    channel: {
      assign: changes => { sent.push(structuredClone(changes)); return true; },
      claim: () => true,
      checkDrift: () => true,
      fetchSections: () => true,
    },
    onReconcile: made => { summary = made; },
    now: () => clock,
  });
  sync.adopt(doc);
  sync.connect();

  /** A short interruption: back inside the presence TTL, with nobody having had time to build on what this
   *  replica was holding. */
  sync.disconnect();
  writeRegister(doc, key, [1, 1, 1]);
  sync.noteEdit();
  sync.flush();
  check(sync.status().held === 1 && !sync.status().connected,
    'a change made while the channel is down is held rather than lost');
  clock += 30_000;
  sync.caughtUp({ changes: [[key, [9, 9, 9]]] });
  check(!summary && same(readRegister(doc, key), [1, 1, 1]) && sent.length === 1,
    `a reconnection inside ${REPLAY_THRESHOLD_MS / 1000}s replays what was held, which is what "I kept editing" means`);

  /** A long one: past the threshold, the room has already swept this session out of presence and told
   *  everybody it left, so replaying blind would be a participant nobody is expecting reaching back in. */
  sync.disconnect();
  writeRegister(doc, key, [2, 2, 2]);
  sync.noteEdit();
  sync.flush();
  const before = sent.length;
  clock += REPLAY_THRESHOLD_MS + 60_000;
  sync.caughtUp({ changes: [[key, [7, 7, 7]]] });
  const made = summary as Reconciliation | null;
  check(!!made && made.changes.length === 1 && made.changes[0][0] === key,
    'past the threshold nothing is replayed: what was held is put in front of the author as a summary');
  check(!!made && made.contested.length === 1 && made.contested[0] === key,
    'and the summary names what the room changed underneath, which is what a replay would have overwritten');
  check(sent.length === before && same(readRegister(doc, key), [7, 7, 7]),
    'the room’s value stands until somebody decides, so an hour away cannot silently undo an afternoon');
  sync.replayHeld();
  check(sent.length === before + 1 && same(readRegister(doc, key), [2, 2, 2]),
    'and putting it back is the same ordinary assignment it would have been all along');
  sync.stop();
}

delete process.env.SLOPESMITH_WORKSPACE_ROOT;
delete process.env.SLOPESMITH_MAPS_ROOT;
forgetWorkspaceConfig();
rmSync(root, { recursive: true, force: true });

if (failures) process.exitCode = 1;
else console.log('SYNC PASS');
