// tier: fast
import { collisionLabMountain } from '../src/core/collision/lab';
import { canonicalJson } from '../src/core/doc/canonical';
import { migrateMountain } from '../src/core/doc/mountain';
import { carryIdentity } from '../src/core/doc/ids';
import {
  applyRegisters, documentRegisters, handleRegister, objectFieldRegister, registerGeometry, structuralDocument,
  writeRegister, type RegisterKey, type RegisterValue,
} from '../src/core/doc/registers';
import { applyTopologyDelta, topologyDelta, type TopologyDelta } from '../src/core/doc/topology-delta';
import type { QuadMeshDoc } from '../src/core/doc/types';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import { applyMeshDissolve } from '../src/core/mesh/ops/dissolve';
import { applyLoopCut, planLoopCut } from '../src/core/mesh/ops/loop-cut';
import { applyCellEdgeInsert } from '../src/core/mesh/ops/cell-edge-insert';
import { applyMeshFlip } from '../src/core/mesh/ops/flip';
import { applyVertexWeld } from '../src/core/mesh/ops/weld';
import { applyEdgeRip } from '../src/core/mesh/ops/edge-rip';
import { appendStandalonePatch } from '../src/core/mesh/ops/append';
import { meshAdjacency, meshFromDoc } from '../src/core/mesh/topology';
import { cutTrail, TRAIL_SETTINGS_DEFAULTS } from '../src/core/mesh/trail-object';
import { check } from './check';

/**
 * Topology as an id-based delta (docs/039, *Topology travels as a delta*).
 *
 * The claim under test is the one every replica's convergence rests on: a delta written from the structure a
 * replica took as the room's to the document an operation produced, applied to another copy of that base and
 * followed by the register changes the claim carries, reproduces the operated document exactly — every
 * structural field, in the same order, and every register. It is checked over the real operations rather than
 * over hand-built arrays, because what an operation does to array order is precisely what a delta has to say.
 */

/** What a register difference says about one document against another: the assignments a claim carries. */
function registerChanges(before: QuadMeshDoc, after: QuadMeshDoc, delta: TopologyDelta): [RegisterKey, RegisterValue][] {
  const was = documentRegisters(before), now = documentRegisters(after);
  const written = new Set(delta.vertices.filter(run => typeof run[0] === 'string').map(run => `v/${run[0] as string}`));
  const liveVertices = new Set(after.vertexIds), liveQuads = new Set(after.quadIds);
  const out: [RegisterKey, RegisterValue][] = [];
  for (const [key, value] of now) {
    if (written.has(key)) continue;
    if (!was.has(key) || canonicalJson(was.get(key)) !== canonicalJson(value)) out.push([key, structuredClone(value)]);
  }
  for (const key of was.keys()) {
    if (now.has(key)) continue;
    const named = registerGeometry(key);
    if (named.vertices.some(id => !liveVertices.has(id)) || named.quads.some(id => !liveQuads.has(id))) continue;
    out.push([key, undefined]);
  }
  return out;
}

/** Everything a document states that two replicas have to agree on: its structure (with the T-node parameter
 *  the digest leaves out) and every register, in order. */
const statement = (doc: QuadMeshDoc): string => canonicalJson({
  structure: structuralDocument(doc), tJunctions: doc.tJunctions,
  registers: [...documentRegisters(doc)],
});

/** Round-trip one operation: write the delta, apply it to an untouched copy of the base, land the registers. */
function roundTrip(label: string, base: QuadMeshDoc, operated: QuadMeshDoc): TopologyDelta | null {
  const delta = topologyDelta(base, operated);
  const wire = JSON.parse(JSON.stringify(delta)) as TopologyDelta;
  const replica = structuredClone(base);
  const applied = applyTopologyDelta(replica, wire);
  if (!applied.ok) { check(false, `${label}: the delta applies to a copy of its base`, applied.error); return null; }
  const changes = registerChanges(base, operated, delta);
  const landed = applyRegisters(applied.applied.doc, changes);
  check(statement(applied.applied.doc) === statement(operated) && landed.refused === 0 && landed.retired === 0,
    `${label}: the applied delta and its registers reproduce the operated document exactly`,
    `${delta.vertices.length} vertex runs, ${delta.quads.length} quad runs, ${changes.length} registers`);
  check(canonicalJson(replica) === canonicalJson(structuredClone(base)),
    `${label}: applying it leaves the document it was applied to as it was`);
  return delta;
}

