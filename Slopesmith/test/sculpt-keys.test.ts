// tier: fast

/**
 * Sculpt's keyboard: one letter per tool, Ctrl for the opposite (held through a stroke, or on the key: Ctrl+R
 * lowers, Ctrl+P pushes), and Shift held to smooth. A keymap has no other reader — nothing type-checks that G still reaches Grab, or that a new
 * tool letter has not quietly taken a view digit or F-to-frame — so the table, the modifier rule and the live
 * routing through `installShortcuts` are all checked here, the last with a stub window as chat.test.ts does.
 */
import {
  SCULPT_RADIUS_MIN, brushFalloffHalfRadius, brushFalloffWeight, stepBrushRadius,
  type BrushOp,
} from '../src/core/doc/mountain';
import {
  SCULPT_TOOL_KEYS, createWheelStepper, oppositeBrushOp, sculptToolForKey, sculptToolShortcut, strokeBrushOp,
} from '../src/app/sculpt-shortcuts';
import { modeForShortcut } from '../src/app/mode-shortcuts';
import { check, failures } from './check';

const OPS: BrushOp[] = ['raise', 'lower', 'pull', 'push', 'smooth', 'flatten', 'grab', 'nudge'];

// ---- the table: one key per tool, the Ctrl opposites aside; none taken from the keys every view keeps ----
const keyed = OPS.filter(op => op !== 'lower' && op !== 'push');
check(keyed.every(op => SCULPT_TOOL_KEYS.filter(t => t.op === op).length === 1)
  && SCULPT_TOOL_KEYS.length === keyed.length && !sculptToolShortcut('lower') && !sculptToolShortcut('push')
  && oppositeBrushOp('raise') === 'lower' && oppositeBrushOp('pull') === 'push',
  'sculpt keys: every tool has one key except Lower and Push, which are the Ctrl opposites of Raise and Pull');
check(new Set(SCULPT_TOOL_KEYS.map(t => `${t.shift}:${t.key}`)).size === SCULPT_TOOL_KEYS.length,
  'sculpt keys: no two tools share a key');
check(SCULPT_TOOL_KEYS.every(t => !modeForShortcut(t.key) && !['t', '/', '[', ']'].includes(t.key)
  && !(t.key === 'f' && !t.shift)),
  'sculpt keys: none takes a view digit, the chat keys, the brush-size brackets or bare F (frame)');
check(SCULPT_TOOL_KEYS.every(t => sculptToolForKey(t.key.toUpperCase(), t.shift) === t.op)
  && JSON.stringify(sculptToolShortcut('flatten')) === JSON.stringify({ label: '⇧F', keys: 'Shift+F' }),
  'sculpt keys: lookup ignores letter case, and a button advertises exactly the bound key');
check(sculptToolForKey('r', false, true) === 'lower' && sculptToolForKey('P', false, true) === 'push'
  && ['s', 'g', 'n'].every(k => sculptToolForKey(k, false, true) === null) && sculptToolForKey('f', true, true) === null,
  'sculpt keys: with Ctrl only R and P answer, with their opposites');

// ---- the modifiers: Shift smooths with anything, Ctrl flips only a tool that has an opposite ----
check(OPS.every(op => strokeBrushOp(op, { invert: false, smooth: true }) === 'smooth')
  && OPS.every(op => strokeBrushOp(op, { invert: true, smooth: true }) === 'smooth'),
  'stroke modifiers: Shift smooths whatever tool is active, and wins over Ctrl');
const flipped = Object.fromEntries(OPS.map(op => [op, strokeBrushOp(op, { invert: true, smooth: false })]));
check(flipped.raise === 'lower' && flipped.lower === 'raise' && flipped.pull === 'push' && flipped.push === 'pull'
  && (['smooth', 'flatten', 'grab', 'nudge'] as const).every(op => flipped[op] === op),
  'stroke modifiers: Ctrl swaps Raise↔Lower and Pull↔Push and leaves the tools without an opposite alone');
check(OPS.every(op => strokeBrushOp(op, { invert: false, smooth: false }) === op),
  'stroke modifiers: no modifier, no change');

// ---- the brush ring's shape circle, and the wheel stepping behind Shift+scroll's size ----
check(Math.abs(brushFalloffHalfRadius('linear') - 0.5) < 1e-9 && Math.abs(brushFalloffHalfRadius('sharp') - (1 - Math.SQRT1_2)) < 1e-9
  && Math.abs(brushFalloffHalfRadius('smooth') - Math.sqrt(1 - Math.SQRT1_2)) < 1e-9 && brushFalloffHalfRadius('constant') > 0.98
  && (['smooth', 'linear', 'sharp'] as const).every(f => Math.abs(brushFalloffWeight(f, brushFalloffHalfRadius(f)) - 0.5) < 1e-6),
  'brush ring: the inner circle sits where each falloff drops to half strength, and at the edge for constant');
