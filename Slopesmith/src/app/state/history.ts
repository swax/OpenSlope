import type { RegisterAssignment } from '../net/session-channel';
import type { RegisterStep, RegisterSync } from '../net/register-sync';

/**
 * Undo / redo as inverse assignments (docs/039).
 *
 * Every mutation routes through the rebuild funnel, which calls `scheduleCommit()` to (re)arm a short timer;
 * when edits settle the change is committed as one entry. A burst — a knot drag, a paint stroke, a slider
 * drag — coalesces into ONE entry, exactly as it always did.
 *
 * What an entry HOLDS is the part that shared editing decides. A whole-document snapshot cannot survive it:
 * restoring one would put back everybody else's registers as they stood when the snapshot was taken, erasing
 * their work along with undoing your own. So an ordinary entry records only the registers this participant
 * changed, together with what they held before, and undo RE-ASSERTS those priors as a fresh change rather
 * than rolling any history back. That can put back a value somebody else has since changed — which is the
 * accepted meaning of "put back what I had", and it stays consistent because the re-assertion is an ordinary
 * write like any other.
 *
 * Topology is the exception, because which vertices and quads exist does not decompose into registers. An
 * entry that changed the structure holds the document on both sides of it, and undoing one is itself a
 * topology edit: it takes a compare-and-swap like any other, and the register values it carries are
 * re-asserted with it.
 *
 * Editing alone runs through exactly this. With no register sync attached — the editor talking to no service,
 * or a document nobody else has open — every entry is a document entry and undo is the whole-document restore
 * it has always been.
 */

export interface HistoryEntry {
  index: number;
  summary: string;
  current: boolean;
  direction: 'past' | 'current' | 'future';
}

/** One undoable change: the registers it moved, or the mountain on both sides of a topology edit. */
type Change =
  | { kind: 'registers'; step: RegisterStep; summary: string }
  | { kind: 'document'; before: string; after: string; summary: string };

const count = (value: unknown): number => Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const signed = (n: number, noun: string) => `${n > 0 ? '+' : ''}${n} ${noun}${Math.abs(n) === 1 ? '' : 's'}`;

