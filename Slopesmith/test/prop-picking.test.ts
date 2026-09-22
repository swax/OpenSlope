// tier: fast

import * as THREE from 'three';
import { createPointerRouter } from '../src/app/viewport/input/pointer-router';
import { createScenePicking } from '../src/app/viewport/input/scene-picking';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createPropsLayer } from '../src/app/viewport/scene/props';
import { Stage } from '../src/app/viewport/stage';
import { refitSurfaceTrees } from '../src/app/viewport/mesh/surface-trees';
import { createReferenceDecor } from '../src/app/viewport/scene/reference-decor';
import {
  COLLISION_OVERLAY_ACTIVE_COLOR, COLLISION_OVERLAY_INACTIVE_COLOR, UNITY_COLLISION_OVERLAY_COLOR,
} from '../src/app/viewport/scene/collision-overlay';
import {
  collisionSoundSource, effectSoundSource, registerCollisionSoundIndex,
} from '../src/core/effects/collision-sound';
import { externalSoundSource, resolveExternalSound } from '../src/core/effects/external-sound';
import {
  GEM_PLACEMENT_CURSOR, LIGHT_PLACEMENT_CURSOR, PAINT_CURSOR, PROP_PLACEMENT_CURSOR, RAIL_PLACEMENT_CURSOR,
  viewportCursor,
} from '../src/app/viewport/cursor';
import { placementMatrix } from '../src/core/export/props';
import type { V3 } from '../src/core/doc/types';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { check, failures } from './check';

class FakeDom {
  style: Record<string, string> = {};
  clientWidth = 800;
  clientHeight = 600;
  private handlers = new Map<string, ((event: any) => void)[]>();

  addEventListener(type: string, handler: (event: any) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  dispatch(type: string, event: Record<string, unknown>) {
    const complete = {
      type, button: 0, pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 300,
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...event,
    };
    for (const handler of this.handlers.get(type) ?? []) handler(complete);
  }

  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
}

for (const [level, bank] of [['DONOR', 'course-a'], ['DONOR2', 'course-b'], ['DONOR3', 'course-c']] as const)
  registerCollisionSoundIndex({
    Schema: 'openslope-sound-index/v1', Level: level, Banks: { 2: bank, 3: 'Crowd' },
    CollisionEvents: {
      700: { Group: 2, Slot: 4, Bank: bank, Clip: `Audio/SFX/${bank}/004.wav` },
      701: { Group: 3, Slot: 5, Bank: 'Crowd', Clip: 'Audio/SFX/Crowd/005.wav' },
    },
  });

check(collisionSoundSource('DONOR', 700) === 'DONOR/course-a/004.wav'
  && collisionSoundSource('DONOR', 701) === 'DONOR/Crowd/005.wav'
  && collisionSoundSource('DONOR', 0) === null
  && collisionSoundSource('DONOR', -1) === null,
'Hit-sound events identify their extracted course/crowd WAV paths and omit zero/missing records');
check(effectSoundSource('DONOR', 32) === 'DONOR/course-a/032.wav'
  && effectSoundSource('DONOR2', 3) === 'DONOR2/course-b/003.wav'
  && effectSoundSource('UNKNOWN', 3) === null
  && effectSoundSource('DONOR', -1) === null,
'PlaySound slots identify their extracted course-bank WAV paths and reject unavailable records');
const snowmachine = resolveExternalSound(90);
check(snowmachine?.kind === 'fixed' && snowmachine.bank === 'Snowmachine' && snowmachine.slot === 0
  && externalSoundSource('DONOR3', 90) === 'DONOR3/Snowmachine/000.wav'
  && externalSoundSource('DONOR3', 701) === 'DONOR3/Crowd/005.wav'
  && externalSoundSource('DONOR3', 102) === null,
'External emitters resolve fixed global environment banks while preserving Crowd and dynamic-event handling');
check(viewportCursor('paint', true) === PAINT_CURSOR
  && viewportCursor('paint', false) === ''
  && viewportCursor('props', true) === '',
'The shared Paint icon cursor appears only when terrain clicks apply the armed texture');
check(viewportCursor('props', false, 'prop') === PROP_PLACEMENT_CURSOR
  && PROP_PLACEMENT_CURSOR.includes('copy'),
  'Armed prop placement uses the prop-box add cursor with a copy fallback');
// Every placement tool wears its own glyph, so the pointer says WHICH thing a click is about to drop rather
// than only that it will drop something. All four carry the add badge and the copy fallback of the original.
check(viewportCursor('props', false, 'rail') === RAIL_PLACEMENT_CURSOR
  && viewportCursor('props', false, 'gem') === GEM_PLACEMENT_CURSOR
  && viewportCursor('props', false, 'light') === LIGHT_PLACEMENT_CURSOR
  && new Set([PROP_PLACEMENT_CURSOR, RAIL_PLACEMENT_CURSOR, GEM_PLACEMENT_CURSOR, LIGHT_PLACEMENT_CURSOR]).size === 4,
  'the rail, gem and light tools each wear their own cursor glyph rather than sharing the prop box');
check([RAIL_PLACEMENT_CURSOR, GEM_PLACEMENT_CURSOR, LIGHT_PLACEMENT_CURSOR]
  .every(cursor => cursor.includes('copy') && cursor.includes(encodeURIComponent('M18 15v6M15 18h6'))),
  'and each keeps the add badge and the copy fallback the prop cursor established');
// Effects mode lays motion paths with the rail tool's own gesture, so it is the one non-Props mode that
// shows a placement cursor at all — and only for that tool.
check(viewportCursor('effects', false, 'rail') === RAIL_PLACEMENT_CURSOR
  && viewportCursor('effects', false, 'gem') === ''
  && viewportCursor('edit', false, 'rail') === '',
  'a motion path drawn in Effects mode borrows the rail cursor; no other mode shows one');

const dom = new FakeDom();
const scene = new THREE.Scene();
const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
const terrain = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial());
terrain.position.z = -5;
scene.add(terrain);

const placedPropGroup = new THREE.Group();
const propMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
propMesh.userData.propIndex = 7;
placedPropGroup.add(propMesh);
scene.add(placedPropGroup);

// Mirrors the separate display-only layer used by Effects mode. It sits closer to the camera than the prop,
// but normal Props picking must never raycast it.
const effectDecoration = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.1), new THREE.MeshBasicMaterial());
effectDecoration.position.z = 2;
effectDecoration.raycast = () => {};
scene.add(effectDecoration);

