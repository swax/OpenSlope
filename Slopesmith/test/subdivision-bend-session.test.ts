// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import type { QuadMeshDoc } from '../src/core/doc/types';
import type { EditViewportPort } from '../src/app/edit/viewport-port';
import type { ToolsContext } from '../src/app/ui/tool-panels/widgets';
import { installTestDom } from './dom-test-support';
import { bendFixture } from './subdivision-bend.fixture';

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
const gui = new GUI();
const editSection = createEditSections(gui);
const viewport = {
  setSurgeryTool(tool: string | null) {
    if (!tool) displayed = store.mdoc;
  },
  showEditDraftPreview(doc: QuadMeshDoc) {
    displayed = doc;
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
  console.log(
    'SUBDIVISION BEND SESSION: PASS (real controls, frozen preview, reset, cancel, one-step apply, stale guard)',
  );
} finally {
  gui.destroy();
  await cleanup();
}
