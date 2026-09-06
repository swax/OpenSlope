/**
 * Headless checks over the REGISTER decomposition and the canonical two-level hash (docs/039). Run:
 * `npx tsx test/registers.test.ts`
 *
 * Two claims are under test, and both are offline claims — nothing here opens a socket.
 *
 * The first is that the register model is a lossless projection of the document: taking a mountain apart into
 * registers and putting it back gives the same mountain, every kind of register survives the trip, and a
 * topology edit — the one thing registers do not own — leaves the model naming exactly the geometry that is
 * still there.
 *
 * The second is that a hash of a document answers for the mountain rather than for the route the mountain
 * arrived by. An uncanonicalized check reports drift constantly and is quickly ignored, so the same document
 * is built twice by different routes — parsed off a stored file, and assembled by assigning registers onto an
 * empty shell — and is required to hash identically while `JSON.stringify` over the two disagrees.
 *
 * The third is what the model is for once two documents exist rather than one (docs/040): comparing them says
 * what changed in words, and putting part of one back is a set of ordinary assignments computed from the
 * difference rather than anything stored.
 */
import { createHash } from 'node:crypto';
import { collisionLabMountain } from '../src/core/collision/lab';
import { canonicalJson, canonicalNumber } from '../src/core/doc/canonical';
import {
  changeSummary, describeChanges, documentDiff, revertAssignments,
} from '../src/core/doc/compare';
import { digestDocument, divergentSections, updateDigest, TOPOLOGY_SECTION } from '../src/core/doc/digest';
import { getVertex } from '../src/core/doc/doc-edit';
import { nextGemId, tombstoned } from '../src/core/doc/ids';
import { migrateMountain } from '../src/core/doc/mountain';
import {
  applyRegisters, COURSE_REGISTER, documentRegisters, documentSections, globalRegister, handleRegister,
  objectRegister, quadRegister, readRegister, registerSection, registerShell, sectionRegisters,
  vertexRegister, writeRegister, REGISTER_CHUNK, type RegisterKey, type RegisterValue,
} from '../src/core/doc/registers';
import { serializeMountain } from '../src/core/doc/serialize';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import { createFogVolume } from '../src/core/particles/volumes';
import type { EffectsDocument } from '../src/core/effects/document';
import type { AuthoredLight, QuadMeshDoc, V3 } from '../src/core/doc/types';
import { check, failures } from './check';

/** The one hash both ends of every comparison here agree on. `src/core` carries no crypto, so it is handed in. */
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** What the project service names a document by: sha256 over its canonical text. */
const hashDocument = (doc: unknown): string => sha256(canonicalJson(doc));

/** A register's value as it would arrive over a wire — JSON, and therefore nothing shared with the document
 *  it came out of, so a round trip that passes did so by placing values rather than by aliasing them. */
const wire = (registers: Iterable<readonly [RegisterKey, RegisterValue]>): [RegisterKey, RegisterValue][] =>
  [...registers].map(([key, value]) => [key, JSON.parse(JSON.stringify(value)) as RegisterValue]);

// ---- one real document, carrying one of everything ---------------------------------------------------------

/** The effects document's own fields, without the eight tables that decompose into registers of their own. */
function effectsHeader(effects: EffectsDocument): RegisterValue {
  const { slots: _s, graphs: _g, functions: _f, objectProperties: _o, instances: _i, physics: _p,
    collisionModels: _c, splines: _x, ...header } = effects;
  return header;
}

/** A small effects graph with nodes in it, so the finest object grain docs/039 names has something to hold. */
function labEffects(level: string): EffectsDocument {
  return {
    $schema: 'openslope-effects-v1.schema.json', kind: 'openslope-effects', version: 1,
    target: { game: 'ssx-tricky', platform: 'ps2', region: 'pal', level },
    header: { U1: 1966592, U2: 1053952, U3: 0.006 },
    slots: [{
      id: 'slot:0000', name: 'gate',
      circumstances: {
        persistent: 'graph:0000', collision: null, slot3: null, slot4: null, trigger: null, slot6: null, slot7: null,
      },
    }],
    graphs: [{
      id: 'graph:0000', name: 'spin', nodes: [
        { id: 'node:0000', mainType: 4, payload: { type4: { Frames: 30 } } },
        { id: 'node:0001', mainType: 14, payload: { multiplier: 2 } },
        { id: 'node:0002', mainType: 4, payload: { type4: { Frames: 12 } } },
      ],
    }],
    functions: [{ id: 'fn:0000', name: 'reset', nodes: [{ id: 'node:0100', mainType: 13, payload: {} }] }],
    objectProperties: [], instances: [], physics: [], collisionModels: [], splines: [],
    extensions: {},
  };
}

