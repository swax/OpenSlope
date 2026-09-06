// tier: fast

import {
  activeSkyboxWorld, activeSkyWorld, godRaysForSkyWorld, nearestSkyWorld,
  reconcileSkyPreviewTarget, toggleSkyPreviewLayer,
  type SkyPreviewTarget,
} from '../src/app/sky/preview';
import { DEFAULT_GODRAY_COURSE } from '../src/core/lighting/god-rays';
import { check, failures } from './check';

check(reconcileSkyPreviewTarget(null, true, true) === 'authored',
  'the first available preview defaults to My mountain');
check(reconcileSkyPreviewTarget(null, false, true) === 'reference',
  'Reference becomes the default when it is the first mountain with a skybox');
check(reconcileSkyPreviewTarget('reference', true, true) === 'reference',
  'an explicit Reference choice survives while its skybox remains available');
check(reconcileSkyPreviewTarget('reference', true, false) === 'authored'
  && reconcileSkyPreviewTarget('authored', false, true) === 'reference'
  && reconcileSkyPreviewTarget('authored', false, false) === null,
  'an unavailable choice falls back in panel order, then to no preview');

const scene = (selected: boolean, target: SkyPreviewTarget | null = 'authored', enabled = true) =>
  activeSkyWorld('info', selected, false, 'reference', target, enabled);
check(scene(true) === 'authored' && scene(true, 'reference') === 'reference',
  'Scene Skybox and God Rays use the shared preview selector');
check(scene(false) === null && scene(true, 'authored', false) === null,
  'non-presentation Scene categories and disabled preview layers stay hidden');
check(activeSkyWorld('edit', true, false, 'authored', 'authored', true) === null
  && activeSkyWorld('play', true, false, 'reference', 'authored', true) === null,
  'the category-owned god-ray preview stays hidden while editing and in Test setup');
check(activeSkyWorld('play', false, true, 'reference', 'authored', false) === 'reference'
  && activeSkyWorld('play', false, true, 'authored', 'reference', false) === 'authored',
  'an active Test ride follows its play target and ignores editor layer toggles');

check(activeSkyboxWorld('edit', false, false, 'authored', 'reference', 'reference', true) === 'reference'
  && activeSkyboxWorld('props', false, false, 'authored', 'reference', 'authored', true) === 'authored',
  'the global Skybox view follows the nearest mountain in ordinary editor modes');
check(activeSkyboxWorld('info', true, false, 'authored', 'reference', 'authored', true) === 'reference',
  'the dedicated Scene preview keeps its explicit mountain choice');
check(activeSkyboxWorld('play', false, true, 'reference', 'authored', 'authored', true) === 'reference',
  'a running ride locks the skybox to its play target');
check(activeSkyboxWorld('edit', false, false, 'authored', 'reference', 'reference', false) === null,
  'the global Skybox switch hides the backdrop in every mode');

check(nearestSkyWorld(500, 300, 'authored', 50) === 'reference'
  && nearestSkyWorld(300, 500, 'reference', 50) === 'authored',
  'nearest-world selection switches after the other mountain wins beyond the dead band');
check(nearestSkyWorld(420, 390, 'authored', 50) === 'authored'
  && nearestSkyWorld(390, 420, 'reference', 50) === 'reference',
  'nearest-world selection retains its current world inside the dead band');
check(nearestSkyWorld(10, null, 'reference', 50) === 'authored'
  && nearestSkyWorld(null, 10, 'authored', 50) === 'reference',
  'nearest-world selection handles either mountain being unavailable');

let layers = { skybox: true, godRays: true };
layers = toggleSkyPreviewLayer(layers, 'skybox');
check(!layers.skybox && layers.godRays,
  'Skybox toggles independently while God ray stays selected');
layers = toggleSkyPreviewLayer(layers, 'skybox');
layers = toggleSkyPreviewLayer(layers, 'god-rays');
check(layers.skybox && !layers.godRays,
  'God ray toggles independently while Skybox stays selected');
layers = toggleSkyPreviewLayer(layers, 'none');
check(!layers.skybox && !layers.godRays,
  'None turns both preview layers off');

const glare = { ...DEFAULT_GODRAY_COURSE, enabled: true };
check(godRaysForSkyWorld(null, glare, glare) === null,
  'god rays stay off when neither presentation preview nor Test ride owns the view');
check(godRaysForSkyWorld('authored', undefined, glare) === null
  && godRaysForSkyWorld('reference', glare, null) === null,
  'a preview never borrows god rays from the other mountain');
check(godRaysForSkyWorld('authored', glare, null) === glare
  && godRaysForSkyWorld('reference', undefined, glare) === glare,
  'the selected or ridden mountain supplies its own enabled god rays');

if (failures) {
  console.error(`SKY PREVIEW TESTS FAILED (${failures})`);
  process.exit(1);
}
console.log('SKY PREVIEW TESTS PASSED');
