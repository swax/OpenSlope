// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createAiPathRecording, AI_RECORDING_DEFAULTS } from '../src/app/ride/ai-path-recording';
import type { RideTelemetryTick } from '../src/app/ride/telemetry';
import {
  appendRecordedAiPaths,
  authoredAiNetwork,
  authoredAiDisplayPaths,
  moveAiPathNode,
} from '../src/core/doc/ai-paths';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { serializeMountain } from '../src/core/doc/serialize';
import { buildLevelFiles } from '../src/core/export/level';
import { aiJumpMarkers, reconstructPathLine } from '../src/core/reference/terrain';
import { createRideModel } from '../src/app/ride/physics';
import { createAiRiders } from '../src/app/ride/ai';
import { documentRegisters, applyRegisters, objectRegister } from '../src/core/doc/registers';
import { courseSpeedLines } from '../src/app/ride/mountain-speed';

const tick = (z: number, charging = false, grounded = true, x = 0): RideTelemetryTick =>
  ({
    dt: 1 / 60,
    opening: { speed: 20 },
    closing: { position: [x, -z / 5, z], speed: 20, charging, grounded, railIndex: -1 },
  }) as RideTelemetryTick;

const recording = createAiPathRecording();
recording.start();
for (let z = 0; z <= 650; z += 0.5) recording.ingest(tick(z, z >= 220 && z < 244, !(z >= 244 && z < 270)));
const sections = recording.finish();
assert.equal(sections.length, 3);
assert(sections[0].points.at(-1)![2] >= 270, 'A section waits for landing rather than splitting through a jump');
for (let i = 1; i < sections.length; i++) assert(sections[i].points[0][2] < sections[i - 1].points.at(-1)![2] - 15);
const jump = sections[0].events.find(e => e.type === 100)!;
assert(
  jump && Math.abs(jump.start - 220) < 0.01 && Math.abs(jump.end - 244.5) < 0.01,
  'Charge/release become a full jump range with end-lookahead compensation',
);
assert.equal(jump.value >>> 2, 72);
assert(
  sections.every(s => s.events.every(e => e.type === 100)),
  'Recording emits only jump events, without cruise-speed events',
);
const spacings = sections.flatMap(s => s.points.slice(1).map((p, i) => p[2] - s.points[i][2]));
assert(spacings.reduce((a, b) => a + b) / spacings.length > 7, 'Straight routes use sparse distance samples');
assert(Math.max(...spacings) <= AI_RECORDING_DEFAULTS.spacing + 0.51);

recording.start();
for (let z = 0; z <= 35; z += 0.5) recording.ingest(tick(z));
recording.breakPath();
for (let z = 1000; z <= 1040; z += 0.5) recording.ingest(tick(z));
const separated = recording.finish();
assert.equal(separated.length, 2);
assert(
  separated.every(s => s.events.length === 0),
  'A run without jumps records geometry without events',
);
assert(
  separated.every(s => s.points.at(-1)![2] - s.points[0][2] < 50),
  'Reset gaps do not become traversable path segments',
);

recording.start();
for (let z = 0; z <= 50; z += 0.5) recording.ingest(tick(z, z >= 35));
assert(recording.finish()[0].points.at(-1)![2] < 35, 'An interrupted charge is trimmed rather than authored as a jump');
recording.start();
for (let i = 0; i < 600; i++) recording.ingest(tick(0));
assert.deepEqual(recording.finish(), [], 'An idle/short recording creates no paths');

// A bend tighter than the nominal sample pitch retains enough detail for the recorded line.
recording.start();
for (let i = 0; i <= 80; i++) recording.ingest(tick(i / 2, false, true, 3 * Math.sin(i / 5)));
const curved = recording.finish()[0];
assert(curved.points.length > 8);

