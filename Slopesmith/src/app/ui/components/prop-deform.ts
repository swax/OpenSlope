import type GUI from 'lil-gui';
import type { PropDeformOps } from '../../props/deform';
import { note, tip } from './gui';

export function addPropDeformTools(gui: GUI, deform: PropDeformOps) {
  const state = deform.state;
  if (!state) return;
  note(gui, `Deforming ${state.name}`);
  note(gui, 'Pick a turquoise handle, then drag an arrow. Sections move four corners together; rotate or scale a section to twist or taper.');
  const controls = { mode: state.mode, index: state.index, axis: state.axis, slices: state.slices,
    move: () => deform.transform('move'), rotate: () => deform.transform('rotate'),
    scale: () => deform.transform('scale') };
  gui.add(controls, 'mode', { Sections: 'section', Corners: 'corner' }).name('control').onChange(deform.setMode);
  const options = state.mode === 'section'
    ? { Start: 0, 'Start handle': 1, 'End handle': 2, End: 3 }
    : Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`Section ${Math.floor(i / 4) + 1} · corner ${i % 4 + 1}`, i]));
  gui.add(controls, 'index', options).name('selected').onChange((i: number) => deform.select(Number(i)));
  gui.add(controls, 'move').name('move (W)');
  if (state.mode === 'section') { gui.add(controls, 'rotate').name('rotate (E)'); gui.add(controls, 'scale').name('scale (R)'); }
  tip(gui.add(controls, 'axis', { 'Local X': 0, 'Local Y': 2, 'Local Z': 1 }).name('length axis')
    .onChange((a: number) => deform.setAxis(Number(a) as 0 | 1 | 2)), 'Changing the length axis resets the cage. Undo restores it.');
  tip(gui.add(controls, 'slices', { Original: 1, Low: 8, Smooth: 16, Fine: 32 }).name('bend detail')
    .onChange((n: number) => deform.setSlices(Number(n))), 'Adds cuts along the length so a sparse prop can bend. Texture coordinates are interpolated.');
  note(gui, `${state.triangles.toLocaleString()} triangles · Apply saves a new library variant for this placement. Other placements keep their shape.`);
  note(gui, 'Collidable props use the deformed mesh. Escape cancels; Ctrl+Z undoes a cage edit.');
  if (state.folded) note(gui, 'The cage folds over or collapses. Spread its controls apart before applying.');
  const undo = gui.add(deform, 'undo').name('undo cage edit'); if (!state.canUndo) undo.disable();
  const redo = gui.add(deform, 'redo').name('redo cage edit'); if (!state.canRedo) redo.disable();
  gui.add(deform, 'reset').name('reset cage');
  const apply = gui.add({ apply: () => void deform.apply() }, 'apply').name(state.busy ? 'saving…' : 'apply as new variant');
  if (state.folded || state.busy) apply.disable();
  gui.add(deform, 'cancel').name('cancel (Esc)');
  if (state.busy) gui.controllersRecursive().forEach(c => c.disable());
}