let selected: number | null = null;
let referenceSelected: 'scenery' | 'trick' | null = null;
let selectedSource: string | null = null;
let placed = 0;
let unavailable = 0;
let meshComponentHit: any = null;
const props: any = {
  placedPropGroup,
  propArm: null,
  selectedProp: null,
  multiSelProps: [],
  pendingYaw: 0,
  pendingScale: 1,
  yawManual: false,
  propGhostHit: null,
  seatedDropPos: (point: THREE.Vector3) => [point.x, point.y, -point.z],
  seatPropGhost() {},
  seatProp(index: number) { selected = index; },
  clearSelection() { selected = null; },
};
const emptyGroup = () => { const group = new THREE.Group(); group.visible = false; return group; };
const refSceneryGroup = emptyGroup();
const refTrickGroup = emptyGroup();
const freeLightGroup = emptyGroup();
const sourceGroup = emptyGroup();
const sourcePoint = new THREE.Points(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 4)]),
  new THREE.PointsMaterial({ size: 4 }),
);
sourcePoint.userData.sourceKind = 'sound';
sourcePoint.userData.sourceOrigin = 'reference';
sourceGroup.add(sourcePoint);
const railGroup = emptyGroup();
const gemGroup = emptyGroup();
const referenceInstance = (name: 'scenery' | 'trick') => {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial(), 1);
  mesh.name = name;
  mesh.userData.propLevel = 'TEST';
  mesh.userData.propModel = name === 'scenery' ? 1 : 2;
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
};
refSceneryGroup.add(referenceInstance('scenery'));
refTrickGroup.add(referenceInstance('trick'));
scene.add(refSceneryGroup, refTrickGroup, sourceGroup);
const cameraCtl: any = {
  activePointers: new Set<number>(), touchPts: new Map<number, { x: number; y: number }>(), twist: null,
  orbiting: false, flying: false, seatTargetAhead() {},
};
let pointerRayX = 0;
const stage: any = {
  renderer: { domElement: dom }, container: dom, scene, ray,
  worldRoot: new THREE.Group(), terrainMesh: terrain,
  pickLocalRay: new THREE.Ray(), pickInv: new THREE.Matrix4(),
  pickSurface: Stage.prototype.pickSurface, groundHit: Stage.prototype.groundHit,
  snapDataPoint: (point: V3) => point.map(v => Math.round(v * 10) / 10),
  controls: { enabled: true },
  marqueeEl: { style: {} },
  gizmo: { enabled: true, axis: null, object: null, dragging: false }, gizmoKind: null,
  cb: { onPlaceProp() { placed++; }, onSelectKnot() {}, onClickTargetUnavailable() { unavailable++; } },
  castAt() {
    scene.updateMatrixWorld(true);
    ray.near = 0; ray.far = Infinity;
    ray.ray.set(new THREE.Vector3(pointerRayX, 0, 10), new THREE.Vector3(0, 0, -1));
  },
  pivotAt() { return new THREE.Vector3(0, 0, 0); },
};
const scenePicking = createScenePicking(stage, {
  authoredPropRoots: () => [placedPropGroup],
  referencePropRoots: () => [refSceneryGroup, refTrickGroup],
  lightRoots: () => [freeLightGroup],
  sourceRoots: () => [sourceGroup],
  railRoots: () => [railGroup],
  gemRoots: () => [gemGroup],
  knotTargets: () => [],
  surfaceTargets: () => [{ source: 'authored', object: terrain }],
});
const layers: any = {
  props,
  rideCtl: { riding: false },
  cameraCtl,
  picking: { vertexSourceAtPointer: () => 'authored', pickMeshComponent: () => meshComponentHit },
  scenePicking,
  selection: { placeCornerMarker() {} },
  refDecor: {
    propPickGroups: [refSceneryGroup, refTrickGroup],
    clearSurfaceInspection() {},
    clearPropSelection() {},
    clearSourceSelection() {},
    selectSource(kind: string, index: number) { selectedSource = `${kind}:${index}`; },
    selectPropInstance(mesh: THREE.InstancedMesh) { referenceSelected = mesh.name as 'scenery' | 'trick'; },
  },
  lights: { freeLightGroup, lightArmed: false, clearSelection() {}, clearRigSource() {}, selectRigSource() {} },
  rails: { railGroup, railArmed: false, clearSelection() {} },
  gems: { gemGroup, gemArmed: false, gemLine: null, clearSelection() {} },
  screens: { clearSelection() {} },
  paint: { paintArm: null, cellAtPointer: () => 0, paintSelectAtPointer() {} },
  edgeExtrusion: { active: false },
};
let activeMode = 'props';
let paintPreview: any = null;
const access: any = {
  mode: () => activeMode, isMountain: () => true, terrain: () => terrain, reference: () => null,
  refData: () => null, refLevel: () => '', preview: () => paintPreview, net: () => null, netSpacing: () => 10,
  refSelected: () => false, snapPoint: (point: unknown) => point,
  pickKnot: () => undefined, courseKnots: () => [], createEdgePreviewChanged() {},
};
const host: any = { selectReference() {}, clearRefSelection() {} };
createPointerRouter(stage, { editPickKinds: { point: true, edge: true, patch: true } } as any, layers, access, host);

// Walking owns the mouse as target-aware interaction. A consumed RMB is a grab; a miss retains camera look.
const desktopActions: number[] = [];
const desktopReleases: number[] = [];
let desktopAim: readonly [number, number] | null = null;
let consumeDesktopTarget = true;
let rideOrbit = 0;
layers.rideCtl = {
  riding: true, walking: true,
  setDesktopBoardAim(ndc: readonly [number, number] | null) { desktopAim = ndc; },
  beginDesktopPointer(button: number) { desktopActions.push(button); return consumeDesktopTarget; },
  endDesktopPointer(button: number) { desktopReleases.push(button); return button === 2; },
  orbitCamera(dx: number) { rideOrbit += dx; },
};
dom.dispatch('pointermove', { clientX: 600, clientY: 300, movementX: 0, movementY: 0 });
check(desktopAim?.[0] === 0.5 && desktopAim[1] === 0,
  'walking hover forwards the exact visible cursor as a normalized board-interaction aim');
dom.dispatch('pointerdown', { button: 0 });
dom.dispatch('mousedown', { button: 0 });
dom.dispatch('mouseup', { button: 0 });
check(desktopActions.filter(button => button === 0).length === 1 && desktopReleases.includes(0),
  'LMB begins exactly one desktop interact action across the pointer/mouse compatibility pair');
dom.dispatch('pointerdown', { button: 2 });
dom.dispatch('mousedown', { button: 2 });
dom.dispatch('pointermove', { movementX: 12, movementY: 0 });
dom.dispatch('mouseup', { button: 2 });
check(desktopActions.filter(button => button === 2).length === 1 && desktopReleases.includes(2) && rideOrbit === 0,
  'an actionable RMB becomes one held grab and does not also orbit the camera');
consumeDesktopTarget = false;
dom.dispatch('mousedown', { button: 2 });
dom.dispatch('pointermove', { movementX: 12, movementY: 0 });
dom.dispatch('mouseup', { button: 2 });
check(rideOrbit === 12,
  'an RMB miss retains the existing third-person camera-look fallback');
layers.rideCtl = { riding: false };

dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(selected === 7, 'Props select mode routes a click to the authored prop');
check(placed === 0, 'display-only effect decoration cannot turn a prop click into placement');

placedPropGroup.visible = false;
refSceneryGroup.visible = true;
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(referenceSelected === 'scenery', 'Props select mode routes a click to reference scenery');

referenceSelected = null;
refSceneryGroup.visible = false;
refTrickGroup.visible = true;
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(referenceSelected === 'trick', 'Props select mode routes a click to visible reference trick props');

refTrickGroup.visible = false;
sourceGroup.visible = true;
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(selectedSource === 'sound:0', 'A visible speaker icon routes to source inspection ahead of scene geometry');
sourceGroup.visible = false;
refTrickGroup.visible = true;

referenceSelected = null;
refTrickGroup.visible = true;
props.propArm = { level: 'TEST', model: 1, baseOffset: 0 };
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(referenceSelected === null && placed === 1,
  'Place Prop mode owns LMB even when a reference prop is under the pointer');

selected = null;
refTrickGroup.visible = false;
placedPropGroup.visible = true;
props.propArm = { level: 'TEST', model: 1, baseOffset: 0 };
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(selected === null && placed === 2, 'Props placing mode intentionally places until the held prop is put down');