/**
 * The collision lab — a generated mountain of a few thousand corners, already carrying props, paint and a run
 * — decorated with the register kinds a generated slope has no reason to have. Every family the projection
 * knows about is therefore non-empty exactly once, and the mesh is several chunks wide.
 */
function labMountain(): QuadMeshDoc {
  const doc = collisionLabMountain('REGISTERS');
  const vertex = (at: number): V3 => getVertex(doc, at);
  doc.edgeHandles = {};
  for (const [from, to] of [[0, 1], [1, 0], [40, 41], [900, 901]]) {
    doc.edgeHandles[`${from}>${to}`] = [0.5, 1.25, -0.75];
  }
  doc.quadTex = { 3: 'DONOR/0012.png', 900: 'DONOR/0044.png' };
  doc.quadOrient = { 3: { rot: 1, mirror: true } };
  doc.quadLocked = { 11: true };
  doc.quadTwist = { 7: [[0.1, 0, 0], [0, 0.2, 0], [0, 0, 0.3], [-0.1, 0, 0]] };
  doc.lights = [
    { kind: 'point', pos: vertex(10), color: '#ffd0a0', intensity: 2.5, reach: 40, name: 'lamp' },
    { kind: 'spot', pos: vertex(20), dir: [0, -1, 0], color: '#a0d0ff', intensity: 1, reach: 25, cone: 30 },
  ];
  doc.rails = [{ nodes: [vertex(30), vertex(31), vertex(32)], height: 2, style: 13, name: 'kink' }];
  doc.gems = [{ pos: vertex(40), value: 2 }, { pos: vertex(41) }];
  doc.models = [{
    id: 'model:0001', name: 'crate', anchor: [0, 0, 0],
    vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1], quads: [[0, 1, 2, 3]], texture: 'DONOR/0007.png',
  }];
  doc.particleVolumes = [createFogVolume(vertex(50))];
  doc.skybox = { source: { kind: 'level', level: 'DONOR' }, on: true, topColor: '#4488cc' };
  doc.raceMusic = 'anthem.wav';
  doc.raceMusicArrangement = { mode: 'linear-loop', bpm: 128, loopStartSeconds: 4.5, loopEndSeconds: 0 };
  doc.boardSound = { enabled: true, volume: 0.8, glide: 0.5, carve: 0.6, transients: 0.7, cues: 0.9 };
  doc.aiSeed = 7;
  doc.effects = labEffects('REGISTERS');
  // Through migration once, so the props and rails carry the ids the document gives them and the effects
  // graph is the validated one — this is a mountain the editor could have saved.
  return migrateMountain(doc);
}

const mountain = labMountain();
const clone = (doc: QuadMeshDoc): QuadMeshDoc => structuredClone(doc);

console.log(`\n-- a mountain of ${mountain.vertexIds.length} corners, ${mountain.quadIds.length} patches, `
  + `${documentRegisters(mountain).size} registers --`);

