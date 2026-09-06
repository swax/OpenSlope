// tier: fast

import assert from 'node:assert/strict';

/**
 * Paint's ← / → tile turn (docs/005): the keyboard binding and the document edit it drives.
 *
 * Rotating a texture used to be two gestures covering different targets — the wheel over the brush ghost and
 * a right-click on the tile — so a change to one silently left the other alone. It is now one key pair for
 * every target, which is worth a check precisely because a keymap has no other reader: nothing type-checks
 * that ArrowRight still reaches Paint, and a browser round-trip to find out costs minutes.
 *
 * `installShortcuts` is a plain function over a deps bag that adds one window listener, so the check captures
 * that listener and hands it event literals. `turnOrient` is imported directly, which is what makes the
 * select-mode branch (turn every selected placed cell) reachable at all outside a running editor.
 */
const { turnOrient } = await import('../src/core/doc/doc-edit');

// ---- the document edit: → steps rot down (CW on screen), ← steps it up, ⇧ toggles mirror instead ----

const doc = {
  quadTex: { 0: 'GARI/0019.png', 1: 'GARI/0012.png', 2: 'GARI/0028.png' },
  quadOrient: {} as Record<number, { rot: number; mirror: boolean }>,
} as unknown as Parameters<typeof turnOrient>[0];

assert.equal(turnOrient(doc, [0], -1, false), 1);
assert.deepEqual(doc.quadOrient![0], { rot: 3, mirror: false }, '→ from unset (rot 0) steps DOWN to 3');
turnOrient(doc, [0], -1, false);
assert.deepEqual(doc.quadOrient![0], { rot: 2, mirror: false });
turnOrient(doc, [0], 1, false);
turnOrient(doc, [0], 1, false);
assert.deepEqual(doc.quadOrient![0], { rot: 0, mirror: false }, '← undoes → exactly, wrapping through 0');
turnOrient(doc, [0], 1, false);
assert.deepEqual(doc.quadOrient![0], { rot: 1, mirror: false }, '← from 0 wraps UP to 1');

// Mirror is a separate act, never cycled into: the flip leaves rot alone and either arrow toggles it.
turnOrient(doc, [0], -1, true);
assert.deepEqual(doc.quadOrient![0], { rot: 1, mirror: true }, '⇧ toggles mirror and holds the rotation');
turnOrient(doc, [0], 1, true);
assert.deepEqual(doc.quadOrient![0], { rot: 1, mirror: false }, 'the opposite arrow toggles mirror back');

// A multi-selection turns as one, matching Delete clearing the whole set.
turnOrient(doc, [1, 2], -1, false);
assert.deepEqual(doc.quadOrient![1], { rot: 3, mirror: false });
assert.deepEqual(doc.quadOrient![2], { rot: 3, mirror: false });

// A quad holding no tile has no orientation to turn — skipped, and never given a stray quadOrient entry.
assert.equal(turnOrient(doc, [7], -1, false), 0, 'an unpainted quad is not turned');
assert.equal(doc.quadOrient![7], undefined);
assert.equal(turnOrient(doc, [0, 7], -1, false), 1, 'a mixed set turns only its painted members');

// ---- the binding: which events reach Paint's turn, and which are left for the browser ----

let handler: ((e: unknown) => void) | null = null;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') handler = fn; } },
});

const { installShortcuts } = await import('../src/app/shortcuts');

const turns: [number, boolean][] = [];
let turnable = true;
const store = { currentMode: 'paint', paintBrush: null, selectedPaintCell: null, paintMultiSel: [] };
let chatFocused = false;
installShortcuts({
  store, viewport: { riding: false }, edit: {}, trickTools: {}, propOps: {}, sculptBrush: {},
  turnPaintTexture: (dir: 1 | -1, flip: boolean) => { turns.push([dir, flip]); return turnable; },
  chatFocused: () => chatFocused,
  openChat: () => {},
} as unknown as Parameters<typeof installShortcuts>[0]);
assert.ok(handler, 'installShortcuts registers a keydown listener');

let prevented = 0;
const press = (key: string, extra: Record<string, unknown> = {}) => {
  prevented = 0;
  handler!({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: null,
    preventDefault: () => { prevented++; }, ...extra });
};

press('ArrowRight');
assert.deepEqual(turns.at(-1), [-1, false], '→ turns a quarter CW (dir −1)');
assert.equal(prevented, 1, 'a handled arrow is swallowed, so the page does not also scroll');
press('ArrowLeft');
assert.deepEqual(turns.at(-1), [1, false], '← turns the other way');
press('ArrowRight', { shiftKey: true });
assert.deepEqual(turns.at(-1), [-1, true], '⇧→ mirrors');
press('ArrowLeft', { shiftKey: true });
assert.deepEqual(turns.at(-1), [1, true], '⇧← mirrors');

// Nothing armed or selected: the turn declines, and the key stays the browser's rather than being eaten.
turnable = false;
press('ArrowRight');
assert.equal(turns.length, 5);
assert.equal(prevented, 0, 'an arrow with nothing to turn is left unhandled');
turnable = true;

// Guards: the arrows belong to Paint alone, and never to a box holding the keyboard.
const quiet = (label: string, key: string, extra: Record<string, unknown> = {}) => {
  const before = turns.length;
  press(key, extra);
  assert.equal(turns.length, before, label);
};
store.currentMode = 'props';
quiet('another mode does not turn a texture', 'ArrowRight');
store.currentMode = 'paint';
quiet('a text field keeps its caret keys', 'ArrowRight', { target: { matches: (s: string) => s.includes('input') } });
chatFocused = true;
quiet('the chat box holds the keyboard outright', 'ArrowRight');
chatFocused = false;
quiet('a modified arrow is not the turn key', 'ArrowRight', { ctrlKey: true });
quiet('nor is an Alt-modified one', 'ArrowRight', { altKey: true });
quiet('the other arrows are unbound', 'ArrowUp');

const settled = turns.length;
press('ArrowRight');
assert.equal(turns.length, settled + 1, 'the binding still works after the guarded presses');
assert.deepEqual(turns.at(-1), [-1, false]);

console.log('PAINT TURN TESTS PASSED');
