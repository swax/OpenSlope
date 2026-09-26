// tier: fast

import { authoredModelLevelProps } from '../src/core/doc/models';
import { defaultMountain } from '../src/core/doc/mountain';
import type { AuthoredModel, PropSheet, QuadMeshDoc, V3 } from '../src/core/doc/types';
import type { LevelProps, PropModel, PropInstance } from '../src/core/reference/props';
import { mineSheetFamilies, sheetPieces, SHEET_DEFAULT_LIFT, type SheetPiece } from '../src/core/props/sheet-prop';
import type { LineGround } from '../src/core/props/prop-line';
import { mineRailPipes } from '../src/core/rails/rails';
import { check, checkNear, failures, near } from './check';

/**
 * Sheets (docs/071): one textured surface cut into a quad per span. What makes a sheet worth having is that its
 * pieces meet exactly — the seams the shipped fences never show — so that, the way each piece faces, and how a
 * shipped level's pieces are recognised as one sheet are pinned here as numbers.
 */

const corner = (piece: SheetPiece, i: number): V3 => piece.vertices.slice(i * 3, i * 3 + 3) as V3;
const same = (a: V3, b: V3) => near(a[0], b[0], 1e-9) && near(a[1], b[1], 1e-9) && near(a[2], b[2], 1e-9);
const sheetLine = (nodes: V3[], sheet: PropSheet, spacing = 4) => ({ nodes, spacing, sheet });
const slope: LineGround = x => x * 0.25;

// ---- standing: plumb edges on the ground, shared with the neighbour ------------------------------------------
{
  const pieces = sheetPieces(sheetLine([[0, 0, 0], [12, 3, 0], [20, 5, 10]], { size: 4 }), slope);
  check(pieces.length >= 4, 'stand: the path is cut into several pieces', `${pieces.length}`);
  let shared = true, plumb = true, grounded = true;
  pieces.forEach((piece, k) => {
    const [a, b, c, d] = [0, 1, 2, 3].map(i => corner(piece, i));
    if (!(near(a[0], c[0], 1e-9) && near(a[2], c[2], 1e-9) && near(b[0], d[0], 1e-9) && near(b[2], d[2], 1e-9))) plumb = false;
    if (!(near(a[1], slope(a[0], a[2], 0)!, 1e-9) && near(c[1] - a[1], 4, 1e-9) && near(d[1] - b[1], 4, 1e-9))) grounded = false;
    const next = pieces[k + 1];
    if (next && !(same(b, corner(next, 0)) && same(d, corner(next, 2)))) shared = false;
  });
  check(shared, 'stand: each piece\'s end edge IS the next piece\'s start edge — no seam, no overlap');
  check(plumb, 'stand: the edges at the posts are vertical, however the ground slopes');
  check(grounded, 'stand: the bottom follows the ground at every post and the top stands the height above it');
  check(same(corner(pieces[0], 0), [0, 0, 0]) && near(corner(pieces[pieces.length - 1], 1)[0], 20, 1e-6),
    'stand: the sheet starts on the first node and ends on the last');
  check(pieces.every(piece => piece.quads.length === 1 && piece.quads[0].join() === '0,1,2,3'),
    'stand: every piece is one quad, A B C D in the tiled order');
}

// ---- lying: across the path, level, facing up, the width held through a bend ----------------------------------
{
  const flat: LineGround = () => 2;
  const pieces = sheetPieces(sheetLine([[0, 2, 0], [16, 2, 0], [16, 2, 16]], { lie: true, size: 6 }), flat);
  const up = pieces.every(piece => {
    const [a, b, c] = [0, 1, 2].map(i => corner(piece, i));
    const u = [b[0] - a[0], b[2] - a[2]], v = [c[0] - a[0], c[2] - a[2]];
    return u[1] * v[0] - u[0] * v[1] > 0; // (B−A)×(C−A), y component
  });
  // The terrain's own quads face up the same way, which is the convention tiled models are wound for.
  const terrain = defaultMountain();
  const at = (i: number): V3 => [terrain.vertices[i * 3], terrain.vertices[i * 3 + 1], terrain.vertices[i * 3 + 2]];
  const q = terrain.quads[0], [ta, tb, tc] = [at(q[0]), at(q[1]), at(q[2])];
  const terrainUp = (tb[2] - ta[2]) * (tc[0] - ta[0]) - (tb[0] - ta[0]) * (tc[2] - ta[2]) > 0;
  check(up && terrainUp, 'lie: every piece faces up, as the terrain\'s own quads do — a river faces the sky');
  check(pieces.every(piece => [0, 1, 2, 3].every(i => near(corner(piece, i)[1], 2 + SHEET_DEFAULT_LIFT, 1e-9))),
    'lie: level across, floating the default lift over the ground');
  const first = pieces[0];
  checkNear(Math.hypot(corner(first, 2)[0] - corner(first, 0)[0], corner(first, 2)[2] - corner(first, 0)[2]), 6,
    'lie: a straight piece is the sheet\'s width across', 1e-9);
  // Round the corner the joint edges are mitred: never shorter than the width, and longer where the path turns,
  // so each strip keeps its width through the bend instead of pinching.
  const edges = pieces.map(piece => Math.hypot(corner(piece, 2)[0] - corner(piece, 0)[0], corner(piece, 2)[2] - corner(piece, 0)[2]));
  check(edges.every(e => e >= 6 - 1e-9) && Math.max(...edges) > 6 * 1.05,
    'lie: joint edges are mitred through the bend, never pinched', edges.map(e => e.toFixed(2)).join(' '));
  let shared = true;
  for (let k = 0; k + 1 < pieces.length; k++) if (!same(corner(pieces[k], 1), corner(pieces[k + 1], 0))) shared = false;
  check(shared, 'lie: neighbours share their joint edge');
}

