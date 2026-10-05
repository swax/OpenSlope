import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collisionLabMountain } from '../src/core/collision/lab';
import { digestDocument, textHash } from '../src/core/doc/digest';
import { globalRegister, objectRegister, quadRegister, vertexRegister } from '../src/core/doc/registers';
import { canonicalJson } from '../src/core/doc/canonical';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import { configureCheckpoints, createProject } from '../src/server/projects';
import {
  assign, claimTopology, configureRooms, forgetRooms, joinRoom, roomDigest, takeSnapshot,
} from '../src/server/session/room';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { check, failures } from './check';

/**
 * The room's digest is maintained lazily (docs/039): an accepted batch only records which registers it moved,
 * and `roomDigest` rehashes their sections when somebody asks. Laziness is only an optimisation if it can never
 * be told apart from computing the digest from scratch, so every claim below is that equality — after single
 * batches, after many batches nobody asked about, after a delete, after a topology claim, and after the
 * snapshot path renames the document underneath the room.
 */

const root = mkdtempSync(join(tmpdir(), 'slopesmith-room-digest-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
configureRooms({ snapshotIdleMs: 60_000, snapshotChanges: 1 << 30 });
configureCheckpoints({ intervalMs: 60_000, changeBytes: 1 << 30 });

try {
  const doc = collisionLabMountain();
  doc.name = 'Digest Lab';
  const created = await createProject(doc);
  const room = await joinRoom(created.project.id);

  const fresh = () => canonicalJson(digestDocument(room.doc, textHash));
  const matches = (label: string) => check(canonicalJson(roomDigest(room)) === fresh(), label);

  matches('a freshly opened room digests exactly as its document does');

  const corner = vertexRegister(room.doc.vertexIds[0]);
  const far = vertexRegister(room.doc.vertexIds[room.doc.vertexIds.length - 1]);
  const face = quadRegister(room.doc.quadIds[0], 'paint');
  assign(room, [[corner, [1, 2, 3]]], 'Ada');
  check(room.stale.size === 1, 'an accepted batch records the register it moved instead of rehashing');
  matches('one vertex move, asked about afterwards');

  // Many batches across several sections, nobody asking in between.
  for (let step = 0; step < 50; step++) {
    assign(room, [[corner, [step, step, step]], [far, [step, -step, step]]], 'Ada');
    assign(room, [[face, step % 4]], 'Bob');
  }
  const prop = room.doc.props![0];
  assign(room, [[objectRegister('prop', prop.id!), { ...prop, pos: [9, 9, 9] }]], 'Bob');
  assign(room, [[globalRegister('aiSeed'), 1234]], 'Ada');
  check(room.stale.size === 5, 'repeated writes to one register are one stale entry, not one per batch',
    String(room.stale.size));
  matches('a hundred batches over vertices, faces, a prop and a global, asked about once');
  check(room.stale.size === 0, 'asking settles what was outstanding');
  matches('asking twice with nothing landed between is the same answer');

  // Removing a whole object, and clearing a sparse channel, both empty what a section held.
  const doomed = room.doc.props![1];
  const props = room.doc.props!.length;
  assign(room, [[objectRegister('prop', doomed.id!), undefined], [face, undefined]], 'Bob');
  check(room.doc.props!.length === props - 1, 'the delete landed');
  matches('deleting an object and clearing a face');

  // A value nobody changed moves nothing, so it marks nothing stale.
  roomDigest(room);
  assign(room, [[corner, [49, 49, 49]]], 'Ada');
  check(room.stale.size === 0, 'a re-assertion of the held value leaves nothing to rehash');

  // Topology replaces the structure, which renumbers every chunk: the digest is recomputed whole.
  const before = room.at;
  assign(room, [[far, [7, 7, 7]]], 'Ada');
  const deleted = applyMeshDelete(structuredClone(room.doc), { quads: [1] });
  check(deleted.ok, 'a topology edit could be made locally');
  if (deleted.ok) {
    const claimed = claimTopology(room, { ids: [room.doc.quadIds[1]], at: before, document: deleted.doc });
    check(claimed.ok, 'and its claim was taken');
    check(room.digest === null && room.stale.size === 0, 'a claim lets the old digest go rather than patching it');
    matches('after a topology claim and the replay of what landed under it');
    // An edit after the claim patches the freshly computed digest again.
    assign(room, [[vertexRegister(room.doc.vertexIds[2]), [5, 6, 7]]], 'Bob');
    matches('an edit landed on the new structure');
  }

  // The snapshot path can rename the document underneath the room, which is a register like any other.
  const twin = collisionLabMountain();
  twin.name = 'TAKEN';
  await createProject(twin);
  roomDigest(room);
  assign(room, [[globalRegister('name'), 'TAKEN']], 'Ada');
  await takeSnapshot(room);
  check(room.doc.name !== 'TAKEN', 'the snapshot stored a name other than the one asked for, and the room took it',
    room.doc.name);
  matches('after the snapshot renamed the room’s document');
} finally {
  forgetRooms();
  rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