const bytes = (value: unknown): number => JSON.stringify(value).length;

// ---- a real mountain, creased, so the crease channel has something to carry ---------------------------------
const lab = migrateMountain(collisionLabMountain('DELTA'));
const [a, b, c] = lab.quads[0];
lab.edgeHandles = { [`${a}>${b}`]: [0.5, 1.25, -0.75], [`${a}>${c}`]: [0.25, 0.5, 0.125] };
lab.quadPaint = { 0: 2, 5: 3, 9: 1 };
lab.quadTex = { 5: 'MOUNTAIN/0004.png' };

// Delete: survivors compact in order, so a delta is a few runs however large the mountain.
const far = lab.quads.findIndex(quad => !quad.some(corner => [a, b, c].includes(corner)));
const deleted = applyMeshDelete(lab, { quads: [far] });
check(deleted.ok, 'a quad far from the creases can be deleted');
if (deleted.ok) {
  const delta = roundTrip('delete', lab, deleted.doc);
  if (delta) {
    check(delta.vertices.length + delta.quads.length <= 6, 'a delete is a handful of runs',
      `${delta.vertices.length} + ${delta.quads.length}`);
    const whole = bytes(deleted.doc);
    console.log(`   delete: delta ${bytes(delta)} bytes against a ${whole}-byte document`);
    check(bytes(delta) * 50 < whole, 'and far smaller than the document');
  }
  // A delta's result shares nothing a register write edits in place with the document it came from — an object
  // field is written onto the member itself, so the members are copies too.
  const prop = lab.props?.[0];
  const fielded = applyTopologyDelta(lab, topologyDelta(lab, deleted.doc));
  if (prop?.id && fielded.ok) {
    const before = canonicalJson(prop);
    writeRegister(fielded.applied.doc, objectFieldRegister('prop', 'pos', prop.id), [123, 456, 789]);
    check(canonicalJson(prop) === before && fielded.applied.doc.props![0].pos[0] === 123,
      'a field written onto the result of a delta leaves the object in the document it came from untouched');
  } else check(false, 'the lab mountain carries a prop to write a field of');

  // The docs/039 crease case: an unrelated delete beneath a creased vertex leaves the crease byte-identical.
  const creaseKey = handleRegister(lab.vertexIds[a], lab.vertexIds[b]);
  const replica = applyTopologyDelta(structuredClone(lab), topologyDelta(lab, deleted.doc));
  check(replica.ok && canonicalJson(documentRegisters(replica.applied.doc).get(creaseKey)) === canonicalJson([0.5, 1.25, -0.75]),
    'a crease survives an unrelated delete beneath it, byte-identical');

  // Undo: the base restored over the operated document. What it brings back stops being a tombstone, which a
  // delta states as the prefix that stands.
  const restored = structuredClone(lab);
  carryIdentity(restored, deleted.doc);
  const undone = roundTrip('undo of a delete', deleted.doc, restored);
  check(!!undone && undone.tombstones !== undefined && (undone.tombstones === null || undone.tombstones.add.length === 0),
    'an undo states its tombstones as a shorter prefix with nothing appended');
}

