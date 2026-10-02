// tier: fast

import * as THREE from 'three';
import type { PlacedProp, QuadMeshDoc, Screen, V3 } from '../src/core/doc/types';
import { placementQuat } from '../src/core/props/pose';
import { AUTHORED_MODEL_LEVEL } from '../src/core/doc/models';
import { attachEffectToProp, createEmptyEffectsDocument, effectAttachments } from '../src/core/effects/authoring';
import { EFFECT_TRIGGER_LEVEL } from '../src/core/effects/trigger-volume';
import { copyPlacements, pasteGhost, pastePlacements } from '../src/core/props/clipboard';
import type { Store } from '../src/app/state/store';
import type { PropArm } from '../src/app/viewport/scene/props';
import { check, failures } from './check';

/**
 * Props copy / paste (docs/012): the core snapshot — what a copy carries, the anchor a set is carried by, and
 * where a paste lands turned and scaled about it — and the Props-mode session over it: Ctrl+C / X on a
 * selection, Ctrl+V holding the set as a ghost on the cursor, a click dropping it selected, Esc putting it down.
 */

// The session shares the browser toast helper; give it the one DOM node it captures before importing it.
const toasts: string[] = [];
const toastEl = { set textContent(text: string) { toasts.push(text); }, className: '' };
Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => toastEl } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 0, clearTimeout: () => {} } });
const { createPropClipboard } = await import('../src/app/props/clipboard');

type Doc = Pick<QuadMeshDoc, 'name' | 'props' | 'screens' | 'effects' | 'models'>;
const prop = (id: string, extra: Partial<PlacedProp> = {}): PlacedProp =>
  ({ id, level: 'GARI', model: 7, name: 'Mdl_Sign_1', pos: [1, 2, 3], yaw: 30, scale: 1, ...extra });
const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

function sourceDoc(): Doc {
  const effects = createEmptyEffectsDocument('SOURCE');
  effects.slots.push({ id: 'slot:0000', name: 'sign flash', circumstances: { persistent: null, collision: null, trigger: null } } as never);
  attachEffectToProp(effects, 'prop:0000', 'slot:0000', 'collision');
  const screen: Screen = { id: 'screen:0000', prop: 'prop:0000', pos: [0, 1, 0], yaw: 0, width: 4, height: 2 };
  return {
    name: 'SOURCE', effects, screens: [screen],
    props: [
      prop('prop:0000', { labels: ['label:0000'], solid: true }),
      prop('prop:0001', { line: 'line:0000', pos: [5, 0, 5] }),
      { ...prop('prop:0002'), level: EFFECT_TRIGGER_LEVEL, effectTrigger: { size: [2, 2, 2] } },
    ],
  };
}