const wheel = createWheelStepper();
const notch = (deltaY: number, timeStamp: number, deltaMode = 0) => wheel({ deltaY, deltaX: 0, deltaMode, timeStamp });
const mouse = [notch(100, 0), notch(100, 1000), notch(-100, 2000), notch(100, 2100), notch(100, 2200)];
check(mouse.join(',') === '1,1,-1,1,1', 'wheel steps: every mouse notch is one step, slow or spun');
const pad = Array.from({ length: 30 }, (_, i) => notch(12, 5000 + i * 16)).reduce((a, b) => a + b, 0);
check(pad >= 2 && pad <= 5, 'wheel steps: a trackpad swipe of small deltas walks a few steps instead of racing through');
check(notch(3, 9000, 1) === 1 && notch(3, 9100, 1) === 1, 'wheel steps: a line-mode notch (Firefox) counts as one step');

// ---- Shift+scroll brush size: ~15% a notch, at least a metre, whole metres, never under the minimum ----
check(stepBrushRadius(60, -1) === 69 && stepBrushRadius(60, 1) === 52 && stepBrushRadius(60, -2) === 79
  && stepBrushRadius(100, -1) === 115,
  'brush size: a wheel-up notch grows the brush ~15% (past the slider end too), a wheel-down notch shrinks it');
check(stepBrushRadius(2, -1) === 3 && stepBrushRadius(5, -1) === 6 && stepBrushRadius(SCULPT_RADIUS_MIN, 1) === SCULPT_RADIUS_MIN
  && stepBrushRadius(3, 5) === SCULPT_RADIUS_MIN,
  'brush size: a small brush still moves a whole metre a notch, and nothing shrinks it under the minimum');
check(stepBrushRadius(7.5, -1) === 9 && stepBrushRadius(7.5, 1) === 7,
  'brush size: a typed fractional size snaps to whole metres on its first notch');

// ---- the routing: the letters reach the brush in Sculpt only, and ⇧F flattens while bare F still frames ----
let onKeyDown: ((event: unknown) => void) | null = null;
(globalThis as { window?: unknown }).window = {
  addEventListener: (type: string, listener: (event: unknown) => void) => { if (type === 'keydown') onKeyDown = listener; },
};
const { installShortcuts } = await import('../src/app/shortcuts');
const store = { currentMode: 'sculpt' };
const brush = { op: 'raise' as BrushOp, radius: 40 };
const called: string[] = [];
// Any service the routing below does not name answers as a no-op, whether it is a whole layer or one helper.
const noop = new Proxy({}, { get: () => () => undefined });
const named: Record<string, unknown> = {
  store, viewport: { riding: false }, edit: noop, trickTools: noop, propOps: noop, propDeform: { active: false },
  effects: noop, sculptBrush: brush,
  setMode: (mode: string) => called.push(`mode:${mode}`),
  rebuildTools: () => called.push('tools'),
  focusActive: () => called.push('focus'),
  chatFocused: () => false,
  openChat: () => called.push('chat'),
};
installShortcuts(new Proxy(named, { get: (deps, key: string) => key in deps ? deps[key] : () => undefined }) as
  unknown as Parameters<typeof installShortcuts>[0]);
let prevented = 0;
const press = (key: string, extra: Record<string, unknown> = {}) => { prevented = 0; onKeyDown?.({
  key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null,
  preventDefault: () => { prevented++; }, ...extra,
}); };

const reached: BrushOp[] = [];
for (const t of SCULPT_TOOL_KEYS) {
  press(t.shift ? t.key.toUpperCase() : t.key, { shiftKey: t.shift });
  reached.push(brush.op);
}
check(reached.join(',') === SCULPT_TOOL_KEYS.map(t => t.op).join(','),
  'sculpt keys: each letter selects its tool in Sculpt');
check(!called.includes('focus'), 'sculpt keys: ⇧F flattens instead of framing the view');

press('r', { ctrlKey: true });
const ctrlR = brush.op, ctrlRPrevented = prevented;
press('p', { metaKey: true });
check(ctrlR === 'lower' && brush.op === 'push' && ctrlRPrevented === 1 && prevented === 1,
  'sculpt keys: Ctrl+R picks Lower and Ctrl/⌘+P picks Push, and the browser never sees the reload or print');

called.length = 0; brush.op = 'raise';
press('f');
check(called.join(',') === 'focus' && brush.op === 'raise', 'sculpt keys: bare F still frames, and picks no tool');
press('r', { shiftKey: true }); press('g', { ctrlKey: true }); press('n', { altKey: true });
check(brush.op === 'raise', 'sculpt keys: a letter held with Shift, Ctrl or Alt is not a tool pick');
press('4');
check(called.includes('mode:paint') && brush.op === 'raise', 'sculpt keys: the view digits keep switching views');

store.currentMode = 'edit'; called.length = 0;
press('g'); press('s');
check(brush.op === 'raise' && !called.includes('tools'), 'sculpt keys: outside Sculpt the letters leave the brush alone');

if (failures > 0) process.exit(1);
console.log('SCULPT KEYS: PASS');
