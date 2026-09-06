// anim-nodes.mjs — read the LIVE pose of every animated world-prop sub-object out of a paused
// PCSX2 session (SSX Tricky, PAL SLES-50545) via PINE. READ-ONLY: never issues a write opcode.
//
//   node ee-dump.mjs                    # snapshot EE RAM -> ee.bin  (~1.5 s)
//   node anim-nodes.mjs                 # list every live AnimObject / AnimDelta node
//   node anim-nodes.mjs <nodeHex>       # full per-sub-object matrix dump for one node
//   node anim-nodes.mjs --refresh [...] # re-snapshot first, then do the above
//
// Structure offsets, all established by disassembling the PAL ELF out of the same dump:
//   node+0x38 vtable (0x0038d8c0 AnimObject / 0x0038d7c8 AnimDelta)
//   node+0x08 loop mode   +0x0c clock gate   +0x20 per-frame step (s)   +0x24 clip time (s)
//   node+0x28/+0x2c play window (s)   +0x58 world entity   +0x5c animated-object count
//   node+0x60 record array  (allocation is [u32 count][records...], node+0x60 points past it)
//   entity+0xc0 model   entity+0xe8 flags (bit 2 set while an AnimObject is installed)
//   model+0x04 ModelObject count   model+0x08 ModelObject array, stride 0x18
//   modelObject+0x10 -> Animation record, or 0 when the object is not animated
//   Animation: +0x00..0x08 base translation, +0x0c..0x14 base Euler in RADIANS,
//              +0x18 channel bitmask, +0x20 per-channel curve table
//   record (0xd0 bytes, one per animated ModelObject, in model-object order):
//     +0x48 Animation record   +0x4c/+0x50/+0x54 live translation X/Y/Z (channels 0/1/2)
//     +0x58/+0x5c/+0x60 live rotation X/Y/Z in DEGREES (channels 3/4/5)
//     +0x90..+0xcf computed 4x4 local matrix, row-major, row3 = translation, m[3][3] = 1
//   The stored 3x3 is transpose(Rz*Ry*Rx) — see ../../research/extracted-data.md
//   "Runtime animation records"; row r is the image of local axis r.
import fs from 'node:fs';

if (process.argv.includes('--refresh')) {
  const { snapshot } = await import('./ee-dump.mjs');
  console.log('snapshot:', await snapshot());
}
const ee = fs.readFileSync(new URL('./ee.bin', import.meta.url));
const u32 = a => ee.readUInt32LE(a);
const f32 = a => ee.readFloatLE(a);
const VT = { 0x0038d8c0: 'AnimObject', 0x0038d7c8: 'AnimDelta' };
const D = Math.PI / 180;
const CH = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'];

/** The level's instance hash table: a sorted array of (entityPtr, hash) pairs. */
export function hashTable() {
  const map = new Map();
  let best = null, run = 0, start = 0;
  for (let o = 0x00300000; o + 16 < ee.length; o += 8) {
    const p = u32(o), h = u32(o + 4), h2 = u32(o + 12);
    if (p >= 0x00300000 && p < 0x02000000 && !(p & 3) && h > 0 && h < 0x80000000 && h2 > h) { if (!run) start = o; run++; }
    else { if (run > (best?.[1] ?? 200)) best = [start, run]; run = 0; }
  }
  if (run > (best?.[1] ?? 200)) best = [start, run];
  if (best) { for (let i = 0; i <= best[1]; i++) map.set(u32(best[0] + i * 8), u32(best[0] + i * 8 + 4)); map.range = best; }
  return map;
}

/** Every live model-animation node, found by its vtable pointer. */
export function findNodes() {
  const out = [];
  for (let o = 0x00300000; o + 0x70 < ee.length; o += 4) {
    if (!VT[u32(o)]) continue;
    const node = o - 0x38;
    const ent = u32(node + 0x58), cnt = u32(node + 0x5c), recs = u32(node + 0x60);
    if (ent < 0x00300000 || ent >= 0x02000000 || (ent & 3)) continue;
    if (!cnt || cnt > 512) continue;
    if (recs < 0x00300000 || recs >= 0x02000000 || (recs & 3)) continue;
    out.push({ node, kind: VT[u32(o)], ent, cnt, recs, mode: ee.readInt16LE(node + 0x08),
      gate: u32(node + 0x0c), step: f32(node + 0x20), time: f32(node + 0x24),
      win: [f32(node + 0x28), f32(node + 0x2c)] });
  }
  return out;
}

