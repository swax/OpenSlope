// tier: fast

import * as THREE from 'three';
import { createScenePicking } from '../src/app/viewport/input/scene-picking';
import { check, failures } from './check';

const scene = new THREE.Scene();
const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
const stage: any = { ray };

const terrain = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial());
terrain.position.z = -5;
const referenceTerrain = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial());
referenceTerrain.position.z = 8;
referenceTerrain.visible = false;
scene.add(terrain, referenceTerrain);

const authoredProps = new THREE.Group();
const prop = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
prop.position.z = 0;
prop.userData.propIndex = 7;
authoredProps.add(prop);

function referenceProp(name: string, z: number, sourceIndex: number) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial(), 1);
  mesh.name = name;
  mesh.userData.propLevel = 'TEST';
  mesh.userData.propModel = sourceIndex;
  mesh.userData.propInsts = [{ sourceIndex }];
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, z));
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function stateReferenceProp(name: string, z: number, sourceIndex: number, visible: boolean, depth: number) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, depth), new THREE.MeshBasicMaterial(), 1);
  mesh.name = name;
  mesh.userData.propLevel = 'TEST';
  mesh.userData.propModel = sourceIndex;
  mesh.userData.propInsts = [{ sourceIndex, visible, loc: [12, 34, 56] }];
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, z));
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

const standardReferenceProps = new THREE.Group();
standardReferenceProps.add(referenceProp('standard-ref', -1, 17));
const effectReferenceProps = new THREE.Group();
effectReferenceProps.add(referenceProp('effect-proxy', 3, 42));
const colocatedEffectStates = new THREE.Group();
// The hidden replacement is physically nearer along this ray, as broken-state fragments can be in real maps.
colocatedEffectStates.add(stateReferenceProp('hidden-replacement', 3, 101, false, 3));
colocatedEffectStates.add(stateReferenceProp('visible-source', 3, 100, true, 1));
colocatedEffectStates.visible = false;

const lights = new THREE.Group();
const lightDecoration = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
lightDecoration.position.z = 5; // closer but intentionally untagged
const light = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
light.position.z = 4;
light.userData.lightIndex = 3;
lights.add(lightDecoration, light);

const sources = new THREE.Group();
const soundSources = new THREE.Points(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 3.5)]),
  new THREE.PointsMaterial({ size: 4 }),
);
soundSources.userData.sourceKind = 'sound';
soundSources.userData.sourceOrigin = 'reference';
sources.add(soundSources);

const rails = new THREE.Group();
const rail = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
rail.position.z = 2;
rail.userData.railIndex = 8;
rail.userData.railNode = 2;
rails.add(rail);

const gems = new THREE.Group();
const gem = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
gem.position.z = 1;
gem.userData.gemIndex = 5;
gems.add(gem);

// A video screen answers on either half (docs/051): the panel carries the index, and the movie marker is one
// point of a batched cloud whose point index IS the screen. They are separate objects, so a query that only
// knew about one of them would silently make half the screens unclickable.
const screens = new THREE.Group();
const screenPanel = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), new THREE.MeshBasicMaterial());
screenPanel.position.z = 1.5;
screenPanel.userData.screenIndex = 4;
screenPanel.userData.screenSource = 'authored';
const screenMarkers = new THREE.Points(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 2.5), new THREE.Vector3(0, 0, 2.4)]),
  new THREE.PointsMaterial({ size: 4 }),
);
screenMarkers.userData.screenPoints = true;
screenMarkers.userData.screenSource = 'authored';
screens.add(screenPanel, screenMarkers);

const referenceScreens = new THREE.Group();
referenceScreens.visible = false;
const referenceScreenPanel = new THREE.Mesh(new THREE.PlaneGeometry(5, 3), new THREE.MeshBasicMaterial());
referenceScreenPanel.position.z = 1.7;
referenceScreenPanel.userData.screenIndex = 9;
referenceScreenPanel.userData.screenSource = 'reference';
const referenceScreenMarkers = new THREE.Points(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 2.7)]),
  new THREE.PointsMaterial({ size: 4 }),
);
referenceScreenMarkers.userData.screenPoints = true;
referenceScreenMarkers.userData.screenSource = 'reference';
referenceScreens.add(referenceScreenPanel, referenceScreenMarkers);

const authoredParticles = new THREE.Group();
const fog = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial());
fog.position.z = 7; fog.userData.particleVolumeIndex = 2; fog.userData.particleVolumeId = 'fog-volume-3';
authoredParticles.add(fog);
const referenceParticles = new THREE.Group();

const knot = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
knot.position.z = 6;

scene.add(authoredProps, standardReferenceProps, effectReferenceProps, colocatedEffectStates, lights, sources, rails, gems,
  screens, referenceScreens, authoredParticles, referenceParticles, knot);
scene.updateMatrixWorld(true);

const picking = createScenePicking(stage, {
  authoredPropRoots: () => [authoredProps],
  referencePropRoots: scope => scope === 'effects'
    ? [standardReferenceProps, effectReferenceProps, colocatedEffectStates] : [standardReferenceProps],
  authoredParticleRoots: () => [authoredParticles],
  referenceParticleRoots: () => [referenceParticles],
  lightRoots: () => [lights],
  sourceRoots: () => [sources],
  railRoots: () => [rails],
  gemRoots: () => [gems],
  screenRoots: () => [screens, referenceScreens],
  knotTargets: () => [knot],
  surfaceTargets: () => [
    { source: 'authored', object: terrain },
    { source: 'reference', object: referenceTerrain },
  ],
});