meshComponentHit = { kind: 'line', source: 'authored' };
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(placed === 3, 'An authored edge under the pointer cannot block prop placement');
check(unavailable === 0, 'Prop placement does not show an unavailable edge warning');
meshComponentHit = null;

let pickedPlacedProp: number | null = null;
stage.cb.onPickPlacedProp = (index: number) => { pickedPlacedProp = index; };
dom.dispatch('pointerdown', { button: 1 });
dom.dispatch('pointerup', { button: 1 });
check(pickedPlacedProp === 7, 'Props middle-click selects the model and arms prop placement');

// After an in-place terrain edit, the preview's refit pick tree knows the new surface but a stock mesh
// raycast can still reject it against the old bounding sphere. Drive the real ghost + wheel + click path.
{
  const geometry = terrain.geometry, positions = geometry.getAttribute('position');
  stage.groundHit(); // warm the same pick tree the real placement hover reads
  geometry.computeBoundingSphere();
  for (let i = 0; i < positions.count; i++) positions.setX(i, positions.getX(i) + 300);
  positions.needsUpdate = true;
  const moved = new THREE.Box3(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(400, 100, 100));
  refitSurfaceTrees(geometry, [moved]);
  pointerRayX = 300; stage.castAt();
  check(!ray.intersectObject(terrain, false).length && !!stage.groundHit(),
    'placement regression: edited terrain is visible to the hover picker but missed by the old click raycast');

  const assets = createPropAssets();
  assets.propGeom.set('DROP:0', [{ geometry: new THREE.BoxGeometry(100, 100, 100), level: 'DROP',
    tex: null, frames: [], crowdFrames: [], mat: 0 }]);
  const held = createPropsLayer(stage, assets, {} as any);
  held.setArmed({ level: 'DROP', model: 0, baseOffset: 2 });
  held.pendingYaw = 30;
  layers.props = held;
  const drops: { pos: V3; yaw: number; scale: number }[] = [];
  const originalPlace = stage.cb.onPlaceProp;
  stage.cb.onPlaceProp = (pos: V3, yaw: number, scale: number) => { drops.push({ pos: [...pos], yaw, scale }); };
  dom.dispatch('pointermove', {});
  dom.dispatch('wheel', { deltaY: -1 });
  dom.dispatch('wheel', { deltaY: -1, shiftKey: true });
  check(held.propGhost?.visible && held.pendingYaw === 45 && held.pendingScale === 1.1,
    'the real prop preview follows the edited ground and preserves wheel rotation and scale');
  const previewPose = held.propGhost!.matrix.clone();
  dom.dispatch('pointerdown', {});
  dom.dispatch('pointerup', {});
  check(drops.length === 1 && drops[0].yaw === 45 && drops[0].scale === 1.1
    && held.placementPose(drops[0]).equals(previewPose),
  'click lands exactly one prop at the preview pose, including snapped base offset, wheel turn and scale');
  dom.dispatch('pointerdown', {});
  dom.dispatch('pointerup', {});
  check(drops.length === 2 && held.propArm !== null && drops[1].yaw === 45,
    'repeat clicks keep stamping the held prop with its manually chosen rotation');
  pointerRayX = 310; // touch can land somewhere new without a preceding hover
  dom.dispatch('pointerdown', { pointerType: 'touch' });
  dom.dispatch('pointerup', { pointerType: 'touch' });
  check(drops.length === 3 && drops[2].pos[0] === 310,
    'a touch tap also lands exactly one prop at the new hit without a preceding hover');
  pointerRayX = 1000;
  dom.dispatch('pointerdown', {});
  dom.dispatch('pointerup', {});
  check(drops.length === 3 && !held.propGhost?.visible,
    'a click off the terrain does not stamp the last valid preview position');

  held.setArmed(null); layers.props = props; stage.cb.onPlaceProp = originalPlace;
  pointerRayX = 0;
  for (let i = 0; i < positions.count; i++) positions.setX(i, positions.getX(i) - 300);
  positions.needsUpdate = true; refitSurfaceTrees(geometry, [moved]);
}

// Paint uses a deliberate two-step contract: ordinary LMB only inspects/selects, while MMB selects and arms.
// Shift+LMB remains range selection. The middle-clicked tile keeps its exact ride feel + D4.
activeMode = 'paint';
props.propArm = null;
placedPropGroup.visible = false;
let selectedPaint = 0;
let selectedWithShift = false;
let sampled: any = null;
let painted = 0;
layers.paint.paintArm = null;
layers.paint.paintSelectAtPointer = (shift: boolean) => { selectedPaint++; selectedWithShift = shift; };
paintPreview = {
  facesPerCell: 2,
  cellTex: ['TEST/0001.png'],
  cellSurf: [3],
  cellOrient: [{ rot: 2, mirror: true }],
};
stage.cb.onPick = (pick: unknown) => { sampled = pick; };
stage.cb.onPaintCell = () => { painted++; };
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(selectedPaint === 1 && sampled === null,
  'An ordinary unarmed Paint click selects the terrain texture without arming it');

dom.dispatch('pointerdown', { shiftKey: true });
dom.dispatch('pointerup', { shiftKey: true });
check(selectedPaint === 2 && selectedWithShift && sampled === null,
  'Shift-click keeps Paint range selection without arming a sampled brush');

dom.dispatch('pointerdown', { button: 1 });
dom.dispatch('pointerup', { button: 1 });
check(selectedPaint === 3 && sampled?.ref === 'TEST/0001.png' && sampled.surface === 3
  && sampled.rot === 2 && sampled.mirror,
  'Paint middle-click selects and arms the terrain texture with its ride feel and D4');

let inspectedPropRef: string | null = null;
let inspectedSurface = 0;
placedPropGroup.visible = true;
propMesh.userData.propTexLevel = 'TEST';
propMesh.userData.propTex = '0002.png';
layers.refDecor.inspectSurface = () => { inspectedSurface++; };
stage.cb.onInspectPropTexture = (ref: string | null) => { inspectedPropRef = ref; };
sampled = null;
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(inspectedSurface === 1 && inspectedPropRef === 'TEST/0002.png' && sampled === null,
  'An unarmed Paint click inspects the exact prop surface without arming it');
dom.dispatch('pointerdown', { button: 1 });
dom.dispatch('pointerup', { button: 1 });
check(inspectedSurface === 2 && sampled?.ref === 'TEST/0002.png',
  'Paint middle-click inspects and arms the exact textured prop surface');

placedPropGroup.visible = false;
sampled = null;
layers.paint.paintArm = { ref: 'TEST/0001.png', rot: 0, mirror: false };
dom.dispatch('pointerdown', {});
dom.dispatch('pointerup', {});
check(painted === 1 && sampled === null, 'An armed Paint click paints instead of sampling');
activeMode = 'props';
paintPreview = null;

