// tier: fast
import assert from 'node:assert/strict';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import type { PlacedProp, PropLine } from '../src/core/doc/types';
import { assetVersion } from '../src/core/reference/asset-version';
import { referenceAssetId } from '../src/core/reference/asset-manifest';
import type { LevelProps } from '../src/core/reference/props';
import { expandGroupProps, type GroupDef } from '../src/core/reference/groups';
import { createStore } from '../src/app/state/store';
import { configureWorkspace } from '../src/app/net/workspace';
import { clearAssetCatalogue } from '../src/app/net/asset-versions';
import { buildExportFolder } from '../src/core/export/folder';
import type { ExportProvider } from '../src/core/export/provider';

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { getElementById: () => ({ textContent: '', className: '' }) },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { setTimeout: () => 0, setInterval: () => 0 },
});
const { createPropOps } = await import('../src/app/props/operations');
const { createPropLineOps } = await import('../src/app/props/lines');
const { createViewportCallbacks } = await import('../src/app/viewport-callbacks');
const { createPropClipboard } = await import('../src/app/props/clipboard');

const bank = assetVersion('ssx-tricky', 'TRICKY_GARI', 'a'.repeat(64));
const assets = (['prop', 'body'] as const).flatMap(kind =>
  [1, 2].map(model => ({
    kind,
    key: String(model),
    hash: String(model).repeat(64),
    files: {},
    id: referenceAssetId(bank.game, bank.map, kind, String(model), String(model).repeat(64)),
  })),
);
const propId = (model: number) => assets.find(asset => asset.kind === 'prop' && asset.key === String(model))!.id;
const bodyId = (model: number) => assets.find(asset => asset.kind === 'body' && asset.key === String(model))!.id;
const group: GroupDef = {
  id: 'tree',
  name: 'Tree',
  level: bank.id,
  occurrences: 8,
  props: [
    { model: 1, name: 'Trunk', relPos: [0, 0, 0], relYaw: 0 },
    { model: 2, name: 'Leaves', relPos: [1, 2, 0], relYaw: 30 },
  ],
  lights: [
    {
      kind: 'point',
      name: 'Glow',
      relPos: [0, 3, 0],
      dir: [0, -1, 0],
      color: '#abcdef',
      intensity: 2,
      coneCos: 1,
      reach: 5,
    },
  ],
};
let availableBank = bank;
configureWorkspace(true, async url => {
  if (url.pathname === '/api/levels') return Response.json({ levels: ['local:GARI'] });
  if (url.pathname === '/api/map-asset-version') return Response.json(availableBank);
  if (url.pathname === '/api/map-asset-manifest')
    return Response.json({ schema: 'openslope-assets/v1', game: bank.game, map: bank.map, assets });
  if (url.pathname === '/api/groups') return Response.json({ level: bank.id, groups: [group] });
  return new Response('', { status: 404 });
});
const library: LevelProps = {
  level: bank.id,
  materials: new Map(),
  instances: [],
  crowdFrames: [],
  models: [1, 2].map(model => ({
    id: model,
    name: model === 1 ? 'Trunk' : 'Leaves',
    defaults: {
      nativeCollision: {
        mode: 1,
        playerCollision: true,
        responseMass: 5,
        playerBounce: false,
        bounceAmount: 0,
        physicsSource: { level: bank.id, body: model },
      },
      fullBright: model === 2,
    },
    subs: [
      {
        mat: -1,
        positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 100]),
        uvs: new Float32Array(),
        indices: new Uint32Array([0, 1, 2]),
      },
    ],
  })),
};
const levels = new Map<string, LevelProps>([[bank.id, library]]);
for (const asset of assets)
  levels.set(asset.id, {
    ...library,
    level: asset.id,
    models: library.models.filter(model => String(model.id) === asset.key),
  });