/** The engine's computed 4x4 local matrix for one record. */
export const mat = rec => Array.from({ length: 4 }, (_, r) =>
  Array.from({ length: 4 }, (_, c) => f32(rec + 0x90 + r * 16 + c * 4)));

/** Walk a node's records alongside the model objects that own them. */
export function* records(n) {
  const model = u32(n.ent + 0xc0), objs = u32(model + 0x08), nobj = u32(model + 0x04);
  let k = 0;
  for (let i = 0; i < nobj; i++) {
    const anim = u32(objs + i * 0x18 + 0x10);
    if (!anim) continue;
    const rec = n.recs + (k++) * 0xd0;
    yield { obj: i, anim, rec, model, nobj, mask: u32(anim + 0x18),
      baseT: [0, 4, 8].map(o => f32(anim + o)),
      baseEulerRad: [0xc, 0x10, 0x14].map(o => f32(anim + o)),
      liveT: [0x4c, 0x50, 0x54].map(o => f32(rec + o)),
      liveRotDeg: [0x58, 0x5c, 0x60].map(o => f32(rec + o)),
      m: mat(rec) };
  }
}

const axis = v => { const k = v.map(Math.abs).indexOf(Math.max(...v.map(Math.abs)));
  return `${v[k] < 0 ? '-' : '+'}${'XYZ'[k]}${Math.abs(v[k]) > 0.999 ? '' : '~'}`; };

export function dumpNode(n, names) {
  const h = names?.get(n.ent);
  const first = [...records(n)][0];
  console.log(`\n=== ${n.kind} node 0x${n.node.toString(16)}  entity 0x${n.ent.toString(16)}`
    + `${h !== undefined ? `  hash 0x${h.toString(16)}` : ''}  model 0x${first.model.toString(16)}`
    + `  objects ${first.nobj} (${n.cnt} animated)`);
  console.log(`    clip t=${n.time.toFixed(4)}s  step=${n.step.toFixed(5)}  window=[${n.win.join(', ')}]`
    + `  mode=${n.mode}  gate=${n.gate}  entity flags(+0xe8)=0x${u32(n.ent + 0xe8).toString(16)}`);
  for (const r of records(n)) {
    const ch = CH.filter((_, b) => r.mask >> b & 1).join(',') || '(none)';
    console.log(`  obj${r.obj}  rec 0x${r.rec.toString(16)}  mask 0x${r.mask.toString(16)} [${ch}]`);
    console.log(`      Animation base:  T=(${r.baseT.map(v => v.toFixed(3)).join(', ')})`
      + `  Euler stored rad=(${r.baseEulerRad.map(v => v.toFixed(5)).join(', ')})`
      + ` i.e. deg=(${r.baseEulerRad.map(v => (v / D).toFixed(2)).join(', ')})`);
    console.log(`      live record:     T=(${r.liveT.map(v => v.toFixed(3)).join(', ')})`
      + `  rotation deg=(${r.liveRotDeg.map(v => v.toFixed(4)).join(', ')})`);
    for (let i = 0; i < 4; i++)
      console.log(`      [ ${r.m[i].map(v => (Math.abs(v) < 1e-7 ? 0 : v).toFixed(6).padStart(11)).join('  ')} ]`
        + (i < 3 ? `   local ${'+XYZ'[0]}${'XYZ'[i]} -> ${axis(r.m[i].slice(0, 3))}` : ''));
  }
}

if (process.argv[1]?.endsWith('anim-nodes.mjs')) {
  const names = hashTable(), nodes = findNodes();
  const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
  console.log(`hash table: ${names.size} instances at 0x${names.range?.[0].toString(16)}   animation nodes: ${nodes.length}`);
  for (const n of nodes) {
    if (arg) { if (n.node === parseInt(arg, 16)) dumpNode(n, names); continue; }
    const h = names.get(n.ent);
    console.log(`  ${n.kind.padEnd(10)} node 0x${n.node.toString(16)}  entity 0x${n.ent.toString(16)}`
      + `  hash ${h !== undefined ? '0x' + h.toString(16).padStart(8, '0') : '?'}  animObjs ${n.cnt}  t=${n.time.toFixed(3)}s`);
  }
  if (!arg) console.log('\npass a node address for the full matrix dump, e.g. `node anim-nodes.mjs '
    + `${nodes[0] ? nodes[0].node.toString(16) : '859dc0'}\``);
}