// Props owns the semantic reference selection; Effects may reuse its outline geometry but must never notify or
// clear the Props preview state. This is the regression boundary for the old rebuildTools → hidden Effects cleanup
// feedback loop that erased a successfully raycast reference prop immediately after selection.
const referenceSelectionEvents: (string | null)[] = [];
const referenceLightEvents: (string | null)[] = [];
let referenceEmitterCount = 0;
const decorRefRoot = new THREE.Group();
const decor = createReferenceDecor({
  refRoot: decorRefRoot,
  cb: { onSelectReferenceProp(level: string | null, _model: number | null, _name: string | null, inst?: { externalSounds: unknown[] }) {
    referenceSelectionEvents.push(level);
    referenceEmitterCount = inst?.externalSounds.length ?? 0;
  }, onSelectReferenceLight(level: string | null, light: { name: string } | null) {
    referenceLightEvents.push(level && light ? `${level}:${light.name}` : null);
  } },
} as any, createPropAssets());
decor.setEffectPropIndices([42, 43]);
decor.setProps({
  level: 'TEST',
  models: [{
    id: 3,
    name: 'billboard',
    subs: [{
      mat: -1,
      positions: new Float32Array([-50, 0, 0, 50, 0, 0, 0, 100, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
      indices: new Uint32Array([0, 1, 2]),
    }],
  }],
  instances: [
    {
      sourceIndex: 42, ltgState: 0, model: 3, loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      name: 'billboard-42', visible: true, playerCollision: true, playerBounce: true,
      collisionSound: -1, contact: 'solid',
      bounce: 0.5, surface: -1, shape: 1, responseMass: 1e30, dynamicMass: -1, physicsBody: -1, collisionModels: ['native'],
      externalSounds: [{ type: 0, sound: 99, offset: [100, 0, 0], params: [500, 2] }],
    },
    {
      sourceIndex: 43, ltgState: 0, model: 3, loc: [2, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      name: 'billboard-43', visible: false, playerCollision: true, playerBounce: true,
      collisionSound: -1, contact: 'solid',
      bounce: 0.5, surface: -1, shape: 1, responseMass: 1e30, dynamicMass: -1, physicsBody: -1, collisionModels: ['native'], externalSounds: [],
    },
    {
      sourceIndex: 44, ltgState: 0, model: 3, loc: [0, 0, 1], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      name: 'mode0-visual-44', visible: true, playerCollision: false, playerBounce: false,
      collisionSound: 44, contact: 'ghost',
      bounce: -1, surface: -1, shape: 0, responseMass: 0, dynamicMass: -1, physicsBody: -1, collisionModels: [], externalSounds: [],
    },
  ],
  materials: new Map([[-1, { tex: null, frames: [] }]]),
  crowdFrames: [],
  collisionMeshes: new Map([['native', {
    positions: new Float32Array([-7, 0, 0, 7, 0, 0, 0, 14, 0]),
    indices: new Uint32Array([0, 1, 2]),
  }]]),
  physicsBodies: new Map(),
});
const referenceEffectOverlays = decor.effectPropGroups[2].children.filter(object => object instanceof THREE.Mesh) as THREE.Mesh[];
check(referenceEffectOverlays.length > 0 && referenceEffectOverlays.every(object => object.renderOrder === 90
  && (object.material as THREE.MeshBasicMaterial).opacity === 0.72),
  'Effects host wires render as a strong purple pass above ordinary prop wireframes');
decor.setRuntimeInstanceVisible(42, true);
decor.setRuntimeInstanceWorldCopies(42, [
  new THREE.Matrix4().makeTranslation(10, 0, 0),
  new THREE.Matrix4().makeTranslation(20, 0, 0),
]);
const runtimeCopyDraws = decor.propPickGroups[0].children
  .filter((object): object is THREE.InstancedMesh => object instanceof THREE.InstancedMesh
    && object.userData.runtimeInstanceCopies === true);
const runtimeCopyPose = new THREE.Matrix4();
runtimeCopyDraws[0]?.getMatrixAt(1, runtimeCopyPose);
check(runtimeCopyDraws.length === 1 && runtimeCopyDraws[0].count === 2
  && Math.abs(new THREE.Vector3().setFromMatrixPosition(runtimeCopyPose).x - 20) < 1e-9,
  'Reference effects can draw transient shared-model copies at independent world poses');
decor.setRuntimeInstanceVisible(42, false);
runtimeCopyDraws[0]?.getMatrixAt(0, runtimeCopyPose);
check(Math.abs(runtimeCopyPose.determinant()) < 1e-12,
  'Runtime visibility hides spline copies together with their native source placement');
decor.setRuntimeInstanceVisible(42, true);
decor.setRuntimeInstanceWorldCopies(42, null);
check(!decor.propPickGroups[0].children.some(object => object.userData.runtimeInstanceCopies),
  'Clearing a spline motion removes its transient renderer copies');

// Refresh starts persistent effects while the reference prop build is still yielding. Reproduce the ordering that
// used to strand a valid 15-copy mover with an empty renderer draw set until manual Preview rebuilt it.
const progressiveRoot = new THREE.Group();
const progressiveDecor = createReferenceDecor({ refRoot: progressiveRoot, cb: {} } as any, createPropAssets());
const progressiveCopyPoses = Array.from({ length: 14 }, (_, index) =>
  new THREE.Matrix4().makeTranslation(index + 1, 0, 0));
let requestedBeforeTarget = false;
await progressiveDecor.setPropsProgressive({
  level: 'TEST',
  models: [
    { id: 1, name: 'first-model', subs: [{ mat: -1,
      positions: new Float32Array([-10, 0, 0, 10, 0, 0, 0, 20, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]), indices: new Uint32Array([0, 1, 2]) }] },
    { id: 2, name: 'late-gondola', subs: [{ mat: -1,
      positions: new Float32Array([-10, 0, 0, 10, 0, 0, 0, 20, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]), indices: new Uint32Array([0, 1, 2]) }] },
  ],
  instances: [
    { sourceIndex: 1, ltgState: 0, model: 1, loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      name: 'first', visible: true, playerCollision: false, playerBounce: false, collisionSound: -1,
      contact: 'ghost', bounce: -1, surface: -1, shape: 0, responseMass: 0, dynamicMass: -1,
      physicsBody: -1, collisionModels: [], externalSounds: [] },
    { sourceIndex: 42, ltgState: 0, model: 2, loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      name: 'late-gondola', visible: false, playerCollision: false, playerBounce: false, collisionSound: -1,
      contact: 'ghost', bounce: -1, surface: -1, shape: 0, responseMass: 0, dynamicMass: -1,
      physicsBody: -1, collisionModels: [], externalSounds: [] },
  ],
  materials: new Map([[-1, { tex: null, frames: [] }]]), crowdFrames: [], collisionMeshes: new Map(),
  physicsBodies: new Map(),
}, async () => {
  if (!requestedBeforeTarget) {
    progressiveDecor.setRuntimeInstanceWorldCopies(42, progressiveCopyPoses);
    requestedBeforeTarget = true;
  }
}, 0);
// The next ambient animation frame supplies fresh visibility + poses. It must both notice that the once-empty
// source now exists and override the hidden native template, as the Chair_4000 mover does on Snowdream.
progressiveDecor.setRuntimeInstanceVisible(42, true);
progressiveDecor.setRuntimeInstanceWorldCopies(42, progressiveCopyPoses);
const progressiveCopies = progressiveDecor.propPickGroups[0].children.filter(
  (object): object is THREE.InstancedMesh => object instanceof THREE.InstancedMesh
    && object.userData.runtimeInstanceCopies === true);
const progressiveVisiblePose = new THREE.Matrix4();
progressiveCopies[0]?.getMatrixAt(0, progressiveVisiblePose);
check(requestedBeforeTarget && progressiveCopies.length === 1 && progressiveCopies[0].count === 14
  && Math.abs(progressiveVisiblePose.determinant()) > 1e-12,
  'Ambient spline copies reconcile and reveal a hidden mover after its prop geometry arrives during refresh');
const inlineBreakDocument = createEmptyEffectsDocument('TEST');
inlineBreakDocument.graphs.push({
  id: 'graph:inline-break', nodes: [{
    id: 'graph:inline-break/node:0000', mainType: 0, semanticType: 'property.breakable-kill',
    payload: { type0: { SubType: 5, DeadNodeMode: 4 } }, references: {},
  }],
});
inlineBreakDocument.slots.push({
  id: 'slot:inline-break', originalIndex: 0,
  circumstances: { persistent: null, collision: 'graph:inline-break', slot3: null, slot4: null,
    trigger: null, slot6: null, slot7: null },
});
decor.setEffectsData({
  level: 'TEST', document: inlineBreakDocument, instances: [{
    index: 42, name: 'billboard-42', modelName: 'billboard', model: 3,
    loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
    effectSlotIndex: 0, visible: true, collisionSound: -1, contact: 'through',
  }],
});
const referenceRideColliders = decor.rideColliders();
const rideThroughBreak = referenceRideColliders.find(collider =>
  collider.object.kind === 'reference' && collider.object.index === 42);
const ordinarySolid = referenceRideColliders.find(collider =>
  collider.object.kind === 'reference' && collider.object.index === 43);
check(referenceRideColliders.length === 2 && rideThroughBreak?.solid === false && rideThroughBreak.bounce === 0
  && ordinarySolid?.solid === true && ordinarySolid.bounce === 0.5,
  'Reference Play keeps an immediate self-break as a contact sensor while ordinary native props stay solid');
check(referenceRideColliders.map(collider => collider.object.kind === 'reference' ? collider.object.index : -1)
  .sort((a, b) => a - b).join(',') === '42,43',
  'Reference Play colliders preserve original instance identities for hit sounds and collision graphs');
check(referenceRideColliders.every(collider => collider.geometry?.getAttribute('position').getX(0) === -7),
  'Reference Play uses the dedicated native collision proxy rather than visible render geometry');
check(referenceRideColliders.some(collider => collider.object.kind === 'reference' && collider.object.index === 43),
  'A native invisible collision twin remains active when PlayerCollision is enabled');
check(!referenceRideColliders.some(collider => collider.object.kind === 'reference' && collider.object.index === 44),
  'A visible mode-0 host cannot manufacture contact from its render mesh or collision-sound row');
decor.setRuntimeInstanceVisible(42, false);
const modeHiddenReferenceColliders = decor.rideColliders();
check(!modeHiddenReferenceColliders.some(collider => collider.object.kind === 'reference' && collider.object.index === 42)
  && modeHiddenReferenceColliders.some(collider => collider.object.kind === 'reference' && collider.object.index === 43),
  'A mode-hidden reference prop retires contact without suppressing a native invisible collision twin');
decor.setRuntimeInstanceVisible(42, null);
decor.setEffectsData(null);

// A native mode-1 collision pointer carries one proxy per non-empty model object. The Elysium iris door is the
// minimal failure shape: object 0 is a stationary frame and object 1 is a sliding panel. Every proxy used to
// share entries[0]'s pose, so the panel drew open while its collision stayed in the doorway.
const animatedColliderRoot = new THREE.Group();
const animatedColliderDecor = createReferenceDecor({ refRoot: animatedColliderRoot, cb: {} } as any, createPropAssets());
const staticAnimationObject = {
  parent: -1, restPosition: [0, 0, 0] as V3,
  restRotation: [0, 0, 0, 1] as [number, number, number, number], restScale: [1, 1, 1] as V3,
};
animatedColliderDecor.setProps({
  level: 'TEST',
  models: [{
    id: 9, name: 'two-piece-iris', animation: {
      clipFrames: 30,
      objects: [staticAnimationObject, {
        ...staticAnimationObject, parent: 0, basePosition: [0, 0, 0] as V3, baseEuler: [0, 0, 0] as V3,
        channels: [
          [[0, 0, 100, 0, 0, 1]], null, null, null, null, null,
        ],
      }],
    },
    subs: [0, 1].map(object => ({
      mat: -1, object,
      positions: new Float32Array([-10, 0, 0, 10, 0, 0, 0, 20, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]), indices: new Uint32Array([0, 1, 2]),
    })),
  }],
  instances: [{
    sourceIndex: 88, ltgState: 0, model: 9, loc: [1000, 2000, 3000], rot: [0, 0, 0, 1], scale: [1, 1, 1],
    name: 'iris-88', visible: true, playerCollision: true, playerBounce: true, collisionSound: -1,
    contact: 'solid', bounce: 0.5, surface: -1, shape: 1, responseMass: 1e30, dynamicMass: -1,
    physicsBody: -1, collisionModels: ['frame-proxy', 'panel-proxy'], externalSounds: [],
  }],
  materials: new Map([[-1, { tex: null, frames: [] }]]), crowdFrames: [],
  collisionMeshes: new Map(['frame-proxy', 'panel-proxy'].map(id => [id, {
    positions: new Float32Array([-9, 0, 0, 9, 0, 0, 0, 18, 0]),
    indices: new Uint32Array([0, 1, 2]),
  }])),
  physicsBodies: new Map(),
});
// Capture the Play sources while the door is shut, exactly as a ride does at launch, then move the clip.
const animatedColliderSources = animatedColliderDecor.rideColliders();
check(animatedColliderDecor.setAnimObjectScrubFrame(88, 30),
  'A hierarchical reference prop can be held at its open clip frame');
// liveMatrix may reuse a provider-owned scratch, so consume each answer immediately as the ride refit does.
const framePose = animatedColliderSources[0]?.liveMatrix?.().clone();
const panelPose = animatedColliderSources[1]?.liveMatrix?.().clone();
const framePosition = framePose && new THREE.Vector3().setFromMatrixPosition(framePose);
const panelPosition = panelPose && new THREE.Vector3().setFromMatrixPosition(panelPose);
check(animatedColliderSources.length === 2 && !!framePosition && !!panelPosition
  && Math.abs(framePosition.distanceTo(panelPosition) - 1) < 1e-9,
  'Each native collision proxy follows its corresponding animated model object');

const referenceMesh = decor.propPickGroups[0].children[0] as THREE.InstancedMesh;
decor.selectPropInstance(referenceMesh, 0);
check(referenceSelectionEvents.at(-1) === 'TEST', 'Reference prop selection notifies the Props owner');
check(referenceEmitterCount === 1, 'Reference prop selection carries the full external-sound record');
let rangeDrawn = false;
let colliderOverlayDrawn = false;
decorRefRoot.traverse(object => {
  if (object instanceof THREE.LineSegments && (object.material as THREE.LineBasicMaterial).color?.getHex() === 0x53d9ff)
    rangeDrawn = true;
  if (object instanceof THREE.LineSegments
    && (object.material as THREE.LineBasicMaterial).color?.getHex() === COLLISION_OVERLAY_ACTIVE_COLOR)
    colliderOverlayDrawn = true;
});
check(rangeDrawn, 'Reference prop selection draws its external-sound listener range');
check(colliderOverlayDrawn, 'Reference prop selection draws its exact native collision proxy');
const referenceColliderOverlay = decorRefRoot.children.find(object => object.userData.collisionOverlay);
decor.setCollisionOverlayVisible(false);
check(referenceColliderOverlay?.visible === false, 'The collider preference hides the reference selection overlay');
decor.setCollisionOverlayVisible(true);
check(referenceColliderOverlay?.visible === true, 'The collider preference restores the reference selection overlay');
decor.inspectSurface(referenceMesh, 0);
let surfaceOutlineYellow = false;
decorRefRoot.traverse(object => {
  if (object instanceof THREE.LineSegments && (object.material as THREE.LineBasicMaterial).color?.getHex() === 0xffd21a)
    surfaceOutlineYellow = true;
});
check(surfaceOutlineYellow, 'Paint surface inspection uses the shared selection yellow');
decor.clearSurfaceInspection();
check(!decor.clearEffectPropHighlight(), 'Hidden Effects cleanup cannot clear a Props-owned highlight');
check(referenceSelectionEvents.at(-1) === 'TEST', 'Hidden Effects cleanup preserves the Props preview selection');
decor.clearPropSelection();
check(referenceSelectionEvents.at(-1) === null, 'Props cleanup clears and notifies its own selection');

decor.showLights(true);
check(decor.sourcePickGroups[0].visible
  && decor.sourcePickGroups[0].children.some(object => object.userData.sourceKind === 'sound'),
  'Sources can reveal prop-attached speakers before the separate Lights.json request finishes');
decor.setLights({
  level: 'TEST', counts: { spot: 1, point: 1, ambient: 1 }, lights: [
    { name: 'source spot', kind: 'spot', category: 'spot', negative: false,
      pos: [0, 4, 0], dir: [0, -1, 0], colorHex: '#ff8040', intensity: 1, coneCos: 0.8, reach: 20 },
    { name: 'source point', kind: 'point', category: 'point', negative: false,
      pos: [6, 4, 0], dir: [0, -1, 0], colorHex: '#4080ff', intensity: 1, coneCos: 1, reach: 14 },
    { name: 'sky fill', kind: 'ambient', category: 'ambient', negative: false,
      pos: [0, 0, 0], dir: [0, -1, 0], colorHex: '#ffffff', intensity: 1, coneCos: 1, reach: 1 },
  ],
});
let lightMarkerCount = 0, soundMarkerCount = 0;
let sourceDepthPasses = false;
let lightMarker: THREE.Points | null = null;
decor.sourcePickGroups[0].traverse(object => {
  if (!(object instanceof THREE.Points)) return;
  if (object.userData.sourceKind === 'light') {
    lightMarker = object;
    lightMarkerCount += object.geometry.getAttribute('position').count;
  }
  if (object.userData.sourceKind === 'sound') {
    soundMarkerCount += object.geometry.getAttribute('position').count;
    const xray = object.material as THREE.PointsMaterial;
    const visible = object.children.find(child => child instanceof THREE.Points && child.userData.sourceVisiblePass === true) as THREE.Points | undefined;
    sourceDepthPasses = xray.depthTest === false && Math.abs(xray.opacity - 0.07) < 1e-9
      && !!visible && (visible.material as THREE.PointsMaterial).depthTest === true
      && (visible.material as THREE.PointsMaterial).opacity === 1;
  }
});
check(lightMarkerCount === 2 && soundMarkerCount === 1,
  'Sources exposes one batched icon per spatial light and one speaker per audible external emitter');
check(sourceDepthPasses,
  'Source icons keep a 7%-opacity x-ray pass behind terrain and a full-bright depth-tested pass in front');
const referenceLightMarker = lightMarker as THREE.Points | null; // assigned by Object3D.traverse above
const bulbColors = referenceLightMarker?.geometry.getAttribute('color');
const lightIcons = referenceLightMarker?.geometry.getAttribute('sourceIcon');
const lightAimTargets = referenceLightMarker?.geometry.getAttribute('sourceAimTarget');
const expectedBulbColor = new THREE.Color('#ff8040');
check(!!referenceLightMarker && (referenceLightMarker.material as THREE.PointsMaterial).vertexColors === true
  && !!bulbColors && Math.abs(bulbColors.getX(0) - expectedBulbColor.r) < 1e-6
  && Math.abs(bulbColors.getY(0) - expectedBulbColor.g) < 1e-6
  && Math.abs(bulbColors.getZ(0) - expectedBulbColor.b) < 1e-6,
  'Each reference bulb inherits the recovered colour of its own light');
check(lightIcons?.getX(0) === 1 && lightIcons.getX(1) === 0,
  'Spot lights use the theatre spotlight atlas tile while point lights retain the bulb tile');
check(lightAimTargets?.getX(0) === 0 && lightAimTargets.getY(0) === -16 && lightAimTargets.getZ(0) === 0,
  'Spotlight markers target the exact centre of the expanded cone base');
const directionShader = { vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
  fragmentShader: '#include <common>\nvoid main() {\n#include <map_particle_fragment>\n}' };
(referenceLightMarker?.material as THREE.PointsMaterial | undefined)?.onBeforeCompile(directionShader as any, {} as any);
check(directionShader.vertexShader.includes('sourceTargetClip')
  && directionShader.vertexShader.includes('-sourceProjectedDirection.y')
  && directionShader.fragmentShader.includes('dot(sourceCentered, vSourceDirection)'),
  'The marker shader converts the projected cone centre into point-sprite coordinates before rotation');
check(decor.selectSource('light', 0), 'Clicking a reference bulb selects its source');
const selectedBulbGeometry = referenceLightMarker?.userData.sourceSelectionGeometry as THREE.BufferGeometry | undefined;
check(selectedBulbGeometry?.getAttribute('position').count === 1
  && selectedBulbGeometry.getAttribute('sourceIcon').getX(0) === 1
  && selectedBulbGeometry.getAttribute('sourceAimTarget').getY(0) === -16
  && referenceLightMarker?.children.filter(child => child.userData.sourceSelectionPass === true).length === 2,
  'The selected spotlight receives one matching bold-outline visible/x-ray overlay');
check(referenceLightEvents.at(-1) === 'TEST:source spot',
  'A selected reference bulb publishes its complete light identity to the details panels');
let selectedLightRig = false;
decor.sourcePickGroups[0].traverse(object => {
  if (object instanceof THREE.LineSegments && object.geometry.getAttribute('position').count > 6)
    selectedLightRig = true;
});
check(selectedLightRig, 'A selected bulb expands only that light rig');
decor.clearSourceSelection();
check(referenceLightEvents.at(-1) === null, 'Clearing the source drops the reference-light detail record');
check(selectedBulbGeometry?.getAttribute('position').count === 0,
  'Clearing the source removes the bold bulb selection outline');
check(decor.selectSource('sound', 0), 'Clicking a reference speaker selects its emitter');
let selectedSoundRange = false;
decor.sourcePickGroups[0].traverse(object => {
  if (object instanceof THREE.LineSegments && (object.material as THREE.LineBasicMaterial).color?.getHex() === 0x53d9ff)
    selectedSoundRange = true;
});
check(selectedSoundRange && referenceSelectionEvents.at(-1) === 'TEST',
  'A selected speaker expands its listener range and identifies the owning prop');
decor.clearPropSelection();

const eventCount = referenceSelectionEvents.length;
check(decor.highlightEffectPropSourceIndices([42, 43]), 'Effects can highlight hosts through native source indices');
check(decorRefRoot.children.some(child => child.children.length === 2
  && child.children.every(outline => outline instanceof THREE.Group && outline.children.length > 0)),
  'Effects multi-selection retains a separate gold outline for every selected host');
check(referenceSelectionEvents.length === eventCount, 'Effects highlighting does not mutate Props selection state');
decor.clearPropSelection();
check(referenceSelectionEvents.length === eventCount, 'Props cleanup ignores an Effects-owned highlight');
check(decor.clearEffectPropHighlight(), 'Effects cleanup clears its own host highlight');

// The read-only reference path uses native instance matrices and its packed body pool rather than authored
// placement geometry. Exercise the other two shape modes independently from the proxy fixture above.
decor.setProps({
  level: 'TEST',
  models: [{ id: 3, name: 'collision-shapes', subs: [{ mat: -1,
    positions: new Float32Array([-50, 0, 0, 50, 0, 0, 0, 100, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]), indices: new Uint32Array([0, 1, 2]),
  }] }],
  instances: [
    { sourceIndex: 50, ltgState: 0, model: 3, loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      name: 'bounds', visible: true, playerCollision: true, playerBounce: true, collisionSound: -1,
      contact: 'solid', bounce: 0.5, surface: -1, shape: 2, responseMass: 1e30, dynamicMass: -1,
      physicsBody: -1, externalSounds: [] },
    { sourceIndex: 51, ltgState: 0, model: 3, loc: [2, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      name: 'spheres-active', visible: true, playerCollision: true, playerBounce: true, collisionSound: -1,
      contact: 'solid', bounce: 0.5, surface: -1, shape: 3, responseMass: 5, dynamicMass: -1,
      physicsBody: 7, externalSounds: [] },
    { sourceIndex: 52, ltgState: 0, model: 3, loc: [4, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      name: 'spheres-disabled', visible: true, playerCollision: false, playerBounce: true, collisionSound: -1,
      contact: 'ghost', bounce: -1, surface: -1, shape: 3, responseMass: 5, dynamicMass: -1,
      physicsBody: 7, externalSounds: [] },
  ],
  materials: new Map([[-1, { tex: null, frames: [] }]]), crowdFrames: [], collisionMeshes: new Map(),
  physicsBodies: new Map([[7, new Float32Array([0, 0, 0, 30, 40, 0, 0, 15])]]),
  unityBodyRecipes: new Map([[7, {
    doorwayOrSparse: true,
    bounds: { center: [0, 20, 0], size: [60, 70, 60] },
    body: {
      boxes: [{ center: [0, 10, 0], size: [20, 20, 20] }],
      capsules: [{ a: [0, 0, 0], b: [0, 40, 0], radius: 12 }],
    },
    tilt: { boxes: [], capsules: [] },
  }]]),
});
// Instances of one model do NOT all share a draw: the Surface view colours a prop by its contact class and a
// draw carries one material, so the batching partitions on that class too (reference-decor · contactTint).
// These three deliberately span it — two solid, one ghost — so resolve each through its slot table rather
// than assuming an ordering across the split.
const referenceShapeAt = (sourceIndex: number): [THREE.InstancedMesh, number] => {
  for (const object of decor.propPickGroups[0].children) {
    const slots = object.userData.propSlots as { inst: { sourceIndex: number } }[] | undefined;
    const index = slots?.findIndex(slot => slot.inst.sourceIndex === sourceIndex) ?? -1;
    if (index >= 0) return [object as THREE.InstancedMesh, index];
  }
  throw new Error(`No reference draw carries source instance ${sourceIndex}`);
};
decor.selectPropInstance(...referenceShapeAt(50));
check(referenceColliderOverlay?.children.some(object => object instanceof THREE.LineSegments),
  'A reference mode-2 selection draws its native model AABB');
decor.selectPropInstance(...referenceShapeAt(51));
let referenceSpheres = referenceColliderOverlay?.children.find(object => object instanceof THREE.InstancedMesh);
check(referenceSpheres instanceof THREE.InstancedMesh && referenceSpheres.count === 2
  && (referenceSpheres.material as THREE.MeshBasicMaterial).color.getHex() === COLLISION_OVERLAY_ACTIVE_COLOR,
  'A reference mode-3 selection draws every packed sphere-tree leaf in active cyan');
const referenceUnityOverlay = decorRefRoot.children.find(object => object.userData.unityCollisionOverlay);
check(referenceSpheres instanceof THREE.InstancedMesh
  && referenceUnityOverlay?.children.filter(object => object instanceof THREE.LineSegments).length === 2
  && referenceUnityOverlay.children.every(object => object instanceof THREE.LineSegments
    && (object.material as THREE.LineBasicMaterial).color.getHex() === UNITY_COLLISION_OVERLAY_COLOR),
  'A reference mode-3 selection keeps native spheres while drawing Unity boxes and capsules in orange');
decor.selectPropInstance(...referenceShapeAt(52));
referenceSpheres = referenceColliderOverlay?.children.find(object => object instanceof THREE.InstancedMesh);
check(referenceSpheres instanceof THREE.InstancedMesh
  && (referenceSpheres.material as THREE.MeshBasicMaterial).color.getHex() === COLLISION_OVERLAY_INACTIVE_COLOR,
  'A reference collision shape remains visible in inactive slate when Player contact is off');
decor.clearPropSelection();

const extentAssets = createPropAssets();
extentAssets.registerPropModels({
  level: 'TEST', instances: [], materials: new Map(), crowdFrames: [],
  physicsBodies: new Map([[7, new Float32Array([0, 0, 0, 35, 40, 0, 0, 20])]]),
  models: [{ id: 99, name: 'launcher', subs: [{ mat: -1,
    positions: new Float32Array([
      -10, -10, -100, 10, -10, -100, 10, 10, -100, -10, 10, -100,
      -10, -10, 100, 10, -10, 100, 10, 10, 100, -10, 10, 100,
    ]),
    uvs: new Float32Array(16), indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]),
  }] }],
});
const launcherExtent = extentAssets.propPrincipalExtent('TEST', 99);
check(!!launcherExtent && launcherExtent.axis[2] > 0.999 && Math.abs(launcherExtent.muzzle[2] - 100) < 1e-6,
  'shared prop geometry recovers a launcher long axis and its +Z-facing muzzle');
const launcherGeometry = extentAssets.propGeom.get('TEST:99')![0].geometry;
const launcherFeatures = extentAssets.propEdges('TEST', 99, [launcherGeometry])[0];
const launcherWires = extentAssets.propWireEdges('TEST', 99, [launcherGeometry])[0];
check(launcherWires.attributes.instanceStart.count === launcherFeatures.attributes.instanceStart.count + 2,
  'Wireframe selection retains the two coplanar triangle diagonals omitted by the feature outline');

// Selection is intentionally a decoration-only fast path. A click must keep the already-built textured prop
// root alive instead of sending the whole mountain through setPlacedProps again.
const selectionWorld = new THREE.Group();
const selectionScene = new THREE.Scene();
let selectionAttachCount = 0;
let selectionDetachCount = 0;
const selectionStage: any = {
  worldRoot: selectionWorld, scene: selectionScene, gizmo: { dragging: false }, gizmoKind: null,
  snapDataPoint: (point: unknown) => point,
  attachGizmo(_object: THREE.Object3D, kind: string) { this.gizmoKind = kind; selectionAttachCount++; },
  detachGizmo() { this.gizmoKind = null; selectionDetachCount++; },
  cb: {},
};
const selectionLayer = createPropsLayer(selectionStage, extentAssets, {
  authoredRigData: null, authoredLightsVisible: false, authoredLights: [],
} as any);
selectionLayer.setPlacedProps([{
  id: 'prop-fast-select', level: 'TEST', model: 99, name: 'launcher', pos: [1, 2, 3], yaw: 0, scale: 1,
  nativeCollision: {
    mode: 2, playerCollision: true, responseMass: 1e30, playerBounce: true, bounceAmount: 0.5,
  },
}], null);
// RENDER == BAKE, across the full authored rotation (docs/012). The viewport composes `pos · rotation ·
// scale` in data space under worldRoot; the export bake runs the same pose and then maps to raw cm. A prop
// that is merely YAWED cannot tell the two apart — both reduce to one cos/sin pair — so the check that
// earns its keep is a placement carrying pitch AND roll: push model-local points through the layer's own
// matrix and through `placementMatrix`, and they must land on the same raw vertex. Divergence here is a
// tilted prop that ships somewhere other than where it was authored.
{
  const tilted = { pos: [12, 3.5, -40] as V3, yaw: 37, pitch: -24, roll: 63, scale: 1.5 };
  const rendered = selectionLayer.placementPose(tilted);
  const baked = new THREE.Matrix4().fromArray(placementMatrix({
    level: 'TEST', model: 99, name: 'tilted', ...tilted,
  }));
  let worst = 0;
  for (const raw of [[0, 0, 0], [400, 0, 0], [0, 250, 0], [0, 0, -175], [90, -60, 30]] as const) {
    // the bake matrix folds RAW_TO_EDITOR in; hand the viewport the same point already mapped
    const asEditor = new THREE.Vector3(-raw[0] / 100, raw[2] / 100, -raw[1] / 100);
    worst = Math.max(worst, asEditor.applyMatrix4(rendered)
      .distanceTo(new THREE.Vector3(raw[0], raw[1], raw[2]).applyMatrix4(baked)));
  }
  check(worst < 1e-9,
    `A tilted placement renders and bakes through the identical pose (worst ${worst.toExponential(1)} m)`);
}

const stablePlacementRoot = selectionLayer.placedPropMeshes[0];
selectionLayer.setSelection(0);
check(selectionLayer.placedPropMeshes[0] === stablePlacementRoot
  && stablePlacementRoot.children.some(child => child.userData.propSelectionDecoration)
  && selectionLayer.selectedProp === 0 && selectionAttachCount === 1,
'A prop click adds selection decoration and its gizmo without rebuilding the placed mesh');
const selectedTopologies = () => {
  const result = new Map<string, boolean>();
  stablePlacementRoot.traverse(object => {
    const topology = object.userData.propSelectionTopology;
    if (typeof topology === 'string') result.set(topology, object.visible);
  });
  return result;
};
check(selectedTopologies().get('feature') === true && selectedTopologies().get('wire') === false,
  'textured prop selection uses the compact feature outline');
selectionLayer.setShadeMode('none');
check(selectedTopologies().get('feature') === false && selectedTopologies().get('wire') === true,
  'Wireframe prop selection switches to the same full triangle topology as the unselected prop');
const authoredColliderOverlay = selectionWorld.children.find(object => object.userData.collisionOverlay);
const authoredUnityOverlay = selectionWorld.children.find(object => object.userData.unityCollisionOverlay);
check(authoredColliderOverlay?.children.some(object => object instanceof THREE.LineSegments
  && (object.material as THREE.LineBasicMaterial).color.getHex() === COLLISION_OVERLAY_ACTIVE_COLOR),
  'An authored mode-2 selection draws its model AABB in active cyan');
check(selectionLayer.rideColliders().length === 1, 'An authored visible prop contributes its configured ride collider');
selectionLayer.setRuntimePropVisible('prop-fast-select', false);
check(selectionLayer.rideColliders().length === 0, 'A mode-hidden authored prop retires its ride collider before Test starts');
selectionLayer.setRuntimePropVisible('prop-fast-select', null);
selectionLayer.setSelection(null);
check(selectionLayer.placedPropMeshes[0] === stablePlacementRoot
  && !stablePlacementRoot.children.some(child => child.userData.propSelectionDecoration)
  && selectionLayer.selectedProp === null && selectionDetachCount === 1,
'Clearing prop selection removes only its decoration and keeps the placed mesh');
selectionLayer.setPlacedProps([{
  id: 'prop-fast-select', level: 'TEST', model: 99, name: 'launcher', pos: [1, 2, 3], yaw: 0, scale: 1,
  nativeCollision: {
    mode: 3, playerCollision: true, responseMass: 5, playerBounce: true, bounceAmount: 0.2,
    physicsSource: { level: 'TEST', body: 7 },
  },
}], 0);
check(authoredColliderOverlay?.children.some(object => object instanceof THREE.InstancedMesh)
  && authoredUnityOverlay?.children.some(object => object instanceof THREE.LineSegments
    && (object.material as THREE.LineBasicMaterial).color.getHex() === UNITY_COLLISION_OVERLAY_COLOR),
  'An authored mode-3 selection shows donor spheres and its exported Unity bounds box together');
selectionLayer.setPlacedProps([{
  id: 'prop-fast-select', level: 'TEST', model: 99, name: 'launcher', pos: [1, 2, 3], yaw: 0, scale: 1,
  nativeCollision: {
    mode: 3, playerCollision: false, responseMass: 5, playerBounce: true, bounceAmount: 0.2,
    physicsSource: { level: 'TEST', body: 7 },
  },
}], 0);
const inactiveSpheres = authoredColliderOverlay?.children.find(object => object instanceof THREE.InstancedMesh);
check(inactiveSpheres instanceof THREE.InstancedMesh && inactiveSpheres.count === 2
  && (inactiveSpheres.material as THREE.MeshBasicMaterial).color.getHex() === COLLISION_OVERLAY_INACTIVE_COLOR,
  'An authored mode-3 selection draws every sphere-tree leaf in inactive slate when Player contact is off');
check(authoredUnityOverlay?.children.length === 0,
  'A Player-contact-off authored shape does not claim an exported Unity collider');
selectionLayer.setCollisionOverlayVisible(false);
check(authoredColliderOverlay?.visible === false, 'The collider preference hides the authored selection overlay');
selectionLayer.setCollisionOverlayVisible(true);
selectionLayer.setSelection(null);

// Test mode: a prop standing on the ride target is part of that mountain, so its clicked point is an ordinary
// play point (the start flag / an AI drop) rather than an unavailable-target notice. Props on the OTHER mountain
// stay rejected, exactly like the terrain under them.
activeMode = 'play';
props.propArm = null;
placedPropGroup.visible = true;
refSceneryGroup.visible = false;
refTrickGroup.visible = false;
let playPoint: V3 | null = null;
let playSurfacePicks = 0;
layers.rideCtl = {
  riding: false,
  playTarget: 'authored',
  pickPlaySurface() { playSurfacePicks++; },
};
stage.cb.onPlayClick = (world: V3) => { playPoint = world; };
unavailable = 0;
dom.dispatch('pointerdown', {});
check(playPoint?.[2] === 1 && playSurfacePicks === 0 && unavailable === 0,
  'Test mode hands a click on a prop of the ridden mountain to the play point, not the terrain pick');

playPoint = null;
layers.rideCtl.playTarget = 'reference';
dom.dispatch('pointerdown', {});
check(playPoint === null && unavailable === 1,
  'A prop on the mountain you are NOT riding stays a rejected Test-mode click');

placedPropGroup.visible = false;
refTrickGroup.visible = true;
dom.dispatch('pointerdown', {});
check(playPoint?.[2] === 1 && playSurfacePicks === 0 && unavailable === 1,
  'A reference prop is a play point while the reference is the ride target');
refTrickGroup.visible = false;

if (failures) process.exitCode = 1;
else console.log('PROP PICKING TESTS PASSED');
