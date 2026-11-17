// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import type { QuadMeshDoc } from '../src/core/doc/types';
import type { EditViewportPort } from '../src/app/edit/viewport-port';
import type { ToolsContext } from '../src/app/ui/tool-panels/widgets';
import { installTestDom } from './dom-test-support';
import { bendFixture } from './subdivision-bend.fixture';
import type { BendHandles } from '../src/app/viewport/tools/subdivision-bend';

const cleanup = installTestDom();
const { default: GUI } = await import('lil-gui');
const { createStore } = await import('../src/app/state/store');
const { createSubdivisionBendTools } = await import('../src/app/edit/subdivision-bend');
const { buildSubdivisionBendTools } = await import('../src/app/ui/tool-panels/subdivision-bend');
const { createEditSections } = await import('../src/app/ui/tool-panels/widgets');
const { clearGui } = await import('../src/app/ui/components/gui');
const fixture = bendFixture();
const store = createStore({ mdoc: fixture.doc, currentMode: 'edit', storedUi: {} });
let displayed: QuadMeshDoc = store.mdoc;
let restored = '';
const history: string[] = [];
let handles: BendHandles | null = null;
const gui = new GUI();
const editSection = createEditSections(gui);
const viewport = {
  setSurgeryTool(tool: string | null) {
    if (!tool) displayed = store.mdoc;
  },
  showEditDraftPreview(doc: QuadMeshDoc) {
    displayed = doc;
  },
  setSubdivisionBendHandles(value: BendHandles | null) {
    handles = value;
  },
} as EditViewportPort;
const edit = createSubdivisionBendTools({
  store,
  viewport: () => viewport,
  commitHistory() {
    const next = JSON.stringify(store.mdoc);
    if (history.at(-1) !== next) history.push(next);
  },
  scheduleRebuild() {
    displayed = store.mdoc;
  },
  rebuildTools,
  updateCmdSheet() {},
  clearSelection() {},
  selectSurfaceControls(id) {
    restored = id;
  },
});
function rebuildTools() {
  clearGui(gui);
  buildSubdivisionBendTools({ store, edit, editSection, rebuildTools, updateCmdSheet() {} } as unknown as ToolsContext);
}
const controller = (name: string) => gui.controllersRecursive().find(c => c._name === name)!;
try {
  const original = JSON.stringify(store.mdoc);
  edit.beginSubdivisionBend(fixture.surface.id);
  assert.equal(store.surgeryTool, 'bend');
  assert.equal(controller('apply bend (Enter)')._disabled, true);
  controller('quarter pipe (90°)').getValue()();
  const quarter = displayed;
  assert.notEqual(JSON.stringify(displayed), original);
  assert.equal(JSON.stringify(store.mdoc), original, 'preview never reaches autosave or history');
  controller('arch (180°)').getValue()();
  assert.equal(edit.subdivisionBendState()!.settings.angle, -180);
  controller('quarter pipe (90°)').getValue()();
  assert.deepEqual(displayed.vertices, quarter.vertices, 'changing angle never bends the last preview');
  controller('reset bend').getValue()();
  assert.equal(JSON.stringify(displayed), original);
  assert.equal(controller('apply bend (Enter)')._disabled, true);
  controller('quarter pipe (90°)').getValue()();
  edit.cancelSubdivisionBend();
  assert.equal(store.surgeryTool, null);
  assert.equal(JSON.stringify(displayed), original);
  assert.equal(restored, fixture.surface.id);
  assert.equal(history.length, 1, 'cancel creates no document history');
  edit.beginSubdivisionBend(fixture.surface.id);
  edit.updateSubdivisionBend({ angle: 90 });
  edit.applySubdivisionBend();
  assert.equal(history.length, 2, 'apply is one document edit');
  assert.notEqual(JSON.stringify(store.mdoc), original);
  assert.equal(store.surgeryTool, null);
  assert(store.mdoc.surfaces![0].subdivision, 'apply keeps the cage live');
  const applied = store.mdoc;
  edit.beginSubdivisionBend(fixture.surface.id);
  edit.updateSubdivisionBend({ angle: 90 });
  store.mdoc = structuredClone(applied);
  store.mdoc.name = 'CHANGED_WHILE_BENDING';
  edit.applySubdivisionBend();
  assert.match(edit.subdivisionBendState()!.error!, /document changed/);
  edit.cancelSubdivisionBend();
  assert.equal(store.mdoc.name, 'CHANGED_WHILE_BENDING', 'a stale preview never overwrites newer edits');
  store.mdoc = structuredClone(fixture.doc);
  edit.beginSubdivisionBend(fixture.surface.id);
  const unedited = JSON.stringify(store.mdoc);
  const originalY = edit.subdivisionBendState()!.position[1];
  controller('position Y (m)').setValue(originalY + 12);
  assert.equal(edit.subdivisionBendState()!.position[1], originalY + 12);
  assert.equal(edit.subdivisionBendState()!.canApply, true, 'manual edits work with zero bend angle');
  assert.equal(controller('reset manual edits')._disabled, false);
  assert.equal(JSON.stringify(store.mdoc), unedited);
  edit.updateSubdivisionBend({ angle: 90 });
  assert.equal(
    edit.subdivisionBendState()!.position[1],
    originalY + 12,
    'bend settings preserve manual edits at the anchor',
  );
  controller('reset manual edits').getValue()();
  assert.equal(edit.subdivisionBendState()!.manual, false);
  assert.equal(edit.subdivisionBendState()!.settings.angle, 90);
  controller('reset bend').getValue()();
  assert.equal(edit.subdivisionBendState()!.canApply, false);
  controller('edit handles').setValue('point');
  assert.equal(edit.subdivisionBendState()!.canTransform, false);
  const drag = handles as unknown as BendHandles;
  const moved = drag.points.map((p, i) =>
    i === 0 ? ([p[0], p[1] + 7, p[2]] as [number, number, number]) : ([...p] as [number, number, number]),
  );
  drag.onChange(moved, false);
  assert.equal(edit.subdivisionBendState()!.canApply, false, 'cannot apply in the middle of a drag');
  (handles as unknown as BendHandles).onChange(moved, true);
  assert.equal(edit.subdivisionBendState()!.canApply, true);
  edit.applySubdivisionBend();
  assert.notEqual(JSON.stringify(store.mdoc), unedited);
  assert.equal(handles, null, 'apply removes the preview handles');
  console.log(
    'SUBDIVISION BEND SESSION: PASS (real controls, frozen preview, reset, cancel, one-step apply, stale guard)',
  );
} finally {
  gui.destroy();
  await cleanup();
}