const store = createStore({ mdoc: migrateMountain(defaultMountain()), currentMode: 'props', storedUi: {} });
let pasteVisible = false;
const viewport = {
  registerPropModels() {},
  registerGroupDefs() {},
  clearRefPropSelection() {},
  setLightArmed() {},
  setRailArmed() {},
  setGemArmed() {},
  setPropArmed(arm: { paste?: unknown } | null) {
    pasteVisible = !!arm?.paste;
  },
  get propPastePlacing() {
    return pasteVisible;
  },
  clearScreenSelection() {},
  setLineDrawing() {},
  props: { pendingScale: 1 },
  groundHeightAt: () => 0,
};
const groupDefIdx = new Map<string, GroupDef>();
const ops = createPropOps({
  store,
  propLevels: levels,
  viewport,
  groupDefIdx,
  propLib: { highlight() {} },
  scheduleRebuild() {},
  rebuildTools() {},
  updateCmdSheet() {},
  setMode() {},
} as unknown as Parameters<typeof createPropOps>[0]);
await ops.armGroupById('local:GARI', 'tree');
const armed = structuredClone(store.armedProp!);
assert.equal(armed.level, propId(1));
assert.deepEqual(
  armed.groupDefinition?.props.map(member => member.level),
  [propId(1), propId(2)],
);
assert.equal(armed.behaviour.memberBehaviour?.['2'].nativeCollision?.physicsSource?.level, bodyId(2));
const callbacks = createViewportCallbacks({
  store,
  edit: { viewportCallbacks: {} },
  propOps: () => ops,
  propClipboard: () => ({ placing: () => false }),
  scheduleRebuild() {},
  rebuildTools() {},
} as unknown as Parameters<typeof createViewportCallbacks>[0]);
callbacks.onPlaceProp!([10, 1, 20], 90, 2);
assert.deepEqual(
  store.mdoc.props?.map(prop => prop.level),
  [propId(1), propId(2)],
);
assert(store.mdoc.props?.every(prop => !prop.group && prop.assembly === store.mdoc.props![0].assembly));
assert.deepEqual(
  store.mdoc.props?.[1].pos.map(value => Math.round(value)),
  [10, 5, 18],
);
assert.equal(store.mdoc.props?.[1].fullBright, true);
assert.equal(store.mdoc.lights?.[0].assembly, store.mdoc.props?.[0].assembly);
assert.deepEqual(store.mdoc.lights?.[0].pos, [10, 7, 20]);

store.selectedProp = 0;
store.armedProp = null;
ops.replaceSelectedProp();
await ops.armGroupById('local:GARI', 'tree');
const replacement = store.mdoc.props![0];
assert.equal(replacement.level, propId(1));
assert.equal(replacement.groupDefinition?.props[1].level, propId(2));
assert.deepEqual(
  expandGroupProps(replacement, replacement.groupDefinition!).map(prop => prop.level),
  [propId(1), propId(2)],
);

store.armedProp = armed;
const lines = createPropLineOps({
  store,
  viewport,
  propOps: ops,
  groupDefIdx,
  setPropLibWanted() {},
  scheduleRebuild() {},
  rebuildTools() {},
  updateCmdSheet() {},
} as unknown as Parameters<typeof createPropLineOps>[0]);
lines.startLine();
lines.appendNode([0, 0, 0]);
lines.appendNode([10, 0, 0]);
lines.finishLine();
const line = store.mdoc.propLines![0];
assert.equal(line.template.level, propId(1));
assert.equal(line.template.groupDefinition?.props[1].level, propId(2));
assert(store.mdoc.props!.filter(prop => prop.line).every(prop => prop.groupDefinition?.props[1].level === propId(2)));
const reloaded = migrateMountain(JSON.parse(JSON.stringify(store.mdoc)));
assert.deepEqual(reloaded.propLines![0].template, line.template);
assert.deepEqual(reloaded.props![0].groupDefinition?.lights, group.lights);

const legacy: PlacedProp = { level: bank.id, model: 1, name: 'Tree', group: 'tree', pos: [0, 0, 0], yaw: 0, scale: 1 };
const normalized = await ops.prepareReferences({ prop: legacy });
assert.equal(normalized.prop.level, propId(1));
assert.equal(normalized.prop.groupDefinition?.props[1].level, propId(2));
assert.equal(legacy.level, bank.id, 'reuse never mutates the source placement');
const copiedIndex = store.mdoc.props!.push({ ...legacy, id: 'prop:copied' }) - 1;
store.selectedProp = copiedIndex;
const clipboard = createPropClipboard({
  store,
  viewport,
  propOps: ops,
  edit: { mixedEditSelection: () => false },
  setMode() {},
  deleteSelectedLight() {},
  resetGizmoMode() {},
  scheduleRebuild() {},
  rebuildTools() {},
  updateCmdSheet() {},
} as unknown as Parameters<typeof createPropClipboard>[0]);
clipboard.copy();
await clipboard.paste();
assert(clipboard.placing());
clipboard.place([20, 0, 20], 90, 2);
assert.equal(store.mdoc.props!.at(-1)!.groupDefinition?.props[1].level, propId(2));
assert.equal(store.mdoc.props![copiedIndex].level, bank.id, 'pasting pins the copy and leaves its source alone');

const legacyLine: PropLine & { id: string } = {
  id: 'line:legacy',
  scale: 1,
  nodes: [
    [0, 0, 0],
    [10, 0, 0],
  ],
  template: { level: bank.id, model: 1, name: 'Tree', group: 'tree' },
};
store.mdoc.propLines!.push(legacyLine);
assert.equal(lines.relayout(legacyLine), false, 'old templates verify before creating any replacement members');
for (let attempt = 0; attempt < 30 && legacyLine.template.level === bank.id; attempt++)
  await new Promise(resolve => setImmediate(resolve));
assert.equal(legacyLine.template.level, propId(1));
assert.equal(legacyLine.template.groupDefinition?.props[1].level, propId(2));
assert(
  store.mdoc.props!.some(prop => prop.line === legacyLine.id && prop.groupDefinition?.props[1].level === propId(2)),
);

