// tier: fast

import type { AuthoredModel, PlacedProp, PropLine, V3 } from '../src/core/doc/types';
import type { SheetFamily } from '../src/core/props/sheet-prop';
import type { ArmedProp } from '../src/app/state/store';
import { attachEffectToProp, createEmptyEffectsDocument, effectAttachments } from '../src/core/effects/authoring';
import { check, failures } from './check';

/**
 * Prop lines' app half (docs/070): drawing a line from a held prop, laying its members out as it grows, moving
 * the attachments with them, and the edits that re-lay it — drag, delete, break apart, swap. The layout itself is
 * pinned by prop-line.test.ts; this drives `createPropLineOps` over a real document with the viewport and prop
 * ops faked down to what the line reads from them, so a broken step fails here rather than in someone's session.
 */

// The ops share the browser toast helper; give it the one DOM node it captures before importing them.
Object.defineProperty(globalThis, 'document', {
  configurable: true, value: { getElementById: () => ({ textContent: '', className: '' }) },
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 0 } });
const { createPropLineOps } = await import('../src/app/props/lines');

type Doc = { name: string; props?: PlacedProp[]; propLines?: PropLine[]; models?: AuthoredModel[];
  effects?: ReturnType<typeof createEmptyEffectsDocument> };
const doc: Doc = { name: 'TEST' };
const store = {
  mdoc: doc, armedProp: null as ArmedProp | null, selectedLine: null as string | null, selectedLineNode: null as number | null,
  lineDrawing: false, selectedProp: null as number | null, multiSel: [] as number[],
};
let drawingArmed = false;
let libraryWanted = false;
let interceptor: ((armed: ArmedProp) => boolean) | null = null;
const stamped: string[] = [];
const viewport = {
  props: { pendingScale: 1 },
  setPropArmed() {},
  setLineDrawing(on: boolean) { drawingArmed = on; },
  groundHeightAt: () => 0,
};
// A 4 m panel along raw −X (editor +X), 1 m tall: the model the fence below is built from.
const propOps = {
  authoredBoxOf: () => ({ min: [-200, -10, 0] as V3, max: [200, 10, 100] as V3 }),
  shortPropName: (name: string) => name,
  stampHeldEffects: (id: string) => { stamped.push(id); },
  interceptNextPick: (take: ((armed: ArmedProp) => boolean) | null) => { interceptor = take; },
  // Picking up a reference instance: what a sheet picked in the library does to borrow its piece's behaviour.
  armProp: async (level: string, model: number, name: string, from: { sourceIndex?: number }) => {
    armedFrom.push(from.sourceIndex ?? -1);
    const take = interceptor; interceptor = null;
    take?.({ ...held(model, name), level, from: 'instance' });
  },
};
const armedFrom: number[] = [];
const ops = createPropLineOps({
  store, viewport, propOps, groupDefIdx: new Map(),
  setPropLibWanted: (want: boolean) => { libraryWanted = want; },
  scheduleRebuild() {}, rebuildTools() {}, updateCmdSheet() {},
} as unknown as Parameters<typeof createPropLineOps>[0]);

const held = (model: number, name: string): ArmedProp => ({
  level: 'GARI', model, name, from: 'defaults',
  behaviour: { nativeCollision: { mode: 1, playerCollision: true, responseMass: 1e30, playerBounce: true, bounceAmount: 0.1 } },
});
const members = () => (doc.props ?? []).filter(p => p.line === 'line:0000');

// ---- drawing: the held prop becomes the line, and the line joins the document with its second point ----------
store.armedProp = held(7, 'Mdl_Fence');
ops.startLine();
check(store.armedProp === null && store.lineDrawing && drawingArmed && store.selectedLine === 'line:0000',
  'start: the held prop is put down and the tool draws a line');
ops.appendNode([0, 0, 0]);
check(!doc.propLines?.length && ops.displayLines().length === 1,
  'draw: one point is shown but kept out of the document — there is nothing to lay out yet');
ops.appendNode([20, 0, 0]);
check(doc.propLines?.length === 1 && members().length === 5,
  'draw: the second point puts the line in the document and lays five 4 m panels', `${members().length}`);
check(members().every(m => m.model === 7 && m.nativeCollision?.mode === 1),
  'draw: every member copies the held model and its settings');
check(stamped.length === 5, 'draw: the first members get the held prop\'s effect', stamped.join());

// A later member takes the effect its siblings share rather than stamping a new one.
doc.effects = createEmptyEffectsDocument('TEST');
doc.effects.slots.push({ id: 'slot:0000', name: 'fence flex', circumstances: { persistent: null, collision: null, trigger: null } } as never);
for (const member of members()) attachEffectToProp(doc.effects, member.id!, 'slot:0000', 'collision');
stamped.length = 0;
ops.appendNode([20, 0, 12]);
const grown = members();
check(grown.length > 5 && !stamped.length
  && grown.every(m => effectAttachments(doc.effects!).some(a => a.target.id === m.id && a.slot === 'slot:0000')),
'grow: new members share their siblings\' effect slot', `${grown.length} members, ${stamped.length} stamped`);
ops.finishLine();
check(!store.lineDrawing && !drawingArmed && store.selectedLine === 'line:0000',
  'finish: drawing stops and the line stays selected');

// ---- editing: a drag re-lays the line; a shrink takes the leavers' attachments with them ---------------------
ops.moveNode('line:0000', 2, [20, 5, 0]);
check(doc.propLines![0].nodes[2][1] === 0 && members().length === 5,
  'drag: the node drops back onto the ground and the line re-lays', `${members().length}`);
