// tier: fast

import assert from 'node:assert/strict';

/**
 * A tiled prop's tile ORIENTATION (docs/028): the one D4 state a whole model wears its tile at, and the four
 * places that have to agree about it.
 *
 * A tiled prop's mapping is computed rather than stored, so turning its tile is not an edit to a UV layout —
 * it is a state each consumer re-derives the mapping through. That makes drift the whole risk: the viewport
 * bake, the export bake and the edit substrate each build the same UVs independently, and a turn that
 * reached only two of them is invisible until someone looks at an ISO. So the checks here are mostly
 * agreements between those paths rather than assertions about any single one of them.
 *
 * The keyboard end is checked for the reason `paint-turn.test.ts` gives: nothing type-checks that ← / →
 * still reaches a model session, and a browser round-trip to find out costs minutes.
 */
const { tiledPropUV, authoredModelLevelProps, modelEditDocFor, commitModelEditDoc,
  AUTHORED_MODEL_LEVEL } = await import('../src/core/doc/models');
const { bakeAuthoredModelProps } = await import('../src/core/export/props');
const { turnD4 } = await import('../src/core/paint/orientation');
type AuthoredModel = import('../src/core/doc/types').AuthoredModel;
type QuadMeshDoc = import('../src/core/doc/types').QuadMeshDoc;
type MaterialCombiner = import('../src/core/export/materials').MaterialCombiner;

// ---- the step: one shared quarter-turn wherever a tile is worn ----

assert.deepEqual(turnD4({ rot: 0, mirror: false }, -1, false), { rot: 3, mirror: false },
  '→ steps rot DOWN from unset, which reads as a quarter CW on the surface');
assert.deepEqual(turnD4({ rot: 0, mirror: false }, 1, false), { rot: 1, mirror: false }, '← steps it up');
let cycled = { rot: 2, mirror: true };
for (let i = 0; i < 4; i++) cycled = turnD4(cycled, -1, false);
assert.deepEqual(cycled, { rot: 2, mirror: true }, 'four turns land exactly back where they started');
assert.deepEqual(turnD4({ rot: 3, mirror: false }, -1, true), { rot: 3, mirror: true },
  '⇧ toggles the mirror and holds the rotation — a flip is never cycled into');

// ---- the mapping: a turn permutes the tile's corners, it never crops or stretches ----

const QUAD_CORNERS = [0, 1, 2, 3];
assert.deepEqual(QUAD_CORNERS.map(s => tiledPropUV(s, false)), [[0, 0], [1, 0], [0, 1], [1, 1]],
  'unturned, each quad wears the full 0–1 rect — A(0,0) B(1,0) C(0,1) D(1,1)');
assert.deepEqual(tiledPropUV(2, true), [0.5, 1], 'a wedge\'s collapsed corner takes the tile\'s top centre');

const cornerKey = (o?: { rot: number; mirror: boolean }) =>
  QUAD_CORNERS.map(s => tiledPropUV(s, false, o).join(',')).sort().join(' ');
const upright = cornerKey();
for (let rot = 0; rot < 4; rot++) for (const mirror of [false, true]) {
  assert.equal(cornerKey({ rot, mirror }), upright,
    `at rot ${rot}${mirror ? ' mirrored' : ''} the quad still covers the whole tile — the four corners are `
    + 'the tile\'s four corners, permuted');
}
assert.notDeepEqual(QUAD_CORNERS.map(s => tiledPropUV(s, false, { rot: 1, mirror: false })),
  QUAD_CORNERS.map(s => tiledPropUV(s, false)), 'and the permutation is a real one — the art does move');
// The wedge's midpoint rides the turn with its two full corners, so its edges stay symmetric about the tile.
for (let rot = 0; rot < 4; rot++) {
  const [u, v] = tiledPropUV(2, true, { rot, mirror: false });
  assert.ok((u === 0.5) !== (v === 0.5), `a wedge midpoint at rot ${rot} sits on a tile EDGE's centre`);
}

// ---- the three consumers: viewport bake, export bake, edit substrate ----

/** One two-quad ribbon (a plain quad and a wedge), the smallest model that exercises both corner counts. */
const ribbon = (): AuthoredModel => ({
  id: 'model:0000', name: 'Ribbon', anchor: [0, 0, 0],
  vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 1],
  quads: [[0, 1, 2, 3], [1, 3, 4, 4]],
  texture: 'DONOR/0106.png',
});

const model = ribbon();
const host = { models: [model] } as unknown as QuadMeshDoc;
const placement = { id: 'prop:0000', level: AUTHORED_MODEL_LEVEL, model: 0, name: 'Ribbon',
  pos: [0, 0, 0] as [number, number, number], yaw: 0, scale: 1 };
// bakeAuthoredModelProps only asks the combiner for a tile slot; the UVs it emits are what is under test.
const combiner = { resolveTileSlot: () => 0 } as unknown as MaterialCombiner;

const uvsOf = (m: AuthoredModel) => [...authoredModelLevelProps({ models: [m] } as unknown as QuadMeshDoc)
  .models[0].subs[0].uvs];

assert.deepEqual(uvsOf(model).slice(0, 8), [0, 0, 1, 0, 0, 1, 1, 1],
  'an unturned model bakes the same UVs it always did — orientation is stored as absence');