/** One compact, truthful label for a topology change, from the two documents it sits between. */
function describeDocuments(beforeJson: string, afterJson: string): string {
  const before = JSON.parse(beforeJson) as Record<string, unknown>, after = JSON.parse(afterJson) as Record<string, unknown>;
  const dv = count(after.vertices) / 3 - count(before.vertices) / 3;
  const dq = count(after.quads) - count(before.quads);
  const df = count(after.freeEdges) - count(before.freeEdges);
  if (dv || dq || df || !same(before.quads, after.quads) || !same(before.tJunctions, after.tJunctions)) {
    const parts = [dv ? signed(dv, 'vertex') : '', dq ? signed(dq, 'patch') : '', df ? signed(df, 'free edge') : ''].filter(Boolean);
    return `Mesh topology${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
  }
  return 'Edit mountain';
}

/** What a set of register keys was, in the words the history list uses. The keys say which layer moved, so
 *  the label comes from the change itself rather than from each caller naming what it did. */
export function describeRegisters(keys: readonly string[]): string {
  const has = (test: (key: string) => boolean) => keys.some(test);
  if (has(key => key.startsWith('q/') && (key.endsWith('/paint') || key.endsWith('/tex') || key.endsWith('/orient')))) {
    return 'Paint terrain';
  }
  if (has(key => key.startsWith('o/prop/'))) return 'Edit props';
  if (has(key => key.startsWith('o/rail/'))) return 'Edit rails';
  if (has(key => key.startsWith('o/gem/'))) return 'Edit gems';
  if (has(key => key.startsWith('o/light/'))) return 'Edit lights';
  if (has(key => key.startsWith('o/effect'))) return 'Edit effects';
  if (has(key => key.startsWith('o/model/') || key.startsWith('o/volume/'))) return 'Edit models';
  if (has(key => key === 'g/sun')) return 'Edit sun lighting';
  if (has(key => key === 'g/raceMusic' || key === 'g/raceMusicArrangement')) return 'Edit race music';
  if (has(key => key === 'g/environmentBed')) return 'Edit environment sound';
  if (has(key => key === 'g/boardSound')) return 'Edit board sound';
  if (has(key => key === 'course')) return 'Edit course';
  if (has(key => key.startsWith('h/') || key.endsWith('/twist'))) return 'Shape / smooth terrain';
  if (has(key => key.startsWith('v/'))) return 'Move / shape terrain';
  if (has(key => key.startsWith('g/'))) return 'Edit mountain settings';
  return 'Edit mountain';
}

export function createHistory(deps: {
  /** The live doc serialized to JSON — what a topology entry holds on each side. */
  getDocJson: () => string;
  /** Restore a whole document: the host parses it back into its doc, resets selections and rebuilds. */
  onRestore: (json: string) => void;
  /** Registers were re-asserted onto the live doc, so whatever renders it should. */
  onRefresh?: () => void;
  /** Re-read the undo / redo buttons' enabled state (their depth changed). */
  refreshButtons: () => void;
  /** The register replica, when this document is shared. Absent when it is not, which is what makes editing
   *  alone the same whole-document undo it always was. */
  registers?: () => RegisterSync | null;
}) {
  let undoStack: Change[] = [];
  let redoStack: Change[] = [];
  let commitTimer = 0;
  let suppressCommit = false;
  /** The document as of the last commit — what a topology entry is measured against. */
  let baseline = '';

  const sync = () => deps.registers?.() ?? null;

  /** Arm the debounce: the funnel calls this on every mutation, coalescing a burst into one commit. */
  function scheduleCommit() {
    if (suppressCommit) return;
    clearTimeout(commitTimer);
    commitTimer = window.setTimeout(commit, 350);
  }

  /**
   * Seal whatever has changed since the last commit into one entry.
   *
   * The register step is asked for first, because it is the cheap and the common answer. A structural
   * difference between the two documents is what makes an entry a topology one instead — the register model
   * does not own which vertices and quads exist, so nothing smaller than the mountain would say what happened.
   */
  function commit() {
    clearTimeout(commitTimer);
    const json = deps.getDocJson();
    baseline ||= json;
    const step = sync()?.sealStep() ?? null;
    const structural = json !== baseline && describeDocuments(baseline, json).startsWith('Mesh topology');
    let change: Change | null = null;
    if (structural) {
      change = { kind: 'document', before: baseline, after: json, summary: describeDocuments(baseline, json) };
    } else if (step) {
      change = { kind: 'registers', step, summary: describeRegisters(step.afters.map(([key]) => key)) };
    } else if (json !== baseline) {
      // No replica is watching, so the change is held whole. This is the editor talking to no service.
      change = { kind: 'document', before: baseline, after: json, summary: describeDocuments(baseline, json) };
    }
    baseline = json;
    if (!change) return;
    undoStack.push(change);
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
    deps.refreshButtons();
  }

  /** A different workspace project has no meaningful undo relationship to the previous one. */
  function reset() {
    clearTimeout(commitTimer);
    undoStack = [];
    redoStack = [];
    suppressCommit = false;
    baseline = '';
    sync()?.resetSteps();
    deps.refreshButtons();
  }

  /** Put a set of register values back, as a fresh change. Without a replica there is nothing to assert
   *  against, so the entry cannot have been a register one and this is never reached. */
  function reassert(changes: readonly RegisterAssignment[]): void {
    sync()?.reassert(changes);
    deps.onRefresh?.();
  }

  /** Apply one change in one direction, with the funnel gated so the restore's own mutations do not push a
   *  fresh entry of their own. */
  function apply(change: Change, direction: 'back' | 'forward'): void {
    suppressCommit = true;
    if (change.kind === 'registers') reassert(direction === 'back' ? change.step.priors : change.step.afters);
    else {
      const json = direction === 'back' ? change.before : change.after;
      deps.onRestore(json);
      baseline = json;
      sync()?.resetSteps();
    }
    if (change.kind === 'registers') baseline = deps.getDocJson();
    suppressCommit = false;
    deps.refreshButtons();
  }

  function undo() {
    commit(); // flush any pending edit so the newest change is on the stack first
    const change = undoStack.pop();
    if (!change) return;
    redoStack.push(change);
    apply(change, 'back');
  }

  function redo() {
    const change = redoStack.pop();
    if (!change) return;
    undoStack.push(change);
    apply(change, 'forward');
  }

  /** Every reachable state in chronological order, including the current position. Index 0 is where this
   *  session started; each entry after it is one change. Opening the list flushes an in-progress edit first,
   *  so what the viewport shows is always represented. */
  function entries(): HistoryEntry[] {
    commit();
    const current = undoStack.length;
    const summaries = ['Initial state',
      ...undoStack.map(change => change.summary), ...redoStack.slice().reverse().map(change => change.summary)];
    return summaries.map((summary, index) => ({
      index,
      summary,
      current: index === current,
      direction: index < current ? 'past' : index > current ? 'future' : 'current',
    }));
  }

  /** Move directly to any state, one change at a time — so a register entry re-asserts and a topology entry
   *  restores, exactly as stepping there by hand would. */
  function jumpTo(index: number) {
    commit();
    const depth = undoStack.length + redoStack.length;
    if (!Number.isInteger(index) || index < 0 || index > depth || index === undoStack.length) return;
    while (undoStack.length > index) undo();
    while (undoStack.length < index) redo();
  }

  return {
    scheduleCommit, commit, reset, undo, redo, entries, jumpTo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undoSummary: () => undoStack.length ? undoStack[undoStack.length - 1].summary : null,
    redoSummary: () => redoStack.length ? redoStack[redoStack.length - 1].summary : null,
    recentUndo: (limit = 6) => undoStack.slice().reverse().slice(0, limit).map(change => change.summary),
    recentRedo: (limit = 6) => redoStack.slice().reverse().slice(0, limit).map(change => change.summary),
  };
}

export type History = ReturnType<typeof createHistory>;