// Loop cut: mints vertices and quads and rewires the cut ring.
{
  const { mesh } = meshFromDoc(lab);
  const adj = meshAdjacency(mesh);
  let plan: ReturnType<typeof planLoopCut> | null = null;
  for (let quad = 0; quad < mesh.quads.length && !plan; quad++) {
    const corners = [mesh.quads[quad][0], mesh.quads[quad][1]] as [number, number];
    const candidate = planLoopCut(mesh, adj, quad, corners);
    if (candidate.splits.length && !candidate.tStops.length) plan = candidate;
  }
  const cut = plan ? applyLoopCut(lab, plan, 0.5) : { ok: false as const, error: 'no plan' };
  check(cut.ok, 'a loop cut can be planned and applied');
  if (cut.ok) {
    const delta = roundTrip('loop cut', lab, cut.doc);
    if (delta) console.log(`   loop cut: delta ${bytes(delta)} bytes against a ${bytes(cut.doc)}-byte document`);

    // Undoing it restores the document from before, under the identity the document has now — as history
    // does — so the names the cut minted are retired rather than handed out again by the next operation.
    const restored = structuredClone(lab);
    carryIdentity(restored, cut.doc);
    const minted = cut.doc.vertexIds.filter(id => !lab.vertexIds.includes(id));
    check(restored.nextId === cut.doc.nextId && minted.length > 0
      && minted.every(id => restored.tombstones?.includes(id))
      && !restored.tombstones?.some(id => restored.vertexIds.includes(id) || restored.quadIds.includes(id)),
      'a restore keeps the counter where it was, retires what it removes and revives what it brings back');
    roundTrip('undo of a loop cut', cut.doc, restored);
    const rolledBack = applyTopologyDelta(structuredClone(cut.doc), topologyDelta(cut.doc, lab));
    check(!rolledBack.ok, 'a delta that moves the counter backwards is refused',
      rolledBack.ok ? 'applied' : rolledBack.error);
  }
}

// Insert an edge through cells, dissolve, flip, weld, rip and append — the other shapes an operation takes.
{
  const inserted = applyCellEdgeInsert(lab, [far]);
  if (inserted.ok) roundTrip('cell edge insert', lab, inserted.doc);
  else check(false, 'a cell edge insert applies', inserted.error);
}
{
  const flipped = applyMeshFlip(lab, [far]);
  if (flipped.ok) roundTrip('flip', lab, flipped.doc);
  else check(false, 'a flip applies', flipped.error);
}
{
  const corner = lab.quads[far][3];
  const dissolved = applyMeshDissolve(lab, { vertices: [corner] });
  if (dissolved.ok) roundTrip('dissolve', lab, dissolved.doc);
  else console.log(`   (dissolve declined here: ${dissolved.error})`);
}
{
  const [p, q] = lab.quads[far];
  const welded = applyVertexWeld(lab, [[p, q]]);
  if (welded.ok) roundTrip('weld', lab, welded.doc);
  else console.log(`   (weld declined here: ${welded.error})`);
}
{
  const patch = appendStandalonePatch(lab, [0, 500, 0], [0, 1, 0]);
  roundTrip('append a standalone patch', lab, patch.doc);
}
// An interior edge — one with a patch on both sides — for the operations that take one.
const neighbour = lab.quads.findIndex((quad, at) => at !== far && quad.filter(corner => lab.quads[far].includes(corner)).length === 2);
const shared = lab.quads[far].filter(corner => lab.quads[neighbour]?.includes(corner)) as [number, number];
{
  // A rip opens the edge and duplicates the corners along it.
  const ripped = neighbour >= 0 ? applyEdgeRip(lab, [shared]) : { ok: false as const, error: 'no neighbour' };
  if (ripped.ok) roundTrip('edge rip', lab, ripped.doc);
  else check(false, 'an edge rip applies', ripped.error);
}
{
  // A creased edge can go while both its ends stay: deleting a rim patch takes its rim edge, and the corners
  // live on in the patches beside it. The crease goes with the edge. That clear names no retired id, so it has
  // to travel as a register; a receiver that kept the crease would hide it until the edge formed again.
  const owners = new Map<string, number>(), uses = new Map<number, number>();
  const edgeKey = (p: number, q: number) => `${Math.min(p, q)},${Math.max(p, q)}`;
  lab.quads.forEach(([qa, qb, qc, qd]) => {
    for (const [p, q] of [[qa, qb], [qb, qd], [qd, qc], [qc, qa]]) owners.set(edgeKey(p, q), (owners.get(edgeKey(p, q)) ?? 0) + 1);
    for (const corner of new Set([qa, qb, qc, qd])) uses.set(corner, (uses.get(corner) ?? 0) + 1);
  });
  let rim: { quad: number; edge: [number, number] } | null = null;
  lab.quads.forEach(([qa, qb, qc, qd], quad) => {
    for (const [p, q] of [[qa, qb], [qb, qd], [qd, qc], [qc, qa]] as [number, number][]) {
      if (!rim && p !== q && owners.get(edgeKey(p, q)) === 1 && (uses.get(p) ?? 0) > 1 && (uses.get(q) ?? 0) > 1) rim = { quad, edge: [p, q] };
    }
  });
  const found = rim as { quad: number; edge: [number, number] } | null;
  check(!!found, 'the mountain has a rim edge whose corners other patches share');
  if (found) {
    const creased = structuredClone(lab);
    creased.edgeHandles = { ...creased.edgeHandles, [`${found.edge[0]}>${found.edge[1]}`]: [1, 2, 3] };
    const removed = applyMeshDelete(creased, { quads: [found.quad] });
    if (removed.ok) {
      const crease = handleRegister(creased.vertexIds[found.edge[0]], creased.vertexIds[found.edge[1]]);
      const delta = topologyDelta(creased, removed.doc);
      const survives = found.edge.every(corner => removed.doc.vertexIds.includes(creased.vertexIds[corner]));
      check(survives && registerChanges(creased, removed.doc, delta).some(([key, value]) => key === crease && value === undefined),
        'a crease whose edge went while both its corners stayed travels as a clear');
      roundTrip('rim delete', creased, removed.doc);
    } else check(false, 'a rim patch can be deleted', removed.error);
  }
}

