// tier: fast

/**
 * The Counter is a checklist, and Play has to run it as one.
 *
 * A persistent `property.counter` installs a count; `counter.mark` ticks off one NUMBERED input and the same
 * number never counts twice; `counter.decrement` steps the count and leaves the mask alone. Reaching zero
 * fires the prop's Trigger effect. Two ways the runtime got this wrong, both of which fired the trigger early
 * and neither of which any existing check could see:
 *
 *   - a prop whose Counter was never installed read as zero-remaining, so the FIRST mark fired the trigger.
 *     Merquer's strike sign lit on one garbage can instead of ten, because a Counter-only persistent graph
 *     carries no emitter and so was never scheduled;
 *   - every mark stepped the count regardless of its input number, so knocking one can twice counted twice.
 *
 * Run: tsx test/effects-counter.test.ts
 */
import {
  applyEffectCounterInput, effectCounterInstall, effectCounterMarkInput, isEffectCounterInput,
  newEffectCounter, type EffectCounterState,
} from '../src/core/effects/counter';
import { EFFECT_TEMPLATES } from '../src/core/effects/authoring';
import { type EffectNode } from '../src/core/effects/document';
import { check, failures } from './check';

const node = (partial: Partial<EffectNode> & { mainType: number; semanticType: string }): EffectNode => ({
  id: `node:${partial.semanticType}:${partial.mainType}`,
  payload: {}, references: {}, ...partial,
} as EffectNode);

/** The retail Merquer shape: MainType 9 marks carrying their input number in `type9.U1`. */
const mark = (input: number): EffectNode =>
  node({ mainType: 9, semanticType: 'counter.mark', payload: { type9: { U0: 1, U1: input } } });
/** The template shape: same command family on MainType 3, input number in `type3.U1`. */
const markType3 = (input: number): EffectNode =>
  node({ mainType: 3, semanticType: 'counter.mark', payload: { type3: { U0: 1, U1: input } } });
const decrement = (): EffectNode =>
  node({ mainType: 3, semanticType: 'counter.decrement', payload: { type3: { U0: 3, U1: 0 } } });
const counterNode = (count: number): EffectNode =>
  node({ mainType: 0, semanticType: 'property.counter',
    payload: { type0: { SubType: 6, Counter: { Count: count, U1: -1 } } } });

// ---- reading the nodes -----------------------------------------------------------------------------------
check(effectCounterInstall(counterNode(10)) === 10, 'a persistent Counter installs its authored count');
check(effectCounterInstall(mark(1)) === null, 'a mark is not a counter install');
check(effectCounterInstall(node({ mainType: 0, semanticType: 'property.debounce' })) === null,
  'an unrelated MainType-0 property is not a counter install');
check(effectCounterMarkInput(mark(9)) === 9, 'a MainType-9 mark reads its input number from type9.U1');
check(effectCounterMarkInput(markType3(4)) === 4, 'a MainType-3 mark reads its input number from type3.U1');
check(effectCounterMarkInput(decrement()) === null, 'a decrement carries no input number');
check(isEffectCounterInput(mark(1)) && isEffectCounterInput(decrement()),
  'both mark and decrement count against a Counter');
check(!isEffectCounterInput(counterNode(2)), 'the Counter itself is not one of its own inputs');

// ---- the checklist ---------------------------------------------------------------------------------------
{
  // Merquer: one Counter of 10 on the building, ten cans each with their own input number.
  const state = newEffectCounter(effectCounterInstall(counterNode(10))!);
  const inputs = [2, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const fired = inputs.map(input => applyEffectCounterInput(state, mark(input)));
  check(fired.filter(Boolean).length === 1 && fired[9] === true,
    'ten distinct marks fire the trigger exactly once, on the tenth');
  check(state.remaining === 0, 'the counter is spent when the trigger fires');
}
{
  const state = newEffectCounter(10);
  check(applyEffectCounterInput(state, mark(3)) === false, 'the first of ten marks does not fire the trigger');
  check(state.remaining === 9, 'the first mark leaves nine to go');
}
{
  // The same can knocked over and over. On hardware "a switch cannot be pressed twice".
  const state = newEffectCounter(3);
  const repeats = Array.from({ length: 8 }, () => applyEffectCounterInput(state, mark(1)));
  check(repeats.every(result => result === false), 'repeating one input never fires the trigger');
  check(state.remaining === 2, 'repeating one input counts once, however many times it arrives');
  check(applyEffectCounterInput(state, mark(2)) === false && state.remaining === 1,
    'a second distinct input still counts');
}
{
  // Decrement is the tally: no input number, so the same source counts every time.
  const state = newEffectCounter(3);
  const results = [decrement(), decrement(), decrement()].map(item => applyEffectCounterInput(state, item));
  check(results.join(',') === 'false,false,true', 'three decrements from one source do fire the trigger');
}
{
  // Mixed: a decrement must not consume an input number, nor be blocked by one.
  const state = newEffectCounter(3);
  applyEffectCounterInput(state, mark(1));
  applyEffectCounterInput(state, decrement());
  check(state.remaining === 1 && state.marked.has(1) && state.marked.size === 1,
    'a decrement steps the count and leaves the input mask alone');
  check(applyEffectCounterInput(state, mark(1)) === false && state.remaining === 1,
    're-marking an already-ticked input cannot finish the counter');
  check(applyEffectCounterInput(state, mark(2)) === true, 'a fresh input finishes it');
}
{
  // A spent counter is retired by the runtime; if one is counted against anyway it must stay quiet rather
  // than fire the trigger column a second time.
  const state: EffectCounterState = newEffectCounter(1);
  check(applyEffectCounterInput(state, mark(1)) === true, 'a one-input counter fires on its only mark');
  check(applyEffectCounterInput(state, mark(2)) === false, 'a spent counter does not fire again');
}
{
  // A Counter of 0 is already finished and has no input that could take it to zero.
  const state = newEffectCounter(0);
  check(applyEffectCounterInput(state, mark(1)) === false, 'a zero-count Counter is not fired by a mark');
}

// ---- the authoring templates the runtime has to agree with -----------------------------------------------
{
  const template = (id: string) => EFFECT_TEMPLATES.find(item => item.id === id);
  const markTemplate = template('counter-mark');
  const decrementTemplate = template('counter-decrement');
  const counterTemplate = template('counter');
  check(!!markTemplate?.nodes?.[0] && effectCounterMarkInput(markTemplate.nodes[0] as EffectNode) !== null,
    'the Mark counter input template lays down a node whose input number the runtime can read');
  check(!!decrementTemplate?.nodes?.[0]
    && effectCounterMarkInput(decrementTemplate.nodes[0] as EffectNode) === null,
    'the Decrement counter template lays down a node with no input number');
  check(!!counterTemplate?.nodes?.[0]
    && effectCounterInstall(counterTemplate.nodes[0] as EffectNode) !== null,
    'the Counter template lays down a node the runtime installs as a counter');
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
