// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { installTestDom } from './dom-test-support';
import { loadDomFixture } from './dom-fixture-support';

const cleanup = installTestDom('http://scene.test/');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ songs: [] });
let dispose: (() => Promise<void>) | undefined;
try {
  dispose = await loadDomFixture(new URL('./scene-toolboxes.fixture.ts', import.meta.url));
  const toolbox = (window as any).sceneToolboxes;
  const state = () => toolbox.state();
  const category = (name: string) => {
    const row = [...document.querySelectorAll<HTMLElement>('.sp-scene-categories .sp-out-row')].find(element =>
      element.textContent?.includes(name),
    );
    assert(row, `category ${name} exists`);
    return row;
  };
  const targets = document.querySelector<HTMLElement>('[role="group"][aria-label="Scene toolbox mountain"]')!;
  const choose = (name: string) => {
    const button = [...targets.querySelectorAll('button')].find(element => element.textContent === name);
    assert(button, `${name} target exists`);
    button.click();
  };
  const cameraX = () => document.querySelector<HTMLInputElement>('[aria-label="Camera position X"]')!;
  assert(category('Reference: Garibaldi'));
  for (const name of ['Course', 'AI Paths', 'Sound', 'Lighting', 'Skybox', 'God Rays', 'Camera']) {
    category(name).click();
    assert.equal(state().target, 'authored');
    choose('Reference');
    const reference = state();
    assert.equal(reference.target, 'reference');
    if (name !== 'AI Paths') assert(reference.cards.includes('Reference: Garibaldi'));
    if (name === 'Skybox' || name === 'God Rays') assert.equal(reference.skyTarget, 'reference');
    if (name === 'Camera') {
      assert.equal(cameraX().value, '100');
      choose('Mountain');
      assert.equal(cameraX().value, '10');
      choose('Reference');
      assert.equal(document.querySelector('[aria-label="Camera coordinates"]'), null);
      cameraX().value = '125';
      cameraX().dispatchEvent(new Event('input', { bubbles: true }));
      choose('Mountain');
      assert.equal(cameraX().value, '35');
      choose('Reference');
      const apply = [...document.querySelectorAll('button')].find(button => button.textContent === 'Apply');
      assert(apply);
      apply.click();
      assert.equal(state().view.pos[0], 125, 'camera edits survive coordinate frame changes');
    }
  }
  category('Lighting').click();
  assert.equal(state().target, 'reference', 'sections remember their target');
  toolbox.selectKnot();
  assert(state().cards.includes('Knot 0'));
  choose('Reference');
  assert(!state().cards.includes('Knot 0'));
  toolbox.selectPath();
  assert.equal(state().category, 'aiPaths');
  assert.equal(state().target, 'reference');
  category('Sound').click();
  assert(
    [...document.querySelectorAll('.sp-scene-card')].some(
      card => (card as HTMLElement).style.display !== 'none' && card.textContent?.includes('Rider sound'),
    ),
  );
  await toolbox.reference('');
  assert(category('Reference: None'));
  category('Camera').click();
  assert(cameraX().disabled);
  await toolbox.reference('Snowdream');
  assert(category('Reference: Snowdream'));
  assert(!cameraX().disabled);
  console.log('PASS scene categories, target memory, selection routing, sky preview and camera coordinate edits');
} finally {
  globalThis.fetch = originalFetch;
  await dispose?.();
  await cleanup();
}
