// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { installTestDom } from './dom-test-support';
import { loadDomFixture } from './dom-fixture-support';
const cleanup = installTestDom();
let dispose: (() => Promise<void>) | undefined;
try {
  document.body.innerHTML = '<div id="toast"></div>';
  dispose = await loadDomFixture(new URL('./gem-asset-placement.fixture.ts', import.meta.url));
  const placement = (window as any).gemPlacement;
  const button = (name: string) => {
    const found = [...document.querySelectorAll('button')].find(button => button.textContent === name);
    assert(found, name);
    return found;
  };
  const drop = async (count: number) => {
    button('Add gem').click();
    if (count === 1) assert(button('Prop settings').disabled);
    button('Drop gem').click();
    const deadline = Date.now() + 3000;
    while (placement.state().document.props?.length !== count) {
      assert(Date.now() < deadline, 'gem placement completes');
      await setImmediate();
    }
  };
  await drop(1);
  assert(!button('Prop settings').disabled);
  button('Prop settings').click();
  let state = placement.state();
  assert.equal(state.advanced, `prop:${state.document.props[0].id}`);
  assert.match(state.document.props[0].level, /^asset2:.*:prop:203:/);
  await drop(2);
  button('Effects').click();
  assert.equal(placement.state().opened, 'effects');
  await placement.armRail('ALASKA/rail.png');
  state = placement.state();
  assert.match(state.document.rails.at(-1).texture, /^asset2:.*:texture:rail.png:/);
  await placement.armRail('Custom/my-rail.png');
  state = placement.state();
  assert.equal(state.document.rails.at(-1).texture, 'Custom/my-rail.png');
  const before = JSON.stringify(state.document);
  await placement.armRail('ALASKA/missing.png');
  assert.equal(JSON.stringify(placement.state().document), before);
  console.log('PASS gem/rail asset identities, settings/effects navigation, custom textures and missing-art isolation');
} finally {
  await dispose?.();
  await cleanup();
}