// ================= core: what a copy carries =================
{
  const doc = sourceDoc();
  const clip = copyPlacements(doc, [2, 1, 0, 0]);
  check(!!clip && clip.entries.length === 2, 'a trigger volume is not copied, and a repeated index copies once');
  const [sign, member] = clip!.entries;
  check(!('id' in sign.prop) && !('line' in member.prop), 'a copy carries no identity: no id, no line membership');
  check(sign.prop.solid === true && sign.prop.labels?.[0] === 'label:0000', 'but every other field comes along');
  check(sign.effect?.slot === 'slot:0000' && sign.effect.circumstance === 'collision', 'the effect slot it carries is recorded');
  check(sign.screens.length === 1 && !('id' in sign.screens[0]) && !('prop' in sign.screens[0]),
    'its attached screen comes too, minus the screen id and the prop it named');
  check(copyPlacements(doc, [2]) === null, 'a selection of nothing copyable copies nothing');
  check(near(clip!.anchor, [3, 0, 4]), 'with no ground to ask, the anchor is the centroid at the lowest origin',
    clip!.anchor.join());
  const grounded = copyPlacements(doc, [0, 1], (x, z) => x === 3 && z === 4 ? -1 : null);
  check(near(grounded!.anchor, [3, -1, 4]), 'with ground, it is the centroid on the ground beneath it');

  // Pasting in place, into the mountain it came from.
  const first = pastePlacements(doc, clip!);
  check(first.indices.join() === '3,4' && first.skipped === 0, 'paste appends one placement per entry');
  const [a, b] = first.indices.map(i => doc.props![i]);
  check(a.id === 'prop:0003' && b.id === 'prop:0004', 'each paste mints a fresh id');
  check(a.pos.join() === '1,2,3' && a.yaw === 30, 'with no destination it lands in place, at the source pose');
  check(b.line === undefined, 'a pasted line member is an ordinary prop');
  check(effectAttachments(doc.effects!).some(x => x.target.id === a.id && x.slot === 'slot:0000'),
    'the paste SHARES the source effect slot, as ＋ place does');
  const pastedScreen = doc.screens!.find(s => s.prop === a.id);
  check(!!pastedScreen && pastedScreen.id === 'screen:0001', 'its screen is re-attached under a new id');
  a.pos[0] = 99;
  check(doc.props![0].pos[0] === 1 && clip!.entries[0].prop.pos[0] === 1, 'the paste is a deep copy');
  const second = pastePlacements(doc, clip!);
  check(second.indices.length === 2 && new Set(doc.props!.map(p => p.id)).size === doc.props!.length,
    'pasting again makes another set, still with unique ids');

  // Into a different mountain.
  const other: Doc = { name: 'OTHER', effects: createEmptyEffectsDocument('OTHER'), models: [] };
  other.effects!.slots.push({ id: 'slot:0000', name: 'unrelated', circumstances: { persistent: null, collision: null, trigger: null } } as never);
  const own = copyPlacements({ ...sourceDoc(), props: [prop('prop:0000', { level: AUTHORED_MODEL_LEVEL, model: 3 }), prop('prop:0001')] }, [0, 1])!;
  check(pasteGhost(other, own).length === 1, 'the ghost leaves out an authored model that belongs to another mountain');
  const across = pastePlacements(other, own);
  check(across.indices.length === 1 && across.skipped === 1, 'and so does the paste');
  check(effectAttachments(other.effects!).length === 0, 'a slot id is not trusted across mountains: no effect is attached');
}

// ================= core: where a carried set lands =================
{
  // Two props a metre either side of the anchor along +X; one tilted, one at double size.
  const doc: Doc = { name: 'M', props: [
    prop('prop:0000', { pos: [9, 1, 0], yaw: 0, scale: 2 }),
    prop('prop:0001', { pos: [11, 0.5, 0], yaw: 10, pitch: 20, roll: 5 }),
  ] };
  const clip = copyPlacements(doc, [0, 1], () => 0)!;
  check(near(clip.anchor, [10, 0, 0]), 'the anchor is the centroid on the ground');
  const ghost = pasteGhost(doc, clip);
  check(near(ghost[0].pos, [-1, 1, 0]) && near(ghost[1].pos, [1, 0.5, 0]),
    'the ghost poses each placement relative to the anchor, keeping its clearance above the ground');
  check(ghost[1].pitch === 20 && ghost[1].roll === 5 && ghost[0].scale === 2, 'with its own tilt and size');

  const { indices } = pastePlacements(doc, clip, { pos: [100, 7, 50], yaw: 90, scale: 2 });
  const [left, right] = indices.map(i => doc.props![i]);
  // A +90° turn takes +X to −Z (core/props/pose rotateY); offsets double with the scale.
  check(near(left.pos, [100, 9, 52]) && near(right.pos, [100, 8, 48]),
    'a drop moves the anchor to the click, turning and scaling the offsets about it',
    `${left.pos.join()} | ${right.pos.join()}`);
  check(left.yaw === 90 && right.yaw === 100, 'the turn adds to each placement’s own');
  check(right.pitch === 20 && right.roll === 5, 'and tilt survives it: the turn composes ahead of the YXZ angles');
  check(left.scale === 4 && right.scale === 2, 'sizes multiply by the drop’s scale');

  // The viewport draws the ghost as the drop pose (pos, turn, size) over each ghost placement's own pose — the
  // props layer's placementPose, twice. A click must land every copy exactly where that drew it.
  const pose = (p: { pos: V3; yaw: number; pitch?: number; roll?: number; scale: number }) => new THREE.Matrix4().compose(
    new THREE.Vector3(...p.pos), new THREE.Quaternion(...placementQuat(p)), new THREE.Vector3(p.scale, p.scale, p.scale));
  const drop = pose({ pos: [100, 7, 50], yaw: 90, scale: 2 });
  check(ghost.every((g, i) => {
    const drawn = drop.clone().multiply(pose(g)).elements, landed = pose(doc.props![indices[i]]).elements;
    return drawn.every((v, k) => Math.abs(v - landed[k]) < 1e-9);
  }), 'every copy lands exactly where the ghost drew it, tilted ones included');
}

