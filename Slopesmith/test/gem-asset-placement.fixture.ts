import GUI from 'lil-gui';
import { defaultMountain } from '../src/core/doc/mountain';
import { createStore } from '../src/app/state/store';
import { configureWorkspace } from '../src/app/net/workspace';
import { assetVersion } from '../src/core/reference/asset-version';
import { referenceAssetId } from '../src/core/reference/asset-manifest';
import { createPropOps } from '../src/app/props/operations';
import { createViewportCallbacks } from '../src/app/viewport-callbacks';
import { createTrickTools } from '../src/app/tricks/operations';
import { buildTrickTools } from '../src/app/ui/tool-panels/tricks';
import type { ToolsContext } from '../src/app/ui/tool-panels/widgets';
import type { LevelProps } from '../src/core/reference/props';

const bank = assetVersion('ssx-tricky', 'TRICKY_ALASKA', 'a'.repeat(64));
const prop = referenceAssetId(bank.game, bank.map, 'prop', '203', '3'.repeat(64));
const texture = referenceAssetId(bank.game, bank.map, 'texture', 'rail.png', '4'.repeat(64));
const store = createStore({ mdoc: defaultMountain(), currentMode: 'props', storedUi: {} });
const library: LevelProps = {
  level: bank.id,
  models: [
    {
      id: 203,
      name: 'Gem_TrickMultiplier_OrangeX3',
      subs: [
        {
          mat: -1,
          positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 0]),
          uvs: new Float32Array(),
          indices: new Uint32Array([0, 1, 2]),
        },
      ],
    },
  ],
  materials: new Map(),
  instances: [],
  crowdFrames: [],
};
configureWorkspace(true, async url => {
  if (url.pathname === '/api/levels') return Response.json({ levels: ['local:ALASKA'] });
  if (url.pathname === '/api/map-asset-version') return Response.json(bank);
  if (url.pathname === '/api/map-asset-manifest')
    return Response.json({
      schema: 'openslope-assets/v1',
      game: bank.game,
      map: bank.map,
      assets: [
        { id: prop, kind: 'prop', key: '203', hash: '3'.repeat(64), files: {} },
        { id: texture, kind: 'texture', key: 'rail.png', hash: '4'.repeat(64), files: {} },
      ],
    });
  if (url.pathname === '/api/props/native-art')
    return Response.json({
      gemLevel: 'ALASKA',
      gemTiers: [
        {
          tier: 3,
          model: 203,
          effect: {
            key: 'gem:ALASKA:3',
            circumstances: {
              collision: [
                {
                  mainType: 14,
                  semanticType: 'score.multiplier',
                  payload: { MultiplierScore: 3 },
                  references: {},
                },
              ],
            },
          },
        },
      ],
      railSkins: {},
    });
  return new Response('', { status: 404 });
});
const viewport = {
  railSkins: {},
  registerPropModels() {},
  setRailSkins() {},
  setGemModels() {},
  setPropArmed() {},
  setLightArmed() {},
  setRailArmed() {},
  setGemArmed() {},
  setLineDrawing() {},
  snapPoint: (pos: number[]) => pos,
};
const ops = createPropOps({
  store,
  viewport,
  groupDefIdx: new Map(),
  propLevels: new Map([
    [bank.id, library],
    [prop, { ...library, level: prop }],
  ]),
} as unknown as Parameters<typeof createPropOps>[0]);
const gemTool = { height: 2, spacing: 4, value: 3 };
const header = document.createElement('div');
document.body.append(header);
let gui: GUI | undefined;
let opened: string | undefined;
const context = {
  store,
  viewport,
  gemTool,
  propPreview: { hide() {} },
  scheduleRebuild() {},
  rebuildTools: render,
  cancelPlacement() {},
  selectSpecialProp(id: string) {
    store.selectedProp = store.mdoc.props!.findIndex(prop => prop.id === id);
    store.gemArmed = false;
  },
  goToEffects() {
    opened = 'effects';
  },
} as unknown as ToolsContext;
function render() {
  gui?.destroy();
  gui = new GUI();
  context.gui = gui;
  context.editSection = (_id, title) => gui!.addFolder(title);
  if (store.gemArmed) buildTrickTools(context);
}
const tools = createTrickTools({
  store,
  viewport,
  gemTool,
  propLibToggle: header,
  ensurePropLevel: ops.ensurePropLevel,
  toggleTricks() {
    store.tricksVisible = true;
  },
  setMode() {},
  scheduleRebuild() {},
  rebuildTools: render,
  log() {},
} as unknown as Parameters<typeof createTrickTools>[0]);
const callbacks = createViewportCallbacks({
  store,
  edit: { viewportCallbacks: {} },
  viewport: () => viewport,
  propOps: () => ops,
  gemTool,
  scheduleRebuild() {},
  rebuildTools: render,
} as unknown as Parameters<typeof createViewportCallbacks>[0]);
const drop = document.createElement('button');
drop.textContent = 'Drop gem';
drop.onclick = () => {
  void callbacks.onPlaceGem!([10, 2, 30]);
};
document.body.append(drop);
(window as unknown as { gemPlacement: unknown }).gemPlacement = {
  state: () => ({ document: store.mdoc, advanced: store.specialPropView, opened }),
  armRail: (texture: string) => tools.armRail({ texture }),
};