// ---- the projection is lossless ----------------------------------------------------------------------------
{
  const registers = wire(documentRegisters(mountain));
  const rebuilt = registerShell(mountain);
  const counts = applyRegisters(rebuilt, registers);
  check(counts.landed === registers.length && counts.retired === 0 && counts.refused === 0,
    `every one of the ${registers.length} registers lands on the shell`);
  check(canonicalJson(rebuilt) === canonicalJson(mountain),
    'decompose → recompose is the identity on a real document');
  // The channel that fails silently: a crease that went missing shows up as terrain quietly changing shape,
  // so the count is held rather than assumed (docs/039).
  check(Object.keys(rebuilt.edgeHandles ?? {}).length === Object.keys(mountain.edgeHandles ?? {}).length,
    `all ${Object.keys(mountain.edgeHandles ?? {}).length} creases survive the round trip by count`);

  const shell = registerShell(mountain);
  check(shell.vertexIds.length === mountain.vertexIds.length && shell.quads.length === mountain.quads.length
    && canonicalJson(shell.quads) === canonicalJson(mountain.quads),
    'the shell keeps the topology the register model does not own');
  // What is left is what a mountain cannot be without: a position per corner, its run, and the three globals
  // its type requires. No crease, no painted face, no object.
  check(canonicalJson([...documentRegisters(shell).keys()].filter(key => !key.startsWith('v/')).sort())
    === canonicalJson([COURSE_REGISTER, 'g/baseSurface', 'g/name', 'g/spacing'])
    && shell.vertices.every(part => part === 0),
    'and holds nothing else the register model owns, every corner sitting at the origin');
}

// ---- every register kind round-trips -----------------------------------------------------------------------
{
  const doc = clone(mountain);
  const vertexId = doc.vertexIds[5], quadId = doc.quadIds[9];
  const kinds: [string, RegisterKey, RegisterValue][] = [
    ['a vertex position', vertexRegister(vertexId), [12.5, -3.25, 7.125]],
    ['an edge handle', handleRegister(doc.vertexIds[0], doc.vertexIds[1]), [1, 2, 3]],
    ['quad paint', quadRegister(quadId, 'paint'), 5],
    ['a quad tile', quadRegister(quadId, 'tex'), 'MERQUER/0101.png'],
    ['a tile orientation', quadRegister(quadId, 'orient'), { rot: 2, mirror: false }],
    ['a patch lock', quadRegister(quadId, 'lock'), true],
    ['a quad twist', quadRegister(quadId, 'twist'), [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]]],
    ['a prop', objectRegister('prop', doc.props![2].id!), { ...doc.props![2], pos: [1, 2, 3] }],
    ['a light', objectRegister('light', doc.lights![1].id!), { ...doc.lights![1], intensity: 9 }],
    ['a rail', objectRegister('rail', doc.rails![0].id!), { ...doc.rails![0], height: 6 }],
    ['a gem', objectRegister('gem', doc.gems![0].id!), { id: doc.gems![0].id!, pos: [4, 5, 6], value: 3 }],
    ['a model', objectRegister('model', 'model:0001'), { ...doc.models![0], name: 'barrel' }],
    ['a particle volume', objectRegister('volume', doc.particleVolumes![0].id),
      { ...doc.particleVolumes![0], name: 'Fog_Bank' }],
    ['the effects header', objectRegister('effect', 'document'), effectsHeader(labEffects('OTHER'))],
    ['an effects table row', objectRegister('effect', 'graphs/graph:0000'), { id: 'graph:0000', name: 'renamed' }],
    ['an effect node', objectRegister('effect-node', 'graphs/graph:0000/node:0001'),
      { id: 'node:0001', mainType: 14, payload: { multiplier: 5 } }],
    ['the course path', COURSE_REGISTER, { ...doc.course, blend: 44 }],
    ['a global', globalRegister('name'), 'RENAMED'],
    ['the sun', globalRegister('sun'), { ...doc.sun!, el: 12, bakeExposure: 0.5 }],
    ['the skybox', globalRegister('skybox'), { source: { kind: 'custom', name: 'dusk' }, on: false }],
    ['the music', globalRegister('raceMusic'), 'other.wav'],
  ];
  for (const [what, key, value] of kinds) {
    const outcome = writeRegister(doc, key, value);
    const back = readRegister(doc, key);
    check(outcome === 'landed' && canonicalJson(back) === canonicalJson(value), `${what} round-trips`);
  }
  // The register the value actually reached, read the way the rest of the editor reads it.
  check(canonicalJson(getVertex(doc, 5)) === canonicalJson([12.5, -3.25, 7.125]),
    'a vertex register writes the position buffer itself');
  check(doc.effects!.graphs[0].nodes.length === 3 && doc.effects!.graphs[0].name === 'renamed',
    'replacing a graph leaves the nodes hanging off it where they are');

  check(writeRegister(doc, quadRegister(quadId, 'tex'), undefined) === 'landed'
    && readRegister(doc, quadRegister(quadId, 'tex')) === undefined,
    'assigning nothing clears a register that can be absent');
  check(writeRegister(doc, objectRegister('gem', doc.gems![1].id!), undefined) === 'landed' && doc.gems!.length === 1,
    'and removes a whole object');
  check(writeRegister(doc, vertexRegister(vertexId), undefined) === 'refused',
    'but is refused for a position, which a mountain always has one of per corner');
  check(writeRegister(doc, vertexRegister('local:999999'), [0, 0, 0]) === 'refused',
    'a name this document has never carried is refused');
  check(writeRegister(doc, globalRegister('quads'), []) === 'refused',
    'and topology cannot be reached through a global register');
}