let pick = picking.pick({ props: 'standard', surfaces: true });
check(pick?.target === 'prop' && pick.source === 'authored' && pick.propIndex === 7,
  'standard prop query resolves the nearest authored prop and its stable index');

pick = picking.pick({ sources: true });
check(pick?.target === 'source' && pick.source === 'reference'
  && pick.sourceKind === 'sound' && pick.sourceIndex === 0,
  'source query resolves a batched speaker marker and its stable point index');

soundSources.position.z = -12; // move its point from z=3.5 to z=-8.5, behind the terrain at z=-5
scene.updateMatrixWorld(true);
pick = picking.pick({ sources: true });
check(pick?.target === 'source' && pick.sourceKind === 'sound',
  'source query remains click-through when its icon is behind terrain');
soundSources.position.z = 0;
scene.updateMatrixWorld(true);

pick = picking.pick({ particleVolumes: true, surfaces: true });
check(pick?.target === 'particleVolume' && pick.source === 'authored'
  && pick.volumeIndex === 2 && pick.volumeId === 'fog-volume-3',
  'Effects particle query resolves a standalone fog volume and its stable authored ID');

authoredProps.visible = false;
pick = picking.pick({ props: 'standard', surfaces: true });
check(pick?.target === 'prop' && pick.source === 'reference'
  && pick.sourceIndex === 17 && pick.level === 'TEST' && pick.name === 'standard-ref',
  'reference prop hit decodes native source index and copy metadata');

pick = picking.pick({ props: 'effects', surfaces: true });
check(pick?.target === 'prop' && pick.source === 'reference' && pick.sourceIndex === 42,
  'Effects scope includes the effect-only reference host proxy');

effectReferenceProps.visible = false;
standardReferenceProps.visible = false;
colocatedEffectStates.visible = true;
scene.updateMatrixWorld(true);
pick = picking.pick({ props: 'effects', surfaces: true });
check(pick?.target === 'prop' && pick.source === 'reference' && pick.sourceIndex === 100,
  'Effects picking prefers the visible state when a hidden replacement overlaps it');

colocatedEffectStates.visible = false;
pick = picking.pick({ props: 'effects', surfaces: true });
check(pick?.target === 'surface', 'hidden scene roots are excluded and the visible surface wins');

let terrainRaycasts = 0;
const terrainRaycast = terrain.raycast.bind(terrain);
terrain.raycast = (raycaster, intersections) => { terrainRaycasts++; terrainRaycast(raycaster, intersections); };
pick = picking.pick({ props: 'standard', occludeWithSurfaces: true });
check(pick === null && terrainRaycasts === 0,
  'occlusion-only query skips the terrain raycast when no entity candidate exists');

authoredProps.visible = true;
prop.position.z = -8;
scene.updateMatrixWorld(true);
pick = picking.pick({ props: 'standard', surfaces: true, surfaceEpsilon: 1e-3 });
check(pick?.target === 'surface', 'terrain occludes a scene entity behind it');
pick = picking.pick({ props: 'standard', occludeWithSurfaces: true, surfaceEpsilon: 1e-3 });
check(pick === null, 'occlusion-only query suppresses an entity hidden behind terrain');

prop.position.z = 0;
lights.visible = true;
scene.updateMatrixWorld(true);
pick = picking.pick({ props: 'standard', lights: true, surfaces: true });
check(pick?.target === 'light' && pick.lightIndex === 3,
  'nearest-family resolution skips untagged decoration and decodes the tagged light');

lights.visible = false;
pick = picking.pick({ rails: true, gems: true, surfaces: true });
check(pick?.target === 'rail' && pick.source === 'authored' && pick.railIndex === 8 && pick.railNode === 2,
  'rail hits carry both the rail and exact node identity');

// Video screens: the marker cloud is nearer along this ray, so it answers first and reports the POINT index.
pick = picking.pick({ screens: true, surfaces: true });
check(pick?.target === 'screen' && pick.source === 'authored' && pick.screenIndex === 0,
  'a screen’s movie marker resolves the screen by its point index');
screenMarkers.visible = false;
pick = picking.pick({ screens: true, surfaces: true });
check(pick?.target === 'screen' && pick.screenIndex === 4,
  'and its panel resolves the same screen by the index it carries');
screenMarkers.visible = true;
screens.visible = false;

referenceScreens.visible = true;
pick = picking.pick({ screenMarkers: true });
check(pick?.target === 'screen' && pick.source === 'reference' && pick.screenIndex === 0,
  'a reference movie marker is an overlay pick and retains its reference identity');
referenceScreenMarkers.visible = false;
pick = picking.pick({ screens: true, surfaces: true });
check(pick?.target === 'screen' && pick.source === 'reference' && pick.screenIndex === 9,
  'a detected reference panel is selectable through the same screen path');
referenceScreens.visible = false;

pick = picking.pick({ knots: true, surfaces: true });
check(pick?.target === 'knot', 'the same nearest-hit resolver supports course knots');
referenceTerrain.visible = true;
scene.updateMatrixWorld(true);
check(picking.pick({ surfaces: 'authored' })?.source === 'authored',
  'authored-only tools ignore a nearer reference surface');
check(picking.pick({ surfaces: true })?.source === 'reference',
  'unfiltered scene queries resolve the nearest visible mountain surface');
check(picking.pick({}) === null, 'an empty scene-pick query resolves nothing');

if (failures) process.exitCode = 1;
else console.log('SCENE PICKING TESTS PASSED');
