import type { BendAxis, BendSettings } from '../../../core/mesh/subdivision-bend';
import { detail, errorBanner, note, tip, typedRange } from '../components/gui';
import type { ToolsContext } from './widgets';

export function buildSubdivisionBendTools(ctx: ToolsContext) {
  const { edit, editSection, rebuildTools, updateCmdSheet } = ctx;
  const state = edit.subdivisionBendState();
  if (!state) return;
  const group = editSection('subdivision-bend', 'Bend subdivision cage');
  note(group, state.name);
  note(group, 'Bend, then drag cage sections or individual points to refine the shape. Apply keeps the cage editable.');
  const settings = { ...state.settings };
  const coordinates = ['x', 'y', 'z'] as const;
  const position = { x: state.position[0], y: state.position[1], z: state.position[2] };
  const refreshState = () => {
    const current = edit.subdivisionBendState();
    radius.setValue(
      current?.radiusM === null || current?.radiusM === undefined ? '—' : `${current.radiusM.toFixed(1)} m`,
    );
    error.textContent = current?.error ?? '';
    error.style.display = error.textContent ? '' : 'none';
    apply.enable(current?.canApply ?? false);
    if (current) for (let a = 0; a < 3; a++) position[coordinates[a]] = current.position[a];
    resetManual.enable(current?.manual ?? false);
  };
  const refresh = (values: Partial<BendSettings>) => {
    edit.updateSubdivisionBend(values);
    refreshState();
  };
  const rebuild = (values: Partial<BendSettings>) => {
    edit.updateSubdivisionBend(values);
    rebuildTools();
    updateCmdSheet();
  };
  tip(
    group
      .add(settings, 'axis', { 'World X': 0, 'World Y': 1, 'World Z': 2 })
      .name('length axis')
      .onChange((axis: number) => rebuild({ axis: Number(axis) as BendAxis })),
    'The straight axis to wrap into an arc. It starts on the cage’s longest world axis.',
  );
  const directions = Object.fromEntries(
    ([0, 1, 2] as BendAxis[]).filter(axis => axis !== settings.axis).map(axis => [`World ${'XYZ'[axis]}`, axis]),
  );
  group
    .add(settings, 'direction', directions)
    .name('bend toward')
    .onChange((direction: number) => rebuild({ direction: Number(direction) as BendAxis }));
  tip(
    typedRange(group.add(settings, 'angle', -720, 720, 1), {})
      .name('angle (°)')
      .onChange((angle: number) => refresh({ angle })),
    'Total turn along the cage’s length. Type beyond the slider for additional turns; negative angles reverse the bend.',
  );
  const riseAxis = 3 - settings.axis - settings.direction;
  tip(
    group
      .add(settings, 'risePerTurn')
      .name('rise per turn (m)')
      .onChange((risePerTurn: number) => refresh({ risePerTurn })),
    `Offset along World ${'XYZ'[riseAxis]} for each 360° turn. For a descending spring, bend in X/Z and use a negative rise.`,
  );
  note(
    group,
    `Rise axis: World ${'XYZ'[riseAxis]}. Bend in the X/Z plane to make a spring that rises or descends in height.`,
  );
  group
    .add(settings, 'anchor', { Start: 'start', Centre: 'centre', End: 'end' })
    .name('keep fixed')
    .onChange((anchor: BendSettings['anchor']) => refresh({ anchor }));
  const presets = editSection('bend-presets', 'Presets');
  presets.add({ quarter: () => rebuild({ angle: 90, anchor: 'start' }) }, 'quarter').name('quarter pipe (90°)');
  presets.add({ arch: () => rebuild({ angle: -180, anchor: 'centre' }) }, 'arch').name('arch (180°)');
  presets.add({ loop: () => rebuild({ angle: 360, anchor: 'start' }) }, 'loop').name('full turn (360°)');
  presets.add({ reset: () => edit.resetSubdivisionBend() }, 'reset').name('reset bend');
  const handles = editSection('bend-handles', 'Cage handles');
  const selection = { mode: state.mode, index: state.index + 1, transform: state.transform };
  handles
    .add(selection, 'mode', { Sections: 'section', Points: 'point' })
    .name('edit handles')
    .onChange((mode: 'section' | 'point') => edit.selectSubdivisionBendHandle(mode));
  handles
    .add(selection, 'index', 1, state.count, 1)
    .name(state.mode === 'section' ? 'section' : 'point')
    .onChange((index: number) => edit.selectSubdivisionBendHandle(state.mode, index - 1));
  if (state.canTransform)
    handles
      .add(selection, 'transform', { Move: 'move', Rotate: 'rotate', Scale: 'scale' })
      .name('transform')
      .onChange((mode: 'move' | 'rotate' | 'scale') => edit.transformSubdivisionBend(mode));
  for (const axis of [0, 1, 2] as const)
    handles
      .add(position, coordinates[axis])
      .step(0.1)
      .name(`position ${'XYZ'[axis]} (m)`)
      .listen()
      .onChange((value: number) => {
        edit.moveSubdivisionBendHandle(axis, value);
        refreshState();
      });
  const resetManual = handles
    .add({ reset: () => edit.resetSubdivisionBend(true) }, 'reset')
    .name('reset manual edits')
    .enable(state.manual);
  note(
    handles,
    'Click a teal handle, then drag its gizmo. W: move; E: rotate section; R: scale section. Manual edits stay when bend settings change.',
  );
  const radius = detail(group, state.radiusM === null ? '—' : `${state.radiusM.toFixed(1)} m`, 'centre-line radius');
  note(
    group,
    'Use enough length divisions for each turn and keep the bend radius wider than the cage. Separate spring turns with enough rise for the cage thickness.',
  );
  const error = errorBanner(group, state.error ?? '');
  error.style.display = state.error ? '' : 'none';
  const actions = editSection('tool-actions', 'Actions');
  const apply = actions.add({ apply: edit.applySubdivisionBend }, 'apply').name('apply bend (Enter)');
  apply.enable(state.canApply);
  actions.add({ cancel: edit.cancelSubdivisionBend }, 'cancel').name('cancel bend (Esc)');
}