// ---- a piece wears the tile the way the retail fence does: U along the run, V = 1 at the top ---------------------
{
  const [piece] = sheetPieces(sheetLine([[0, 0, 0], [4, 0, 0]], { size: 4 }), () => 0);
  const model: AuthoredModel = { id: 'model:0000', name: 'fence · 1', anchor: piece.anchor, vertices: piece.vertices,
    quads: piece.quads, texture: 'GARI/0007.png', line: 'line:0000' };
  const lp = authoredModelLevelProps({ models: [model] } as unknown as QuadMeshDoc);
  const sub = lp.models[0].subs[0];
  let topV = Infinity, bottomV = -Infinity;
  for (let i = 0; i < sub.positions.length / 3; i++) {
    const z = sub.positions[i * 3 + 2], v = sub.uvs[i * 2 + 1];
    if (z > 1) topV = Math.min(topV, v); else bottomV = Math.max(bottomV, v);
  }
  check(topV === 1 && bottomV === 0, 'mapping: V is 1 along the top edge and 0 along the bottom, as GARI\'s chain link');
  check(lp.models[0].line === 'line:0000', 'library: a piece reports the sheet that owns it');
}

// ---- the Prop Library: which of a level's pieces are one sheet ----------------------------------------------------
{
  const quad = (length: number, height: number) => ({
    mat: 7, positions: new Float32Array([0, 0, 0, 0, length, 0, 0, 0, height, 0, length, height]),
    uvs: new Float32Array(8), indices: new Uint32Array([0, 2, 3, 0, 3, 1]),
  });
  const models: PropModel[] = [];
  const instances: PropInstance[] = [];
  const place = (model: PropModel, loc: V3, sourceIndex: number) => {
    models.push(model);
    instances.push({ sourceIndex, model: model.id, loc, rot: [0, 0, 0, 1], scale: [1, 1, 1], visible: true } as PropInstance);
  };
  // A fence: six 8 m × 4 m quads end to end along raw Y, each its own model placed once — the retail anatomy.
  for (let i = 0; i < 6; i++) place({ id: i, name: `Fnc_Chain_${1000 + i}`, subs: [quad(800, 400)] }, [0, i * 800, 0], 10 + i);
  // A river: five 20 m × 10 m flat quads along raw X, sharing their edges.
  const flatQuad = { mat: 8, positions: new Float32Array([0, 0, 0, 2000, 0, 0, 0, 1000, 0, 2000, 1000, 0]),
    uvs: new Float32Array(8), indices: new Uint32Array([0, 2, 3, 0, 3, 1]) };
  for (let i = 0; i < 5; i++) place({ id: 20 + i, name: `Mdl_Water_Run_${i}`, subs: [flatQuad] }, [i * 2000, 5000, 0], 40 + i);
  // Look-alikes that never touch: five barrels scattered across the level.
  for (let i = 0; i < 5; i++) place({ id: 30 + i, name: `Mdl_Barrel_${i}`, subs: [quad(100, 100)] }, [i * 10000, -9000, 0], 60 + i);
  const lp = { level: 'TEST', models, instances,
    materials: new Map([[7, { tex: '0007.png', frames: [] }], [8, { tex: '0106.png', frames: [], blend: true }]]) } as unknown as LevelProps;
  const families = mineSheetFamilies(lp);
  const fence = families.find(f => f.key === 'Fnc_Chain'), river = families.find(f => f.key === 'Mdl_Water_Run');
  check(!!fence && fence.pieces === 6 && !fence.lie && near(fence.size, 4, 1e-6) && near(fence.span, 8, 1e-6),
    'mine: a fence cut into pieces is one standing sheet, 4 m high, 8 m spans', JSON.stringify(fence));
  check(fence?.texture === 'TEST/0007.png' && fence.representative.sourceIndex === 10 && fence.models.length === 6,
    'mine: it carries its tile and its first piece stands for its behaviour');
  check(!!river && river.lie && near(river.size, 10, 1e-6) && river.blend, 'mine: a river cut into pieces lies flat, 10 m across',
    JSON.stringify(river));
  check(!families.some(f => f.key === 'Mdl_Barrel'), 'mine: similar props that never touch are not a sheet');

  // Rail pipes: swept chunks, each placed once — folded into one entry that opens the rail tool. The support
  // post beside them is one kit model placed over and over, and stays an ordinary prop.
  const tube = { mat: 9, positions: new Float32Array(40 * 3), uvs: new Float32Array(80), indices: new Uint32Array(0) };
  for (let i = 0; i < 3; i++) place({ id: 50 + i, name: `Mdl_Rail_Metal_${1000 + i}`, subs: [tube] }, [0, 0, 9000 + i], 80 + i);
  for (let i = 0; i < 6; i++) {
    if (i === 0) models.push({ id: 60, name: 'Gem_RailSupport_1000', subs: [quad(10, 300)] });
    instances.push({ sourceIndex: 90 + i, model: 60, loc: [i * 500, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], visible: true } as PropInstance);
  }
  (lp.materials as Map<number, unknown>).set(9, { tex: '0077.png', frames: [] });
  const pipes = mineRailPipes(lp);
  check(!!pipes && pipes.pieces === 3 && pipes.models.join() === '50,51,52' && pipes.texture === 'TEST/0077.png',
    'mine: a level\'s rail pipes are one family, wearing their tube tile', JSON.stringify(pipes));
  check(!mineSheetFamilies(lp).some(f => f.key.includes('Rail')), 'mine: rail pipes and their support posts are not sheets');
  check(mineRailPipes({ ...lp, models: lp.models.filter(m => m.id !== 51 && m.id !== 52) }) === null,
    'mine: one lone pipe model is no family');
}

if (failures) process.exitCode = 1;