const doc = defaultMountain();
doc.aiPaths = appendRecordedAiPaths(undefined, sections);
doc.autoAiPaths = false;
const restored = migrateMountain(serializeMountain(doc));
assert.deepEqual(restored.aiPaths, doc.aiPaths, 'Paths and events survive a complete save/reload');
assert.equal(restored.autoAiPaths, false, 'The generated-path option survives save/reload');
assert.equal(
  documentRegisters(doc).get('g/autoAiPaths'),
  false,
  'The generated-path option participates in shared edits',
);
const recordedOnly = authoredAiNetwork(doc.course, doc.aiSeed, doc.aiPaths, true, false);
assert.deepEqual(recordedOnly.paths, doc.aiPaths);
assert.equal(recordedOnly.starts.length, 6);
assert(recordedOnly.starts.every(index => index >= 0 && index < doc.aiPaths!.length));
assert.deepEqual(authoredAiNetwork(doc.course, doc.aiSeed, [], true, false), { paths: [], starts: [] });
assert.deepEqual(authoredAiDisplayPaths(doc.course, 1, doc.aiPaths, false), doc.aiPaths);
assert.equal(
  courseSpeedLines(doc.course, 1, false).length,
  1,
  'Predicted speed also excludes disabled generated routes',
);
for (const name of ['AIP.json', 'SOP.json']) {
  const data = JSON.parse(buildLevelFiles(doc).text[name]);
  assert.deepEqual(
    data.AIPaths.map((path: { Name: string }) => path.Name),
    doc.aiPaths.map(path => path.name),
    'Export excludes generated routes and the generated respawn spine',
  );
  const empty = JSON.parse(buildLevelFiles({ ...doc, aiPaths: [] }).text[name]);
  assert.deepEqual(empty.AIPaths, []);
  assert.deepEqual(empty.StartPosList, []);
}
doc.autoAiPaths = true;

const originalPath = {
  ...doc.aiPaths[0],
  points: [
    [0, 0, 0],
    [0, 0, 10],
    [0, 0, 20],
  ] as [number, number, number][],
  events: [{ type: 100, value: 288, start: 5, end: 15 }],
};
const moved = moveAiPathNode(originalPath, 1, [10, 2, 10]);
assert.deepEqual(originalPath.points[1], [0, 0, 10], 'Editing does not mutate history snapshots');
assert.deepEqual(moved.points[1], [10, 2, 10]);
assert(Math.abs(moved.events[0].start - Math.sqrt(200) / 2) < 1e-9);
assert(
  Math.abs(moved.events[0].end - Math.sqrt(200) * 1.5) < 1e-9,
  'Jump ranges retain their positions within the edited segments',
);
assert.strictEqual(moveAiPathNode(originalPath, -1, [1, 2, 3]), originalPath);
assert.strictEqual(moveAiPathNode(originalPath, 1, [NaN, 2, 3]), originalPath);
const collapsed = moveAiPathNode(originalPath, 1, [0, 0, 0]);
assert(collapsed.events.every(event => Number.isFinite(event.start) && event.start <= event.end));
const appended = appendRecordedAiPaths(doc.aiPaths, separated);
assert.equal(new Set(appended.map(p => p.id)).size, appended.length);
const registers = documentRegisters(doc);
assert(
  registers.has(objectRegister('ai-path', doc.aiPaths[0].id)) && !registers.has('g/aiPaths'),
  'Each recorded section is an independent shared-edit object',
);
const replica = defaultMountain();
const other = appendRecordedAiPaths(undefined, separated)[0];
replica.aiPaths = [other];
applyRegisters(replica, [[objectRegister('ai-path', doc.aiPaths[0].id), doc.aiPaths[0]]]);
assert.equal(replica.aiPaths.length, 2, 'Adding one section preserves another participant’s trail');
const network = authoredAiNetwork(doc.course, doc.aiSeed, doc.aiPaths);
assert.equal(network.starts.length, 6);
assert(network.paths.length >= 6 + sections.length);
const files = buildLevelFiles(doc);
for (const name of ['AIP.json', 'SOP.json']) {
  const paths = JSON.parse(files.text[name]);
  assert.equal(paths.StartPosList.length, 6);
  const saved = paths.AIPaths.find((p: { Name: string }) => p.Name === doc.aiPaths![0].name);
  assert.deepEqual(
    reconstructPathLine(saved).map(p => p.map(v => (v === 0 ? 0 : v))),
    sections[0].points.map(p => p.map(v => (v === 0 ? 0 : v))),
    'Portable paths retain their seed and geometry',
  );
  assert(Math.abs(aiJumpMarkers(saved)[0].end - jump.end) < 0.001);
}

// Record a real rider, then let an autonomous rider follow that capture through the same physics.
const positions: number[] = [],
  indices: number[] = [];
