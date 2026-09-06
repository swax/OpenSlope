/**
 * The Counter is a CHECKLIST, not a tally — and that distinction is the whole mechanism.
 *
 * A persistent `property.counter` node installs a counter on its prop with a required count. Two different
 * nodes count against it, and they differ in a way the count alone cannot express. Both halves live in one
 * word on hardware, and both were read off a live PS2 run (see the `counter` / `counter-mark` /
 * `counter-decrement` templates in `authoring.ts` for the observations):
 *
 *   - `counter.mark` ticks off one NUMBERED input, and the same number never counts twice — "a switch cannot
 *     be pressed twice". A set of distinct switches is what opens one door.
 *   - `counter.decrement` steps the count and leaves the input mask alone: a plain tally of how many times
 *     something happened.
 *
 * Reaching zero fires the prop's TRIGGER effect and retires the counter. Two consequences the runtime has to
 * respect: a prop with NO counter installed has nothing to count down and so nothing to fire, and re-marking
 * an input already ticked off is not progress.
 *
 * MERQUER's strike sign is the shape in retail: one Counter of 10 on a building, ten garbage cans each
 * carrying a Mark with its own input number, and a Trigger effect that lights the sign when all ten are down.
 */
import { type EffectNode } from './document';

export interface EffectCounterState {
  /** Inputs still required before the trigger column fires. */
  remaining: number;
  /** Input numbers already ticked off, so a repeat of the same switch counts once. */
  marked: Set<number>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const wholeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;

/** The count a persistent Counter node installs, or null when this node is not one. */
export function effectCounterInstall(node: EffectNode): number | null {
  if (node.semanticType !== 'property.counter') return null;
  const type0 = isObject(node.payload.type0) ? node.payload.type0 : null;
  const counter = type0 && isObject(type0.Counter) ? type0.Counter : null;
  const count = counter ? wholeNumber(counter.Count) : null;
  return count === null ? null : Math.max(0, count);
}

/** Both nodes that count against a Counter, whichever way they count. */
export const isEffectCounterInput = (node: EffectNode): boolean =>
  node.semanticType === 'counter.mark' || node.semanticType === 'counter.decrement';

/**
 * Which numbered input a Mark ticks off. The command family rides MainType 3 or 9 and the word is U1 of
 * whichever container it lands in, read exactly as the inspector reads it (`semantic-fields.ts`). A Decrement
 * has no input number, and neither does a Mark on an unrecognised container — both fall through to a plain
 * step of the count, which is what a Decrement is.
 */
export function effectCounterMarkInput(node: EffectNode): number | null {
  if (node.semanticType !== 'counter.mark') return null;
  const control = node.mainType === 3 ? node.payload.type3
    : node.mainType === 9 ? node.payload.type9 : null;
  return isObject(control) ? wholeNumber(control.U1) : null;
}

export const newEffectCounter = (count: number): EffectCounterState =>
  ({ remaining: Math.max(0, Math.trunc(count)), marked: new Set() });

/**
 * Count one input against an installed counter, mutating it. Returns true when this input took the counter to
 * zero and the prop's Trigger effect should now run — true at most once per counter, because a spent counter
 * is retired by the caller rather than left at zero to fire again.
 */
export function applyEffectCounterInput(state: EffectCounterState, node: EffectNode): boolean {
  if (state.remaining <= 0) return false;
  const input = effectCounterMarkInput(node);
  if (input !== null) {
    if (state.marked.has(input)) return false;
    state.marked.add(input);
  }
  state.remaining -= 1;
  return state.remaining === 0;
}
