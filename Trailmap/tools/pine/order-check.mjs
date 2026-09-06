// order-check.mjs — discriminate the engine's Euler composition order against the matrices the
// engine itself computed, read out of live PS2 RAM. Uses the zz-euler-order canary node.
import { findNodes, mat } from './anim-nodes.mjs';
import fs from 'node:fs';
const ee = fs.readFileSync(new URL('./ee.bin', import.meta.url));
const u32 = a => ee.readUInt32LE(a), f32 = a => ee.readFloatLE(a);
const D = Math.PI / 180;

const Rx = t => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];
const Ry = t => [[Math.cos(t), 0, Math.sin(t)], [0, 1, 0], [-Math.sin(t), 0, Math.cos(t)]];
const Rz = t => [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
const mul = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const T = A => [0, 1, 2].map(i => [0, 1, 2].map(j => A[j][i]));
const R = { X: Rx, Y: Ry, Z: Rz };
// "ZYX" means the matrix product Rz * Ry * Rx (Z outermost / leftmost, applied last to a column vector)
const build = (order, a) => order.split('').reduce((M, ax) => M ? mul(M, R[ax](a['XYZ'.indexOf(ax)])) : R[ax](a['XYZ'.indexOf(ax)]), null);
const ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
const dist = (A, B) => Math.max(...A.flatMap((r, i) => r.map((v, j) => Math.abs(v - B[i][j]))));
const dir = v => { const p = [0, 1, 2].map(i => v[i]);
  const k = p.map(Math.abs).indexOf(Math.max(...p.map(Math.abs)));
  return (p[k] < 0 ? '-' : '+') + 'XYZ'[k] + (Math.abs(p[k]) > 0.999 ? '' : '?'); };

const node = findNodes().find(n => n.node === parseInt(process.argv[2] ?? '859dc0', 16));
const model = u32(node.ent + 0xc0), objs = u32(model + 0x08), nobj = u32(model + 0x04);
console.log(`node 0x${node.node.toString(16)} entity 0x${node.ent.toString(16)} — ${node.cnt} animated sub-objects\n`);

const scores = Object.fromEntries(ORDERS.map(o => [o, 0]));
let k = 0;
for (let i = 0; i < nobj; i++) {
  const anim = u32(objs + i * 0x18 + 0x10); if (!anim) continue;
  const rec = node.recs + (k++) * 0xd0;
  const ang = [0x58, 0x5c, 0x60].map(o => f32(rec + o) * D);   // rec fields are DEGREES
  const M = mat(rec), R3 = [0, 1, 2].map(r => M[r].slice(0, 3)); // stored = R^T (row-vector form)
  const obs = T(R3);                                            // recover the column-convention R
  console.log(`obj${i}  mask 0x${u32(anim + 0x18).toString(16)}  channel angles deg = `
    + `(${ang.map(v => (v / D).toFixed(3)).join(', ')})   local +X axis lands ${dir(R3[0])}`);
  for (const o of ORDERS) {
    const d = dist(build(o, ang), obs);
    if (d < 1e-3) scores[o]++;
    console.log(`    ${o}  max|Δ| = ${d.toExponential(2)}  ${d < 1e-3 ? 'MATCH' : ''}   +X -> ${dir(build(o, ang).map(r => r[0]))}`);
  }
  console.log();
}
console.log('orders matching every sub-object:',
  ORDERS.filter(o => scores[o] === node.cnt).join(', ') || '(none)');
console.log('per-order match counts:', JSON.stringify(scores));