// ---- a light and a gem are named, not numbered ---------------------------------------------------------------
{
  const doc = clone(mountain);
  const [below, above] = doc.lights!;
  check(!!below.id && !!above.id
    && objectRegister('light', below.id!) !== objectRegister('light', above.id!),
    'two lights are two registers');
  writeRegister(doc, objectRegister('light', above.id!), { ...above, intensity: 7 });
  check((readRegister(doc, objectRegister('light', below.id!)) as AuthoredLight).intensity === below.intensity,
    'so writing one leaves the other holding what it held');

  // The failure ids remove: keyed by position, deleting the light BELOW renumbers every light above it, and an
  // edit in flight for one of them lands on a different light than the one its author was looking at.
  check(writeRegister(doc, objectRegister('light', below.id!), undefined) === 'landed' && doc.lights!.length === 1,
    'deleting a light removes exactly that light');
  const survivor = readRegister(doc, objectRegister('light', above.id!)) as AuthoredLight | undefined;
  check(!!survivor && survivor.intensity === 7 && doc.lights!.indexOf(survivor) === 0,
    'and the one above it answers to the same register at its new position in the list');
  check(readRegister(doc, objectRegister('light', '1')) === undefined,
    'while the position it used to sit at names nothing');

  const kept = doc.gems![1];
  writeRegister(doc, objectRegister('gem', doc.gems![0].id!), undefined);
  check(canonicalJson(readRegister(doc, objectRegister('gem', kept.id!))) === canonicalJson(kept),
    'and a gem survives the gem below it the same way');
}

// ---- canonical text ----------------------------------------------------------------------------------------
{
  check(canonicalJson({ b: 1, a: 2 }) === canonicalJson({ a: 2, b: 1 }),
    'canonical text is insensitive to key insertion order');
  check(JSON.stringify({ b: 1, a: 2 }) !== JSON.stringify({ a: 2, b: 1 }),
    'which JSON.stringify, the thing being replaced, is not');
  check(canonicalNumber(0.1 + 0.2) === canonicalNumber(0.3),
    'a float that arrived by a different route reads as the value it holds');
  check(String(0.1 + 0.2) !== String(0.3), 'which its shortest round-trip text does not');
  check(canonicalNumber(-0) === '0' && canonicalNumber(0) === '0', 'negative zero is the place zero is');
  check(canonicalNumber(NaN) === 'null' && canonicalNumber(Infinity) === 'null',
    'and a number JSON cannot carry reads as the null a reader would see');
  check(canonicalNumber(229.88441086930163) === '229.884410869',
    'nine decimals is a nanometre in editor metres');
  check(canonicalNumber(1) === '1' && canonicalNumber(-2.5) === '-2.5' && canonicalNumber(1e-12) === '0',
    'and the text is the shortest fixed form of the rounded value');

  const nudged = clone(mountain);
  nudged.vertices[0] += 1e-12;
  check(hashDocument(nudged) === hashDocument(mountain),
    'a document differing by less than a nanometre is the same document');
  const moved = clone(mountain);
  moved.vertices[0] += 1e-5;
  check(hashDocument(moved) !== hashDocument(mountain), 'and one differing by a hundredth of a millimetre is not');
}