// ---- a delta written against another base is refused, not misapplied --------------------------------------
if (deleted.ok) {
  const delta = topologyDelta(lab, deleted.doc);
  const elsewhere = applyMeshDelete(lab, { quads: [far === 1 ? 2 : 1] });
  if (elsewhere.ok) {
    const result = applyTopologyDelta(elsewhere.doc, delta);
    check(!result.ok, 'a delta applied to a base it was not written against is refused',
      result.ok ? 'applied' : result.error);
  }
  for (const [label, bad] of [
    ['a run past the end', { ...delta, vertices: [[0, lab.vertexIds.length + 1]] }],
    ['a vertex kept twice', { ...delta, vertices: [[0, 2], [1, 1]] }],
    ['a corner that does not exist', { ...delta, quads: [['q:new', 'nobody', 'nobody', 'nobody', 'nobody']] }],
    ['no structure', { ...delta, structure: '' }],
    ['not an object', 7],
  ] as const) {
    const result = applyTopologyDelta(lab, bad);
    check(!result.ok, `malformed input is refused rather than thrown on: ${label}`);
  }
}

// ---- an owned trail (docs/023): cutting it, and re-cutting it longer, travel as a delta plus its register --------
{
  const trail = { id: 'trail:0000', knots: [[400, 0, 0], [400, 0, 100]] as [number, number, number][],
    settings: { ...TRAIL_SETTINGS_DEFAULTS }, vertices: [] as string[], quads: [] as string[] };
  const cut = cutTrail(lab, trail);
  if (cut.ok) {
    cut.doc.trails = [cut.trail];
    roundTrip('trail cut', lab, cut.doc);
    const longer = cutTrail(cut.doc, { ...cut.trail, knots: [...cut.trail.knots, [450, 0, 180]],
      handles: [null, { out: [0, 0, 20] }] });
    if (longer.ok) {
      longer.doc.trails = [longer.trail];
      roundTrip('trail re-cut', cut.doc, longer.doc);
      // A branch off its middle knot: the trail splits, and the junction is cut with it.
      const branched = cutTrail(longer.doc, { ...longer.trail, branches: [{ knot: 1, knots: [[520, 0, 160]] }] });
      if (branched.ok) {
        branched.doc.trails = [branched.trail];
        roundTrip('trail branch', longer.doc, branched.doc);
      } else check(false, 'trail branch: the branched trail cuts', branched.error);
    } else check(false, 'trail re-cut: the longer trail cuts', longer.error);
  } else check(false, 'trail cut: the trail cuts', cut.error);
}