for (let z = 0; z <= 800; z += 4) positions.push(-60, -z * 0.2, z, 60, -z * 0.2, z);
for (let i = 0; i < 200; i++) {
  const a = i * 2;
  indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
}
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geometry.setIndex(indices);
const terrain = new THREE.Mesh(geometry);
terrain.updateMatrixWorld(true);
recording.start();
const model = createRideModel({
  terrain,
  surfaceOf: () => 1,
  spawn: new THREE.Vector3(0, 0, 4),
  heading: new THREE.Vector3(0, 0, 1),
  oobFloorY: -300,
  keys: { left: false, right: false, tuck: true, brake: false, boost: false },
  stick: { active: false, x: 0 },
  onRespawn() {},
  onTelemetryTick: recording.ingest,
});
model.start();
let pressed = false,
  released = false;
for (let frame = 0; frame < 1800; frame++) {
  if (!pressed && model.st.pos.z >= 80 && model.st.grounded) {
    model.ollieDown();
    pressed = true;
  }
  if (pressed && !released && model.st.pos.z >= 104) {
    model.ollieUp();
    released = true;
  }
  model.step(1 / 60);
  if (model.st.pos.z > 350 && model.st.grounded) break;
}
const ridden = recording.finish();
assert(ridden.length >= 2);
const paths = ridden.map(s => ({
  ...s,
  markers: s.events
    .filter(e => e.type === 100)
    .map(e => ({ arc: e.start, end: e.end, speed: (e.value >>> 2) / 3.6, trickA: false, trickB: false })),
  points: s.points.map(p => new THREE.Vector3(...p)),
}));
const ai = createAiRiders({
  terrain,
  surfaceOf: () => 1,
  paths,
  starts: [0],
  scene: new THREE.Group(),
  oobFloorY: -300,
});
let air = 0,
  firstRelease = Infinity,
  held = false;
for (let frame = 0; frame < 1800; frame++) {
  ai.step(1 / 60);
  const rider = ai.probe()[0];
  if (held && !rider.jumpHeld) firstRelease = Math.min(firstRelease, rider.pos.z);
  held = rider.jumpHeld;
  air = Math.max(air, rider.airTime);
  if (rider.pos.z > 300 && rider.grounded) break;
}
assert(
  firstRelease > 100 && firstRelease < 109 && air > 0.3,
  `The AI reproduces the recorded jump: release ${firstRelease}, air ${air}`,
);
assert(ai.probe()[0].pos.z > 300 && ai.probe()[0].path > 0, 'The AI crosses the automatic section handoff');
ai.dispose();
doc.course.knots = [4, 650].map(z => ({ pos: [0, -z * 0.2, z], width: 30, wall: 0, bank: 0, shoulder: 0 }));
// Recorded-only routing isolates capture fidelity. Automatic alternatives compete through the native
// six-box shortlist (covered by ai-path-choice.test), so selecting a recording there is not guaranteed.
const authored = authoredAiNetwork(doc.course, 1, appendRecordedAiPaths(undefined, ridden), true, false);
const gateField = createAiRiders({
  terrain,
  surfaceOf: () => 1,
  scene: new THREE.Group(),
  oobFloorY: -300,
  paths: authored.paths.map(s => ({
    ...s,
    markers: s.events
      .filter(e => e.type === 100)
      .map(e => ({ arc: e.start, end: e.end, speed: (e.value >>> 2) / 3.6, trickA: false, trickB: false })),
    points: s.points.map(p => new THREE.Vector3(...p)),
  })),
  starts: authored.starts,
});
let usedRecording = false,
  gateAir = 0;
for (let frame = 0; frame < 1800; frame++) {
  gateField.step(1 / 60);
  const riders = gateField.probe();
  usedRecording ||= riders.some(rider => rider.path < ridden.length);
  gateAir = Math.max(gateAir, ...riders.filter(rider => rider.path < ridden.length).map(rider => rider.airTime));
  if (gateAir > 0.3 && riders.some(rider => rider.pos.z > 300 && rider.grounded)) break;
}
assert(
  usedRecording && gateAir > 0.3 && gateField.probe().some(rider => rider.pos.z > 300),
  `The gate-seeded field selects and rides recorded sections, including their jump: recorded=${usedRecording}, air=${gateAir}, paths=${gateField.probe().map(rider => rider.path)}`,
);
gateField.dispose();
geometry.dispose();
console.log(
  `PASS: recording, adaptive spacing, safe overlapping sections, jump-only events, reset gaps, persistence, portable export and live AI (${firstRelease.toFixed(2)} m release)`,
);