// ---- two routes to one document ----------------------------------------------------------------------------
{
  // Route one: off disk. Stored by id, parsed back, and named by index again — the load path exactly.
  const stored = JSON.parse(JSON.stringify(serializeMountain(clone(mountain)))) as unknown;
  const fromDisk = migrateMountain(stored);

  // Route two: assembled. Every register assigned onto an empty shell, with the ones whose order is not data
  // — corners, creases, faces, globals — arriving backwards, because arrival order is the thing being denied.
  const registers = wire(documentRegisters(mountain));
  const ordered = registers.filter(([key]) => key.startsWith('o/') || key === COURSE_REGISTER);
  const shuffled = registers.filter(([key]) => !(key.startsWith('o/') || key === COURSE_REGISTER)).reverse();
  const assembled = registerShell(clone(mountain));
  applyRegisters(assembled, [...ordered, ...shuffled]);

  check(hashDocument(fromDisk) === hashDocument(assembled),
    'a document read off disk and the same document assembled from registers hash identically');
  check(JSON.stringify(fromDisk) !== JSON.stringify(assembled),
    'while the text JSON.stringify gives the two differs, which is the drift an uncanonicalized check reports');
  const digests = [digestDocument(fromDisk, sha256), digestDocument(assembled, sha256)];
  check(digests[0].root === digests[1].root && divergentSections(digests[0], digests[1]).length === 0,
    'and every section of the two agrees, root included');
}

// ---- two levels: the root says that, the sections say where -------------------------------------------------
{
  const mine = clone(mountain);
  const theirs = clone(mountain);
  // A corner in the second chunk, so the answer is a chunk rather than "the vertices".
  const at = REGISTER_CHUNK + 17;
  const moved: V3 = [getVertex(theirs, at)[0] + 3, getVertex(theirs, at)[1], getVertex(theirs, at)[2]];
  writeRegister(theirs, vertexRegister(theirs.vertexIds[at]), moved);

  const ours = digestDocument(mine, sha256), yours = digestDocument(theirs, sha256);
  check(ours.root !== yours.root, 'a moved corner reaches the root');
  const divergent = divergentSections(ours, yours);
  check(divergent.length === 1 && divergent[0] === `vertices/${String(1).padStart(6, '0')}`,
    `one descent names the divergent chunk and nothing else (${divergent.join(', ') || 'none'})`);
  check(Object.keys(ours.sections).length > 8 && divergent.length === 1,
    `every one of the other ${Object.keys(ours.sections).length - 1} sections is untouched`);
  const refetch = sectionRegisters(theirs, divergent[0]);
  check(refetch.has(vertexRegister(theirs.vertexIds[at]))
    && canonicalJson(refetch.get(vertexRegister(theirs.vertexIds[at]))) === canonicalJson(moved),
    'and the chunk it names carries the register that moved');
  check(refetch.size <= REGISTER_CHUNK, `refetching it costs ${refetch.size} registers, not the mountain`);

  check(new Set([...documentSections(mine).keys()]).size === Object.keys(ours.sections).length - 1,
    'the digest is the sections plus the one for the topology registers do not own');
  const cut = clone(mountain);
  cut.quads[0] = [...cut.quads[0]].reverse();
  check(divergentSections(ours, digestDocument(cut, sha256)).join() === TOPOLOGY_SECTION,
    'a change to the topology reaches that section and only it');

  const savedTJunction = clone(mountain);
  const [hostA, hostB, embedded] = savedTJunction.quads[0];
  savedTJunction.tJunctions = [{ vertex: embedded, edge: [hostA, hostB], t: 0.25 }];
  const reseatedTJunction = clone(savedTJunction);
  reseatedTJunction.tJunctions![0].t = 0.750000137;
  check(digestDocument(savedTJunction, sha256).root === digestDocument(reseatedTJunction, sha256).root,
    're-fitting a T-junction parameter during render does not report topology drift');
  reseatedTJunction.tJunctions![0].edge = [hostA, savedTJunction.quads[0][3]];
  check(divergentSections(digestDocument(savedTJunction, sha256), digestDocument(reseatedTJunction, sha256))
    .join() === TOPOLOGY_SECTION,
    'while changing which edge hosts the T-junction still reaches the topology section');
}

