// tier: fast

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  leavesSceneSound, sceneBackTarget, sceneBoundsVisibility, sceneFolderVisibility, type SceneSel,
} from '../src/app/ui/chrome/scene-navigation';
import { check, failures } from './check';

const categories: SceneSel[] = ['info', 'lighting', 'godrays', 'sound', 'skybox', 'course', 'camera'];
for (const category of categories) {
  const visible = sceneFolderVisibility(category, false);
  const active = (Object.entries(visible) as Array<[keyof typeof visible, boolean]>)
    .filter(([key, on]) => key !== 'selection' && on).map(([key]) => key);
  check(active.length === 1 && active[0] === category,
    category === 'info'
      ? 'Reference selects exactly its reference-mountain picker'
      : `${category} selects exactly its Mountain / Reference folder pair`);
}

check(!sceneFolderVisibility('course', false).selection
  && sceneFolderVisibility('course', true).selection
  && !sceneFolderVisibility('lighting', true).selection,
'the selected-knot card appears only inside Course with a live course selection');

check(sceneBackTarget('info') === null
  && categories.filter(category => category !== 'info').every(category => sceneBackTarget(category) === 'info'),
'Escape leaves Reference alone and returns every focused category to Reference');

check(categories.filter(category => category !== 'sound').every(category => leavesSceneSound('sound', category))
  && leavesSceneSound('sound', null)
  && !leavesSceneSound('sound', 'sound')
  && !leavesSceneSound('course', 'sound'),
'a Sound preview stops when its category or Scene mode is left, but not when Sound remains selected');

check(sceneBoundsVisibility('info', true).mountain
  && sceneBoundsVisibility('info', true).reference,
'the Scene Reference landing view frames both Mountain and Reference');

check(categories.filter(category => category !== 'info').every(category => {
  const bounds = sceneBoundsVisibility(category, true);
  return !bounds.mountain && !bounds.reference;
}),
  'Lighting, God Rays, Sound, Skybox, and Course do not draw world bounds');

check(!sceneBoundsVisibility('info', false).mountain
  && !sceneBoundsVisibility('info', false).reference,
'leaving Scene mode hides both world bounds');

const scenePanel = readFileSync(resolve(process.cwd(), 'src/app/ui/chrome/scene-panel.ts'), 'utf8');
const referenceSession = readFileSync(resolve(process.cwd(), 'src/app/reference/session.ts'), 'utf8');
const referenceSound = readFileSync(resolve(process.cwd(), 'src/app/reference/music-study.ts'), 'utf8');
const dockCss = readFileSync(resolve(process.cwd(), 'src/app/styles/dock.css'), 'utf8');
const tooltip = readFileSync(resolve(process.cwd(), 'src/app/ui/components/tooltip.ts'), 'utf8');
check(['environment', 'intro', 'board'].every(name => scenePanel.includes(`${name}.close()`))
  && ['rider', 'bed', 'introFolder', 'race'].every(name => referenceSound.includes(`${name}.close()`)),
'every authored and reference Sound subsection starts collapsed');
check(dockCss.includes('.sp-scene-card > .lil-title { pointer-events: none; }')
  && !dockCss.includes('.sp-scene-gui .lil-gui > .lil-title { pointer-events: none; }'),
'only outer Scene cards suppress folder clicks; nested Sound subsections remain expandable');
check(tooltip.includes("classList.contains('lil-controller')")
  && !tooltip.includes("classList.contains('controller')"),
'disabled lil-gui rows keep their tooltip hit area after the 0.21 class-name migration');
check(scenePanel.includes("value: 'godrays'")
  && scenePanel.includes('godRayFolder.show(visible.godrays)')
  && scenePanel.includes('refGodRayFolder.show(visible.godrays)'),
'God Rays is its own Scene category with a Mountain / Reference card pair');
check(scenePanel.includes('skyPreviewFolder.show(visible.skybox || visible.godrays)'),
  'the shared world/layer Preview card is reachable from both presentation categories');
check(referenceSession.includes('const folder = godRayFolder;')
  && !referenceSession.includes("sunFolder.addFolder('Sun glare')")
  && referenceSession.includes('function buildReferenceGlarePanel()')
  && referenceSession.includes("refGodRayFolder.add(ui, 'spriteIntensity').name('sprite intensity').disable()"),
'authored glare moved out of Lighting and the matching Reference settings are read-only');

if (failures) {
  console.error(`SCENE NAVIGATION TESTS FAILED (${failures})`);
  process.exit(1);
}
console.log('SCENE NAVIGATION TESTS PASSED');