// ================= app: the Props-mode session =================
{
  const doc = sourceDoc();
  const store = {
    mdoc: doc, currentMode: 'props', selectedProp: null as number | null, multiSel: [] as number[],
    railDrawing: false, lineDrawing: false, gemArmed: false,
    selectedRail: null, selectedNode: null, selectedGem: null,
  };
  const calls: string[] = [];
  const view = { arm: null as PropArm | null }; // what the viewport is holding
  const session = createPropClipboard({
    store: store as unknown as Store,
    viewport: {
      setLightArmed: () => calls.push('light-down'),
      setPropArmed: (next: PropArm | null) => { view.arm = next; },
      get propPastePlacing() { return !!view.arm?.paste; },
      groundHeightAt: () => 0,
    },
    propOps: {
      disarmProp: () => calls.push('disarm'),
      deselectPropOrLight: () => { store.selectedProp = null; store.multiSel = []; },
      deleteSelectedProp: () => { doc.props!.splice(store.selectedProp!, 1); store.selectedProp = null; },
      deleteMultiSelProps: () => {
        for (const i of [...store.multiSel].sort((x, y) => y - x)) doc.props!.splice(i, 1);
        store.multiSel = [];
      },
      shortPropName: (name: string) => name.replace(/^Mdl_/, '').replace(/_\d+$/, ''),
      ensurePropLevel: async () => { calls.push('load'); return null as never; },
      ensureGroupDefs: async () => [],
    },
    resetGizmoMode: () => calls.push('move-gizmo'),
    scheduleRebuild: () => {}, rebuildTools: () => {}, updateCmdSheet: () => {},
  });

  check(!session.canCopy() && !session.canPaste(), 'nothing selected, nothing copied: neither key acts');
  store.selectedProp = 0;
  store.currentMode = 'edit';
  check(!session.canCopy(), 'the clipboard is Props mode’s own');
  store.currentMode = 'props';
  session.copy();
  check(session.count() === 1 && toasts.at(-1)?.startsWith('copied Sign') === true, 'Ctrl+C copies the selected prop by name');

  await session.paste();
  check(session.placing() && view.arm?.paste?.length === 1 && view.arm.baseOffset === 0,
    'Ctrl+V holds the copy on the cursor as a paste ghost');
  check(near(view.arm!.paste![0].pos, [0, 2, 0]), 'hung off the anchor, which a single prop sits on: its own origin, on the ground');
  check(doc.props!.length === 3 && store.selectedProp === null, 'nothing is placed yet, and the selection gives way');
  check(calls.includes('load') && calls.includes('disarm') && calls.includes('light-down'),
    'its geometry is loaded and whatever was held is put down');

  session.cancel();
  check(!session.placing() && view.arm === null && doc.props!.length === 3, 'Esc puts the paste down, placing nothing');

  await session.paste();
  session.place([20, 1, 20], 0, 1);
  check(doc.props!.length === 4 && near(doc.props![3].pos, [20, 3, 20]),
    'a click drops it where the ghost stood, keeping its clearance above the ground');
  check(store.selectedProp === 3 && calls.includes('move-gizmo'), 'and selects it under the move gizmo');
  check(!session.placing() && view.arm === null, 'one click, one copy: the paste is put down');

  await session.paste();
  view.arm = { level: 'GARI', model: 9, baseOffset: 0 }; // a prop picked from the Library takes the cursor
  check(!session.placing(), 'anything else taking the cursor puts the paste down with it');

  store.selectedProp = null;
  store.multiSel = [0, 1, 2];
  session.cut();
  check(doc.props!.length === 2 && session.count() === 2, 'Ctrl+X copies the set and deletes it');
  check(doc.props!.some(p => p.effectTrigger), 'except a trigger volume in the set, which the clipboard could not take');
  await session.paste();
  session.place([0, 0, 0], 0, 1);
  check(doc.props!.length === 4 && store.multiSel.join() === '2,3' && store.selectedProp === null,
    'a dropped set is selected as one set');

  store.railDrawing = true;
  check(!session.canPaste(), 'not while a rail is being drawn: that tool owns the click');
}

if (failures) process.exitCode = 1;
else console.log('PROP CLIPBOARD PASS');
