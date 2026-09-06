import type GUI from 'lil-gui';
import { detail, tip } from '../components/gui';
import type { ToolsContext } from './widgets';

/** Semantic-label browser and assignment controls shared by patch, prop, and mixed Edit selections. */
export function createLabelTools(ctx: ToolsContext) {
  const { edit, editSection } = ctx;

  function addSwatch(controller: { domElement: HTMLElement }, color: string | undefined): void {
    if (!color) return;
    const name = controller.domElement.querySelector<HTMLElement>('.lil-name');
    if (!name) return;
    const swatch = document.createElement('span');
    swatch.className = 'sp-label-swatch';
    swatch.style.backgroundColor = color;
    name.prepend(swatch);
  }

  function addCreate(section: GUI): void {
    const draft = { name: '' };
    const input = section.add(draft, 'name').name('new label');
    const field = input.domElement.querySelector('input');
    if (field) field.placeholder = 'river, cliffs, cave…';
    tip(section.add({ create: () => edit.createLabel(draft.name) }, 'create').name('＋ create label'),
      'Create a document label. If patches or props are selected, the new label is assigned to all of them immediately.');
  }

  function buildBrowser(): void {
    if (!edit.labelsAvailable()) return;
    const section = editSection('labels', 'Labels');
    const rows = edit.labelRows();
    if (!rows.length) detail(section, 'No labels yet · create one below');
    for (const row of rows) {
      let mode: 'replace' | 'add' | 'toggle' = 'replace';
      const controller = tip(section.add({ select: () => {
        const selectedMode = mode; mode = 'replace'; edit.selectLabel(row.id, selectedMode);
      } }, 'select').name(`${row.name} · ${row.count}`),
      `${row.patches} ${row.patches === 1 ? 'patch' : 'patches'} · ${row.props} ${row.props === 1 ? 'prop' : 'props'}\n`
        + 'Click to select all members · Shift-click adds · Ctrl/Cmd-click toggles.');
      addSwatch(controller, row.color);
      controller.domElement.querySelector('button')?.addEventListener('click', event => {
        mode = event.shiftKey ? 'add' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace';
      }, { capture: true });
    }
    if (rows.length) {
      const manage = { label: rows[0].id, name: rows[0].name };
      const names = Object.fromEntries(rows.map(row => [row.name, row.id]));
      section.add(manage, 'label', names).name('manage').onChange((id: string) => {
        manage.name = rows.find(row => row.id === id)?.name ?? '';
        nameController.updateDisplay();
      });
      const nameController = section.add(manage, 'name').name('rename').onFinishChange((name: string) => {
        if (!edit.renameLabel(manage.label, name)) {
          manage.name = rows.find(row => row.id === manage.label)?.name ?? '';
          nameController.updateDisplay();
        }
      });
      tip(section.add({ remove: () => edit.deleteLabel(manage.label) }, 'remove').name('delete managed label'),
        'Delete the label definition and remove its membership from every patch and prop. Geometry is unchanged.');
    }
    addCreate(section);
  }

  function buildAssignment(): void {
    if (!edit.labelsAvailable()) return;
    const targets = edit.selectedLabelTargets(), total = targets.quads.length + targets.props.length;
    if (!total) return;
    const section = editSection('labels', 'Labels');
    detail(section, [targets.quads.length ? `${targets.quads.length} ${targets.quads.length === 1 ? 'patch' : 'patches'}` : '',
      targets.props.length ? `${targets.props.length} ${targets.props.length === 1 ? 'prop' : 'props'}` : ''].filter(Boolean).join(' · '),
    'assign to');
    const rows = edit.labelRows();
    if (!rows.length) detail(section, 'No labels yet · create one for this selection');
    for (const row of rows) {
      const state = edit.selectedLabelState(row.id);
      const value = { assigned: state === 'all' };
      const controller = tip(section.add(value, 'assigned').name(row.name).onChange((enabled: boolean) => {
        edit.setSelectedLabel(row.id, enabled);
      }), state === 'some'
        ? 'Assigned to part of this selection. Check to assign it to every selected patch and prop.'
        : state === 'all'
          ? 'Assigned to the entire selection. Uncheck to remove it from every selected patch and prop.'
          : 'Check to assign this label to every selected patch and prop.');
      addSwatch(controller, row.color);
      const checkbox = controller.domElement.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (checkbox) checkbox.indeterminate = state === 'some';
    }
    addCreate(section);
  }

  return { buildBrowser, buildAssignment };
}
