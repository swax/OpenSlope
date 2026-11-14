import type { BendAxis, BendSettings } from '../../../core/mesh/subdivision-bend';
import { detail, errorBanner, note, tip, typedRange } from '../components/gui';
import type { ToolsContext } from './widgets';

export function buildSubdivisionBendTools(ctx: ToolsContext) {
  const { edit, editSection, rebuildTools, updateCmdSheet } = ctx;
  const state = edit.subdivisionBendState();
  if (!state) return;
  const group = editSection('subdivision-bend', 'Bend subdivision cage');
  note(group, state.name);
  note(group, 'Preview a circular bend. Apply keeps the source cage editable; Cancel restores its original shape.');
  const settings = { ...state.settings };
  const refresh = (values: Partial<BendSettings>) => {
    edit.updateSubdivisionBend(values);
    const current = edit.subdivisionBendState();
    radius.setValue(
      current?.radiusM === null || current?.radiusM === undefined ? '—' : `${current.radiusM.toFixed(1)} m`,
    );
    error.textContent = current?.error ?? '';
    error.style.display = error.textContent ? '' : 'none';
    apply.enable(current?.canApply ?? false);
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
    .onChange((direction: number) => refresh({ direction: Number(direction) as BendAxis }));
  tip(
    typedRange(group.add(settings, 'angle', -180, 180, 1), { min: -180, max: 180 })
      .name('angle (°)')
      .onChange((angle: number) => refresh({ angle })),
    'Total turn along the cage’s length. Negative angles reverse the bend.',
  );
  group
    .add(settings, 'anchor', { Start: 'start', Centre: 'centre', End: 'end' })
    .name('keep fixed')
    .onChange((anchor: BendSettings['anchor']) => refresh({ anchor }));
  const presets = editSection('bend-presets', 'Presets');
  presets.add({ quarter: () => rebuild({ angle: 90, anchor: 'start' }) }, 'quarter').name('quarter pipe (90°)');
  presets.add({ arch: () => rebuild({ angle: -180, anchor: 'centre' }) }, 'arch').name('arch (180°)');
  presets.add({ reset: () => rebuild({ angle: 0 }) }, 'reset').name('reset bend');
  const radius = detail(group, state.radiusM === null ? '—' : `${state.radiusM.toFixed(1)} m`, 'centre-line radius');
  note(
    group,
    'Bend follows the existing cage points. Use several box divisions along the length for a smooth quarter pipe or arch.',
  );
  const error = errorBanner(group, state.error ?? '');
  error.style.display = state.error ? '' : 'none';
  const actions = editSection('tool-actions', 'Actions');
  const apply = actions.add({ apply: edit.applySubdivisionBend }, 'apply').name('apply bend (Enter)');
  apply.enable(state.canApply);
  actions.add({ cancel: edit.cancelSubdivisionBend }, 'cancel').name('cancel bend (Esc)');
}