// ---- incremental maintenance ---------------------------------------------------------------------------------
{
  const doc = clone(mountain);
  let digest = digestDocument(doc, sha256);
  const edits: [string, RegisterKey, RegisterValue][] = [
    ['a corner in the first chunk', vertexRegister(doc.vertexIds[3]), [1, 2, 3]],
    ['a corner in the third chunk', vertexRegister(doc.vertexIds[2 * REGISTER_CHUNK + 5]), [4, 5, 6]],
    ['a crease', handleRegister(doc.vertexIds[0], doc.vertexIds[1]), [9, 9, 9]],
    ['a crease cleared', handleRegister(doc.vertexIds[1], doc.vertexIds[0]), undefined],
    ['paint', quadRegister(doc.quadIds[11], 'paint'), 9],
    ['a tile cleared', quadRegister(doc.quadIds[900], 'tex'), undefined],
    ['a prop moved', objectRegister('prop', doc.props![0].id!), { ...doc.props![0], pos: [7, 8, 9] }],
    ['a light removed', objectRegister('light', doc.lights![1].id!), undefined],
    ['a gem added', objectRegister('gem', nextGemId(doc.gems!)),
      { id: nextGemId(doc.gems!), pos: [1, 1, 1] }],
    ['an effect node', objectRegister('effect-node', 'graphs/graph:0000/node:0000'),
      { id: 'node:0000', mainType: 4, payload: { type4: { Frames: 60 } } }],
    ['the run', COURSE_REGISTER, { ...doc.course, surface: 3 }],
    ['the sun', globalRegister('sun'), { ...doc.sun!, el: 41 }],
    ['the music cleared', globalRegister('raceMusic'), undefined],
  ];
  let maintained = true;
  for (const [what, key, value] of edits) {
    const outcome = writeRegister(doc, key, value);
    digest = updateDigest(doc, digest, [key], sha256);
    const full = digestDocument(doc, sha256);
    const same = digest.root === full.root && canonicalJson(digest.sections) === canonicalJson(full.sections);
    if (!same || outcome !== 'landed') { maintained = false; check(false, `maintaining ${what} matches a full rehash`); }
  }
  check(maintained, `${edits.length} edits maintained one section at a time, each matching a full rehash`);
  check(Object.keys(digest.sections).includes('objects/gem')
    && !Object.keys(digest.sections).includes('globals/raceMusic'),
    'a section a register was cleared out of leaves the digest, and a section one arrived in joins it');

  // Which is only interesting if maintaining one section really did leave the rest alone.
  const before = digestDocument(mountain, sha256);
  const one = clone(mountain);
  const key = vertexRegister(one.vertexIds[REGISTER_CHUNK * 2 + 1]);
  writeRegister(one, key, [0, 0, 0]);
  const after = updateDigest(one, before, [key], sha256);
  const touched = Object.keys(after.sections).filter(name => after.sections[name] !== before.sections[name]);
  check(touched.length === 1 && touched[0] === registerSection(one, key),
    'a single corner move rehashes one chunk rather than the mountain');
}

