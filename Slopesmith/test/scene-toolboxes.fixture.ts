import { createScenePanel } from '../src/app/ui/chrome/scene-panel';
import { defaultMountain } from '../src/core/doc/mountain';
import { createStore } from '../src/app/state/store';
import { createReferenceMusicStudy } from '../src/app/reference/music-study';
import { createSkybox } from '../src/app/sky/session';
import { note } from '../src/app/ui/components/gui';
import type { ViewState } from '../src/app/viewport/types';

const dock = document.createElement('div');
dock.id = 'dock-right';
dock.style.cssText = 'position:relative;width:370px;max-height:100vh';
document.body.appendChild(dock);
const store = createStore({ mdoc: defaultMountain(), currentMode: 'info', storedUi: {} });
store.mdoc.name = 'Alpine';
store.skyboxVisible = true;
let referenceName = 'Garibaldi';
let selected: number | null = null;
let aiVisible = false;
let syncPreview = () => {};
let view: ViewState = {
  pos: [100, 270, -80],
  target: [184, 187, 25],
  up: [0, 1, 0],
  ortho: false,
  fov: 55,
  near: 0.5,
  zoom: 1,
  orthoHalfH: 100,
};
const panel = createScenePanel({
  camera: {
    getView: () => view,
    applyView: next => {
      view = next;
    },
    getSpaces: () => [
      { id: 'world', label: 'World', origin: [0, 0, 0] },
      { id: 'authored', label: 'Alpine centre', origin: [90, 310, -30] },
      ...(referenceName
        ? [{ id: 'reference', label: `${referenceName} centre`, origin: [0, 100, -100] as [number, number, number] }]
        : []),
    ],
    getName: () => 'Alpine',
    capture: async () => new Blob(),
    viewLink: () => 'http://scene.test/?view=1',
  },
  getDoc: () => store.mdoc,
  getSelected: () => selected,
  setSelected: value => {
    selected = value;
  },
  getSelectedKnots: () => [],
  setSelectedKnots() {},
  scheduleRebuild() {},
  requestCourseSeat() {},
  surfaceOptions: { Snow: 1 },
  isSceneActive: () => true,
  onSelectionChange: () => syncPreview(),
  showOwnBox() {},
  showRefBox() {},
  hasReference: () => !!referenceName,
  getReferenceName: () => referenceName,
  getCourseVisible: () => store.courseGuideOn,
  setCourseVisible: on => {
    store.courseGuideOn = on;
  },
  getNormalsVisible: () => store.normalsOn,
  setNormalsVisible: on => {
    store.normalsOn = on;
  },
  getAiPathsVisible: () => aiVisible,
  setAiPathsVisible: on => {
    aiVisible = on;
  },
  getReferenceAiPaths: () =>
    referenceName
      ? [
          {
            originalIndex: 7,
            name: 'Reference route',
            rating: 50,
            respawnable: true,
            start: false,
            startSlots: [],
            markers: [],
            events: [],
            points: [
              [0, 0, 0],
              [10, 0, 0],
            ],
          },
        ]
      : [],
  highlightReferenceAiPath() {},
  highlightAuthoredAiPath() {},
  courseDraw: { active: () => false, begin() {}, end() {}, points: () => [], removeLast() {} },
});
panel.sunFolder.add({ angle: 55 }, 'angle').name('Sun angle');
panel.godRayFolder.add({ beams: true }, 'beams').name('Beams');
panel.lightingPreviewFolder.add({ preview: true }, 'preview').name('Lighting preview');
panel.lightingPreviewFolder.add({ local: true }, 'local').name('Local lights');
note(panel.lightFolder, 'Reference lighting study');
note(panel.refGodRayFolder, 'Reference glare settings');
note(panel.refCourseFolder, 'Reference course details');
const music = createReferenceMusicStudy(panel.refSoundFolder, panel.sharedSoundFolder);
const sky = createSkybox({
  store,
  viewport: { showSky() {}, setSky() {}, setSkyTopColor() {}, nearestMountainWorld: 'authored' } as never,
  previewFolder: panel.skyPreviewFolder,
  skyFolder: panel.skyFolder,
  refSkyFolder: panel.refSkyFolder,
  persistDoc() {},
  persistUi() {},
  log() {},
  isPreviewSelected: () => ['skybox', 'godrays'].includes(panel.getSceneSel()),
  getPreviewTarget: panel.getSceneTarget,
  onVisibleWorldChange() {},
  refreshView() {},
});
syncPreview = () => sky.syncSkyVisibility();
await sky.initSky();
sky.setupRefSkyUi(referenceName);
await music.setLevel(referenceName);
panel.rebuildScene();
panel.setSceneVisible(true);
panel.selectScene('info');
(window as unknown as { sceneToolboxes: unknown }).sceneToolboxes = {
  state() {
    return {
      category: panel.getSceneSel(),
      target: panel.getSceneTarget(),
      view,
      skyTarget: sky.getActiveGodRayWorld(),
      cards: [...panel.sceneHost.querySelectorAll<HTMLElement>('.sp-scene-card')]
        .filter(card => card.style.display !== 'none')
        .map(card => card.querySelector(':scope > .lil-title')!.textContent),
    };
  },
  async reference(name: string) {
    referenceName = name;
    sky.setupRefSkyUi(name || null);
    await music.setLevel(name || null);
    panel.refreshReferenceAiPaths();
    panel.applySceneSelection();
  },
  selectPath() {
    panel.selectReferenceAiPath(7);
  },
  selectKnot() {
    selected = 0;
    panel.selectScene('course', 'authored');
    panel.refreshSelection();
  },
};