model.orient = { rot: 1, mirror: false };
const turnedUvs = uvsOf(model);
assert.deepEqual(turnedUvs.slice(0, 8),
  QUAD_CORNERS.flatMap(s => tiledPropUV(s, false, model.orient)),
  'the viewport bake wears the model\'s D4');
assert.notDeepEqual(turnedUvs.slice(0, 8), [0, 0, 1, 0, 0, 1, 1, 1], 'which is not the upright mapping');

for (const orient of [undefined, { rot: 1, mirror: false }, { rot: 2, mirror: true },
  { rot: 3, mirror: false }] as const) {
  if (orient) model.orient = { ...orient }; else delete model.orient;
  const exported = bakeAuthoredModelProps([placement], [model], 0, 0, combiner).groups[0].subs[0].uvs;
  assert.deepEqual([...exported], uvsOf(model),
    `export and viewport bakes agree UV-for-UV at ${orient ? `rot ${orient.rot}` : 'upright'} — the drift `
    + 'that would only show up on an ISO');
}

model.orient = { rot: 3, mirror: true };
const substrate = modelEditDocFor(host, model);
assert.deepEqual(substrate.quadOrient, { 0: { rot: 3, mirror: true }, 1: { rot: 3, mirror: true } },
  'the edit substrate derives the model\'s D4 onto EVERY quad, so the session previews what its placements '
  + 'render (and the tile-orientation F overlay reads it)');
assert.notEqual(substrate.quadOrient![0], model.orient,
  'each derived entry is its own object — a per-quad edit in a session cannot reach back into the record');

delete model.texture;
assert.equal(modelEditDocFor(host, model).quadOrient, undefined,
  'untextured clay derives no orientation — there is no tile to be turned');
model.texture = 'DONOR/0106.png';
delete model.orient;
assert.equal(modelEditDocFor(host, model).quadOrient, undefined, 'nor does an upright tile');

// The derived channel must not write back: a model record stays the lean polygon + one-tile + one-D4 form.
model.orient = { rot: 2, mirror: false };
const session = modelEditDocFor(host, model);
session.quadOrient = { 0: { rot: 1, mirror: true } }; // as a mesh op or a paste in-session would leave it
commitModelEditDoc(model, session);
assert.deepEqual(model.orient, { rot: 2, mirror: false },
  'commit drops the derived per-quad channel rather than folding it into the model\'s own state');
assert.equal((model as { quadOrient?: unknown }).quadOrient, undefined,
  'and never stores a per-quad layout on the record — that is what makes a prop textured instead');

// ---- the binding: ← / → reach the model session, and still reach Paint ----

let handler: ((e: unknown) => void) | null = null;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') handler = fn; } },
});

const { installShortcuts } = await import('../src/app/shortcuts');

const paintTurns: [number, boolean][] = [];
const modelTurns: [number, boolean][] = [];
let turnable = true;
const store = { currentMode: 'edit', modelEditId: 'model:0000', paintBrush: null,
  selectedPaintCell: null, paintMultiSel: [] };
installShortcuts({
  store, viewport: { riding: false }, edit: {}, trickTools: {}, propOps: {}, sculptBrush: {},
  turnPaintTexture: (dir: 1 | -1, flip: boolean) => { paintTurns.push([dir, flip]); return true; },
  turnModelTexture: (dir: 1 | -1, flip: boolean) => { modelTurns.push([dir, flip]); return turnable; },
  chatFocused: () => false,
  openChat: () => {},
  // Edit-mode guards the unhandled-arrow fall-through consults on its way past.
  cageActive: () => false,
  canHideSelection: () => false,
  canSelectConnected: () => false,
  canPasteVertices: () => false,
  canCopyVertices: () => false,
  mixedEditSelection: () => false,
} as unknown as Parameters<typeof installShortcuts>[0]);
assert.ok(handler, 'installShortcuts registers a keydown listener');

let prevented = 0;
const press = (key: string, extra: Record<string, unknown> = {}) => {
  prevented = 0;
  handler!({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: null,
    preventDefault: () => { prevented++; }, ...extra });
};

press('ArrowRight');
assert.deepEqual(modelTurns.at(-1), [-1, false], '→ in a model session turns that prop\'s tile');
assert.equal(prevented, 1, 'a handled arrow is swallowed, so the page does not also scroll');
press('ArrowLeft', { shiftKey: true });
assert.deepEqual(modelTurns.at(-1), [1, true], '⇧← mirrors it');
assert.equal(paintTurns.length, 0, 'and none of this reaches the Paint target');

turnable = false;
press('ArrowRight');
assert.equal(prevented, 0, 'an untextured prop declines, leaving the arrow to the browser');
turnable = true;

const quiet = (label: string, extra: Record<string, unknown> = {}) => {
  const before = modelTurns.length;
  press('ArrowRight', extra);
  assert.equal(modelTurns.length, before, label);
};
store.modelEditId = null as unknown as string;
quiet('Edit mode with no session open has no tile to turn');
store.modelEditId = 'model:0000';
quiet('a text field keeps its caret keys', { target: { matches: (s: string) => s.includes('input') } });
quiet('a modified arrow is not the turn key', { ctrlKey: true });

store.currentMode = 'paint';
press('ArrowRight');
assert.deepEqual(paintTurns.at(-1), [-1, false], 'Paint mode still routes to its own target');

console.log('TILED PROP TURN TESTS PASSED');