// ---- a topology edit, which registers do not own --------------------------------------------------------------
{
  const before = clone(mountain);
  const paintedQuad = before.quadIds[9];
  writeRegister(before, quadRegister(paintedQuad, 'paint'), 5);
  const goneQuad = before.quadIds[0], goneVertex = before.vertexIds[0];
  const result = applyMeshDelete(before, { vertices: [], edges: [], quads: [0] });
  if (!result.ok) throw new Error(result.error);
  const after = result.doc;

  check(tombstoned(after, goneQuad), 'the deleted patch is retired rather than forgotten');
  check(writeRegister(after, quadRegister(goneQuad, 'paint'), 3) === 'retired',
    'so an edit naming it is discarded quietly rather than resurrecting it');
  check(writeRegister(after, vertexRegister(goneVertex), [0, 0, 0]) === 'retired',
    'and so is one naming a corner it took with it');
  check(after.quadIds.indexOf(paintedQuad) !== 9 && readRegister(after, quadRegister(paintedQuad, 'paint')) === 5,
    'a face that was renumbered keeps its paint, because the register is its id and not its index');

  const registers = wire(documentRegisters(after));
  const rebuilt = registerShell(after);
  const counts = applyRegisters(rebuilt, registers);
  check(counts.refused === 0 && counts.retired === 0 && canonicalJson(rebuilt) === canonicalJson(after),
    'and the projection is still lossless over the edited mountain');

  check(registerSection(after, quadRegister(goneQuad, 'paint')) === null,
    'a retired name belongs to no chunk, since the numbering moved under it');
  const stale = digestDocument(before, sha256);
  const rehashed = updateDigest(after, stale, [quadRegister(goneQuad, 'paint')], sha256);
  check(canonicalJson(rehashed) === canonicalJson(digestDocument(after, sha256)),
    'so maintaining the digest across one falls back to hashing the whole document');
}