// A delayed verification must never put a deleted line back.
let release: (() => void) | undefined;
let started: (() => void) | undefined;
const waiting = new Promise<void>(resolve => {
  started = resolve;
});
const heldOps = {
  ...ops,
  async prepareReferences<T>(value: T) {
    started!();
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return ops.prepareReferences(value);
  },
};
const pendingLines = createPropLineOps({
  store,
  viewport,
  propOps: heldOps,
  groupDefIdx,
  setPropLibWanted() {},
  scheduleRebuild() {},
  rebuildTools() {},
  updateCmdSheet() {},
} as unknown as Parameters<typeof createPropLineOps>[0]);
const deletedLine = {
  ...legacyLine,
  id: 'line:deleted',
  template: { level: bank.id, model: 1, name: 'Tree', group: 'tree' },
};
store.mdoc.propLines!.push(deletedLine);
pendingLines.relayout(deletedLine);
await waiting;
store.mdoc.propLines = store.mdoc.propLines!.filter(candidate => candidate !== deletedLine);
release!();
for (let attempt = 0; attempt < 30; attempt++) await new Promise(resolve => setImmediate(resolve));
assert(!store.mdoc.props!.some(prop => prop.line === deletedLine.id));

// A bank update must not change the frozen members, layout, or lights when a line is edited after reload.
availableBank = assetVersion(bank.game, bank.map, 'b'.repeat(64));
clearAssetCatalogue();
store.mdoc = reloaded;
assert(lines.relayout(reloaded.propLines![0] as typeof line & { id: string }));
assert.deepEqual(store.mdoc.propLines![0].template, line.template);
const unresolved = await ops.prepareReferences(legacy);
assert.deepEqual(unresolved, legacy, 'an unavailable original group remains asset1, without guessing a new layout');
const recoveringLine: PropLine & { id: string } = {
  id: 'line:recovering',
  scale: 1,
  nodes: [
    [0, 0, 0],
    [10, 0, 0],
  ],
  template: { level: bank.id, model: 1, name: 'Tree', group: 'tree' },
};
store.mdoc.propLines!.push(recoveringLine);
const missingTemplate = recoveringLine.template;
lines.relayout(recoveringLine);
for (let attempt = 0; attempt < 30 && recoveringLine.template === missingTemplate; attempt++)
  await new Promise(resolve => setImmediate(resolve));
assert.equal(recoveringLine.template.level, bank.id);
availableBank = bank;
clearAssetCatalogue();
lines.relayout(recoveringLine);
for (let attempt = 0; attempt < 30 && recoveringLine.template.level === bank.id; attempt++)
  await new Promise(resolve => setImmediate(resolve));
assert.equal(recoveringLine.template.level, propId(1), 'a later exact source is retried without reloading the editor');

const exportDoc = migrateMountain(defaultMountain());
exportDoc.props = [reloaded.props![0]];
let requested: { level: string; model: number }[] = [];
const provider: ExportProvider = {
  async materialTables() {
    return new Map();
  },
  async nativeArt() {
    return { gemLevel: '', gemTiers: [], railSkins: {} };
  },
  async referenceTexture() {
    return new Uint8Array();
  },
  async customSound() {
    return new Uint8Array();
  },
  async courseEffectSound() {
    return new Uint8Array();
  },
  async namedEffectSound() {
    return new Uint8Array();
  },
  async environmentEffectSound() {
    return new Uint8Array();
  },
  async skybox() {
    return { files: [], log: [] };
  },
  async encodePng() {
    return new Uint8Array();
  },
  async decodePng() {
    return { w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) };
  },
  async stageRaceMusic() {
    return { status: 'cleared', files: [], remove: [] };
  },
  async discRecipePaths() {
    return { exportDir: 'GROUPTEST', levelData: 'Maps/GARI', levelDataRelative: '../GARI' };
  },
  async groupDefs(levels) {
    assert.deepEqual(levels, [], 'frozen groups do not re-mine a source bank during export');
    return new Map();
  },
  async modelGeometry(models) {
    requested = [...models];
    return (level, model) => ({
      level,
      model,
      name: 'Tree',
      subs: library.models.find(entry => entry.id === model)!.subs,
    });
  },
  async soundIndex() {
    return null;
  },
  async importedProps() {
    return { models: [], materials: [], instances: [], level: '@import', crowdFrames: [] };
  },
  async particleTexture() {
    return new Uint8Array();
  },
};
await buildExportFolder(exportDoc, provider, { lighting: false });
assert(
  requested.some(entry => entry.level === propId(2) && entry.model === 2),
  'export loads each member from its own exact identity',
);
console.log(
  'Group asset placement: immediate model/body pins, transforms/lights, replacement, lines, save/reload, legacy reuse and export PASS',
);
