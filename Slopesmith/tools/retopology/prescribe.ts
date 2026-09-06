/**
 * Emit a prescribed-subside sidecar (input_rem_p0.fixed) for a retopology job directory, pinning
 * the subdivision counts around a locked-feature hole rim so the quantizer produces a conforming
 * join by construction (docs/ideas/042-relayout-quantization.md; core logic in
 * src/core/mesh/retopology/prescribe.ts).
 *
 *   npx tsx tools/retopology/prescribe.ts <job-directory> [--authored-edges N]
 *
 * The authored proxy (input.obj) boundary loop with N edges (default: the fewest) is the
 * protected rim; its edge count becomes the exact subdivision total around the matching remesh
 * rim. The patched quad_from_patches picks the sidecar up automatically on the next
 * quadrangulate run in that directory.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readObj } from '../../src/core/mesh/retopology/obj';
import {
  applyVertexMovesToObj,
  boundaryLoops,
  formatFixedSubsides,
  parseCornersFile,
  prescribeRimSubsides,
} from '../../src/core/mesh/retopology/prescribe';

const args = process.argv.slice(2);
const jobDir = args.find(arg => !arg.startsWith('--'));
if (!jobDir) {
  console.error('Usage: npx tsx tools/retopology/prescribe.ts <job-directory> [--authored-edges N]');
  process.exit(2);
}
const authoredEdgesArg = args.indexOf('--authored-edges');
const requestedEdges = authoredEdgesArg >= 0 ? Number(args[authoredEdgesArg + 1]) : undefined;

const authored = readObj(readFileSync(join(jobDir, 'input.obj'), 'utf8'));
const authoredLoops = boundaryLoops(authored);
if (!authoredLoops.length) throw new Error('input.obj has no boundary loops (not a hole-mode proxy)');
console.log(`input.obj: ${authored.vertices.length} verts, boundary loops: ${authoredLoops.map(l => l.length).join(', ')} edges`);

let protectedLoop: number[] | undefined;
if (requestedEdges !== undefined) {
  protectedLoop = authoredLoops.find(loop => loop.length === requestedEdges);
  if (!protectedLoop) throw new Error(`no authored boundary loop has ${requestedEdges} edges`);
} else {
  protectedLoop = authoredLoops.reduce((a, b) => (b.length < a.length ? b : a));
}
console.log(`protected rim: ${protectedLoop.length} authored edges`);

const remeshFile = join(jobDir, 'input_rem_p0.obj');
// iterate against the untouched remesh: restore from the backup taken before corner conforming
const backupFile = `${remeshFile}.orig`;
if (existsSync(backupFile)) writeFileSync(remeshFile, readFileSync(backupFile, 'utf8'));
const remeshText = readFileSync(remeshFile, 'utf8');
const remesh = readObj(remeshText);
const corners = parseCornersFile(readFileSync(join(jobDir, 'input_rem_p0.corners'), 'utf8'));

const prescription = prescribeRimSubsides(remesh, corners, [protectedLoop.map(v => authored.vertices[v])]);

const [loop] = prescription.loops;
console.log(`matched remesh rim: ${loop.rimEdges} edges, ${loop.arcs} arcs, worst authored projection ${loop.worstProjectionM.toFixed(3)}`);
console.log(`corner conforming: moved ${loop.movedCorners} corners (max ${loop.worstCornerMoveM.toFixed(2)} m), `
  + `worst residual ${loop.worstResidualM.toFixed(2)} m, ${prescription.movedVertices.size} rim vertices re-seated`);
if (prescription.movedVertices.size) {
  if (!existsSync(backupFile)) writeFileSync(backupFile, remeshText);
  writeFileSync(remeshFile, applyVertexMovesToObj(remeshText, prescription.movedVertices));
  console.log(`rewrote ${remeshFile} (original kept at ${backupFile})`);
}
console.log('\nprescribed rim arcs:');
console.log('arc | v0 -> v1       | count | fractions');
for (let k = 0; k < prescription.records.length; k++) {
  const record = prescription.records[k];
  console.log(`${String(k).padStart(3)} | ${`${record.v0}->${record.v1}`.padEnd(14)} | ${String(record.count).padStart(5)} | `
    + record.fractions.map(fraction => fraction.toFixed(3)).join(' '));
}
const outFile = join(jobDir, 'input_rem_p0.fixed');
writeFileSync(outFile, formatFixedSubsides(prescription.records));
const total = prescription.records.reduce((sum, record) => sum + record.count, 0);
console.log(`\nwrote ${prescription.records.length} prescriptions (total ${total}) to ${outFile}`);