check(effectAttachments(doc.effects!).filter(a => a.target.id?.startsWith('line:0000:')).length === 5,
  'drag: members that left took their effect attachments with them');
store.selectedLineNode = 2;
ops.deleteSelectedNode();
check(doc.propLines![0].nodes.length === 2 && members().length === 5, 'delete point: the line re-lays over what is left');

// ---- swapping the prop: the next pick is the line's, and every member is re-stamped as it ---------------------
ops.swapProp();
check(libraryWanted && !!interceptor, 'swap: the Prop Library opens and waits for the next pick');
stamped.length = 0;
const took = interceptor!(held(9, 'Mdl_Lamp'));
check(took && doc.propLines![0].template.model === 9 && members().every(m => m.model === 9) && stamped.length === 5,
  'swap: every member is laid out afresh as the picked model, with its effect');

// ---- breaking apart: the members stay put, owned by nothing, and the line is gone -----------------------------
const before = members().map(m => m.pos.join());
ops.breakLine();
check(!doc.propLines?.length && !(doc.props ?? []).some(p => p.line) && store.selectedLine === null
  && (doc.props ?? []).map(p => p.pos.join()).join('|') === before.join('|'),
'break: the members stay exactly where they were, as ordinary props');

// ---- deleting a line takes its members; an abandoned draw leaves nothing behind -------------------------------
doc.props = [];
store.armedProp = held(7, 'Mdl_Fence');
ops.startLine();
ops.appendNode([0, 0, 0]);
ops.appendNode([8, 0, 0]);
ops.finishLine();
ops.deleteSelectedLine();
check(!doc.propLines?.length && !(doc.props ?? []).length, 'delete line: the line and every member go');
store.armedProp = held(7, 'Mdl_Fence');
ops.startLine();
ops.appendNode([0, 0, 0]);
store.lineDrawing = false; // another tool took over mid-draw
check(!doc.propLines?.length && ops.displayLines().length === 0, 'abandon: a line under two points never reaches the document');

// ---- sheets (docs/071): a sheet picked in the library, cut into pieces it owns --------------------------------------
doc.props = []; doc.models = [{ id: 'model:0000', name: 'my own model', anchor: [0, 0, 0], vertices: [], quads: [] }];
stamped.length = 0;
const family: SheetFamily = { key: 'Fnc_Chain', models: [3, 4, 5], pieces: 3, lie: false, size: 4, span: 5,
  texture: 'GARI/0007.png', blend: true, representative: { model: 3, sourceIndex: 50 } };
ops.pickSheet('GARI', family);
check(armedFrom.at(-1) === 50 && store.lineDrawing && store.selectedLine === 'line:0000',
  'sheet: picking one borrows its first piece\'s own settings, then draws at once');
ops.appendNode([0, 0, 0]);
ops.appendNode([20, 0, 0]);
const sheetLine = doc.propLines![0];
const pieces = (doc.models ?? []).filter(m => m.line === 'line:0000');
const pieceMembers = members();
check(sheetLine.sheet?.size === 4 && sheetLine.sheet.texture === 'GARI/0007.png' && sheetLine.spacing === 5,
  'sheet: it wears the family\'s tile at its height and span');
check(pieces.length === 4 && pieces.every(m => m.quads.length === 1 && m.texture === 'GARI/0007.png' && m.blend),
  'sheet: each span is its own one-quad tiled model, wearing the tile', `${pieces.length} pieces`);
check(pieceMembers.length === 4 && pieceMembers.every((m, k) => m.level === '@models' && m.model === Number(pieces[k].id.slice(6))
  && m.yaw === 0 && m.scale === 1 && m.pos.join() === pieces[k].anchor.join()),
'sheet: one placement of each piece, standing where the piece was cut');
check(stamped.length === 4 && pieceMembers.every(m => m.nativeCollision?.mode === 1),
  'sheet: every piece carries the picked piece\'s behaviour and effect');
check(doc.models![0].id === 'model:0000' && !doc.models![0].line, 'sheet: the author\'s own models are left alone');
ops.appendNode([20, 0, 10]);
check((doc.models ?? []).filter(m => m.line === 'line:0000').slice(0, 4).map(m => m.id).join() === pieces.map(m => m.id).join(),
  'sheet: growing the path keeps its pieces\' models, and mints more');
ops.finishLine();
store.selectedLineNode = 2;
ops.deleteSelectedNode();
check((doc.models ?? []).filter(m => m.line === 'line:0000').length === 4 && members().length === 4,
  'sheet: shortening the path drops the pieces it no longer needs');
ops.breakLine();
check(!doc.propLines?.length && (doc.models ?? []).length === 5 && !(doc.models ?? []).some(m => m.line)
  && !(doc.props ?? []).some(p => p.line),
'sheet: breaking it leaves each piece as the author\'s own tiled prop');
doc.props = []; doc.models = [];
ops.startBlankSheet();
ops.appendNode([0, 0, 0]);
ops.appendNode([8, 0, 0]);
ops.finishLine();
check(doc.propLines?.[0].sheet?.size === 3 && !doc.models?.[0]?.texture && members().length === 2,
  'sheet: Add sheet starts a blank standing one, untextured');
ops.deleteSelectedLine();
check(!doc.propLines?.length && !doc.models?.length && !doc.props?.length, 'sheet: deleting it takes its pieces with it');

if (failures) process.exitCode = 1;
