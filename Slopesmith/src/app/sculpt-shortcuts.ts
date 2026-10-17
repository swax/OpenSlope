import type { BrushOp } from '../core/doc/mountain';

/**
 * Sculpt's tool keys, in panel order — bare letters while Sculpt is the active view, one per tool. Lower and Push
 * have none of their own: Ctrl is the opposite, both held through a stroke and on the key (Ctrl+R lowers, Ctrl+P
 * pushes — which also keeps the browser's reload and print off those chords). The digits stay the view switches
 * and F stays frame, so Flatten takes ⇧F. The shortcut handler, the legend and the panel buttons all read this one
 * table, so a key cannot be bound in one place and advertised as another.
 */
export const SCULPT_TOOL_KEYS = [
  { op: 'raise', key: 'r', shift: false, label: 'R', keys: 'R' },
  { op: 'pull', key: 'p', shift: false, label: 'P', keys: 'P' },
  { op: 'smooth', key: 's', shift: false, label: 'S', keys: 'S' },
  { op: 'flatten', key: 'f', shift: true, label: '⇧F', keys: 'Shift+F' },
  { op: 'grab', key: 'g', shift: false, label: 'G', keys: 'G' },
  { op: 'nudge', key: 'n', shift: false, label: 'N', keys: 'N' },
] as const satisfies readonly { op: BrushOp; key: string; shift: boolean; label: string; keys: string }[];

const OPPOSITE: Partial<Record<BrushOp, BrushOp>> = { raise: 'lower', lower: 'raise', pull: 'push', push: 'pull' };

/** The displacement a tool inverts to under Ctrl (Raise↔Lower, Pull↔Push), or null for a tool without one. */
export function oppositeBrushOp(op: BrushOp): BrushOp | null {
  return OPPOSITE[op] ?? null;
}

/** The tool a key selects in Sculpt (`key` as `KeyboardEvent.key`, any case), or null. With `invert` (Ctrl) only
 *  a tool that has an opposite answers, and it answers with that opposite. */
export function sculptToolForKey(key: string, shift: boolean, invert = false): BrushOp | null {
  const k = key.toLowerCase();
  const op = SCULPT_TOOL_KEYS.find(t => t.key === k && t.shift === shift)?.op ?? null;
  return op && invert ? oppositeBrushOp(op) : op;
}

/** The key a tool's button advertises ({ label: '⇧F', keys: 'Shift+F' } — the second in aria-keyshortcuts form),
 *  or null for a tool reached through Ctrl instead. */
export function sculptToolShortcut(op: BrushOp): { label: string; keys: string } | null {
  const tool = SCULPT_TOOL_KEYS.find(t => t.op === op);
  return tool ? { label: tool.label, keys: tool.keys } : null;
}

/** Turns a stream of wheel events into whole steps (Shift+scroll's brush size). The first event of a gesture
 *  steps at once, so a single mouse notch always lands; after that the deltas gather into ~one-notch steps, so a
 *  trackpad's stream of small deltas walks a few sizes instead of racing through dozens. A pause
 *  longer than `idleMs` starts a fresh gesture. */
export function createWheelStepper(notchPx = 100, idleMs = 400) {
  let gathered = 0,
    last = -Infinity;
  return (e: { deltaY: number; deltaX: number; deltaMode: number; timeStamp: number }): number => {
    // DOM_DELTA_LINE: a classic three-line notch reads as one notch; DOM_DELTA_PAGE: a page is many.
    const scale = e.deltaMode === 1 ? notchPx / 3 : e.deltaMode === 2 ? notchPx * 8 : 1;
    const delta = (e.deltaY || e.deltaX) * scale;
    if (!delta) return 0;
    const fresh = e.timeStamp - last > idleMs;
    last = e.timeStamp;
    if (fresh) {
      gathered = 0;
      return Math.sign(delta);
    }
    gathered += delta;
    const steps = Math.trunc(gathered / notchPx);
    gathered -= steps * notchPx;
    return steps;
  };
}

/** Modifiers held for a sculpt stroke: Ctrl (⌘ on a Mac) inverts, Shift smooths. */
export type SculptModifiers = { invert: boolean; smooth: boolean };

/** The tool a dab actually uses under its held modifiers — the convention Blender, Maya and Mudbox share. Shift
 *  smooths whatever tool is active; Ctrl swaps a displacement for its opposite (Raise↔Lower, Pull↔Push) and
 *  leaves the tools without one alone. */
export function strokeBrushOp(op: BrushOp, { invert, smooth }: SculptModifiers): BrushOp {
  if (smooth) return 'smooth';
  return invert ? (oppositeBrushOp(op) ?? op) : op;
}