// ---- comparing two documents, and putting part of one back (docs/040) ----------------------------------------
//
// A known pair: one edit of every kind the summary counts, so the counts are checked against a number written
// out by hand rather than against whatever the code happens to produce.
{
  const was = clone(mountain);
  const now = clone(mountain);
  const movedCorners = [4, 5, 6].map(at => now.vertexIds[at]);
  for (const id of movedCorners) writeRegister(now, vertexRegister(id), [1, 2, 3]);
  now.edgeHandles!['2>3'] = [0.25, 0.25, 0.25];            // a crease added
  delete now.edgeHandles!['1>0'];                           // one removed
  now.edgeHandles!['40>41'] = [9, 9, 9];                    // one changed
  writeRegister(now, quadRegister(now.quadIds[1], 'paint'), 6);
  writeRegister(now, quadRegister(now.quadIds[2], 'paint'), 6);
  writeRegister(now, quadRegister(now.quadIds[1], 'tex'), 'DONOR/0099.png');
  writeRegister(now, quadRegister(now.quadIds[1], 'lock'), true);
  writeRegister(now, objectRegister('light', now.lights![1].id!), undefined);           // one vanished
  writeRegister(now, objectRegister('prop', now.props![0].id!), { ...now.props![0], pos: [7, 8, 9] });
  const freshGem = nextGemId(now.gems!);
  writeRegister(now, objectRegister('gem', freshGem), { id: freshGem, pos: [5, 5, 5] }); // one appeared
  writeRegister(now, COURSE_REGISTER, { ...now.course, blend: 42 });
  writeRegister(now, globalRegister('name'), 'AFTER');
  writeRegister(now, globalRegister('aiSeed'), 9);
  writeRegister(now, globalRegister('raceMusic'), undefined);

  const summary = changeSummary(was, now);
  check(summary.vertices.moved === 3 && summary.vertices.added === 0 && summary.vertices.removed === 0,
    'the summary counts the corners that moved, and says no corner came or went');
  check(summary.creases.added === 1 && summary.creases.removed === 1 && summary.creases.changed === 1,
    'and the creases added, removed and reshaped, each as its own kind');
  check(summary.quads.paint === 2 && summary.quads.tex === 1 && summary.quads.lock === 1 && summary.quads.faces === 2
    && summary.quads.added === 0 && summary.quads.removed === 0,
    'and which faces were repainted, retextured and locked, over two faces rather than four registers');
  const objects = Object.fromEntries(summary.objects.map(entry => [entry.family, entry]));
  check(objects.light?.removed === 1 && objects.gem?.added === 1 && objects.prop?.changed === 1
    && summary.objects.length === 3,
    'and which objects appeared, vanished and were edited, by family, with untouched families absent');
  check(summary.course && canonicalJson(summary.globals) === canonicalJson(['aiSeed', 'name', 'raceMusic']),
    'and that the run moved, and exactly which globals differ');
  check(summary.registers === 3 + 3 + 4 + 3 + 1 + 3,
    `every register that differs is accounted for once (${summary.registers})`);
  const said = describeChanges(summary).join(' · ');
  check(said.includes('3 corners moved') && said.includes('2 faces repainted')
    && said.includes('1 face retextured') && said.includes('1 face lock changed') && said.includes('1 gem appeared')
    && said.includes('1 light vanished') && said.includes('the run changed')
    && said.includes('aiSeed, name, raceMusic differ'),
    `and it reads as a sentence rather than a diff — “${said}”`);
  check(describeChanges(changeSummary(was, clone(was))).length === 0,
    'while two documents holding the same values have nothing to say about each other');

  // Reverting the lot: every register the two disagreed about, assigned the older document's value.
  const whole = clone(now);
  const wholeCount = applyRegisters(whole, revertAssignments(documentDiff(was, whole)));
  check(wholeCount.refused === 0 && wholeCount.retired === 0 && documentDiff(was, whole).size === 0,
    'reverting everything that differs puts every register back, as ordinary assignments and nothing else');

  // Scoped to one author's registers, as the room names them.
  const bobsWork = [vertexRegister(movedCorners[0]), quadRegister(now.quadIds[1], 'paint')];
  const scoped = clone(now);
  const byKeys = revertAssignments(documentDiff(was, scoped), { keys: bobsWork });
  applyRegisters(scoped, byKeys);
  check(byKeys.length === 2
    && canonicalJson(readRegister(scoped, bobsWork[0])) === canonicalJson(readRegister(was, bobsWork[0]))
    && readRegister(scoped, bobsWork[1]) === readRegister(was, bobsWork[1]),
    'a revert scoped to a set of registers puts back exactly those');
  check(canonicalJson(readRegister(scoped, vertexRegister(movedCorners[1]))) === canonicalJson([1, 2, 3])
    && readRegister(scoped, globalRegister('name')) === 'AFTER'
    && documentDiff(was, scoped).size === summary.registers - 2,
    'and leaves every register outside the scope exactly where the later document had it');

  // Scoped to a selection of geometry, which covers the creases between two selected corners and nothing else.
  const selected = clone(now);
  const corners = [now.vertexIds[4], now.vertexIds[2], now.vertexIds[3]];
  const bounded = revertAssignments(documentDiff(was, selected), {
    vertices: corners, quads: [now.quadIds[1]],
  });
  applyRegisters(selected, bounded);
  const touched = new Set(bounded.map(([key]) => key));
  check(touched.has(vertexRegister(corners[0])) && touched.has(handleRegister(corners[1], corners[2]))
    && touched.has(quadRegister(now.quadIds[1], 'paint')) && touched.has(quadRegister(now.quadIds[1], 'tex'))
    && touched.has(quadRegister(now.quadIds[1], 'lock')),
    'a selection-bounded revert reaches its corners, its faces, and the creases running between two of them');
  check(!touched.has(vertexRegister(movedCorners[1])) && !touched.has(quadRegister(now.quadIds[2], 'paint'))
    && ![...touched].some(key => key.startsWith('o/') || key.startsWith('g/') || key === COURSE_REGISTER)
    && bounded.length === 5,
    'and reaches nothing else — not the corners beside it, and not the props, the run or the globals');

  // The one thing a revert deliberately cannot do: registers are values, not structure.
  const cut = applyMeshDelete(clone(now), { quads: [0] });
  if (!cut.ok) throw new Error(cut.error);
  const structural = changeSummary(now, cut.doc);
  check(structural.quads.removed === 1 && structural.vertices.removed > 0
    && structural.quads.added === 0,
    'a face somebody deleted is counted as a face gone, which the registers alone could not have said');
  const back = revertAssignments(documentDiff(now, cut.doc));
  const outcome = applyRegisters(clone(cut.doc), back);
  check(outcome.retired > 0 && outcome.refused === 0,
    'and reverting it retires quietly rather than resurrecting geometry: topology is not a register');
}

console.log(failures ? '\nREGISTERS: FAIL' : '\nREGISTERS: PASS');
process.exit(failures ? 1 : 0);
