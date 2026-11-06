// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { installTestDom } from './dom-test-support';
import { loadDomFixture } from './dom-fixture-support';
const cleanup = installTestDom();
let dispose: (() => Promise<void>) | undefined;
try {
  dispose = await loadDomFixture(new URL('./light-cones-browser.fixture.ts', import.meta.url));
  const copy = [...document.querySelectorAll('button')].find(button => button.textContent === 'edit copy in Mountain');
  assert(copy);
  copy.click();
  const input = (label: string) =>
    [...document.querySelectorAll('.lil-controller')]
      .filter(row => row.querySelector('.lil-name')?.textContent === label)
      .at(-1)!
      .querySelector('input')!;
  const angle = input('cone half-angle (°)');
  assert(Math.abs(Number(angle.value) - 85) < 0.01, 'recovered 85-degree cone is not clipped');
  angle.value = '27.5';
  angle.dispatchEvent(new Event('input', { bubbles: true }));
  angle.dispatchEvent(new Event('change', { bubbles: true }));
  const state = (window as any).lightEditor;
  assert.equal(state.value().cone, 27.5);
  assert(state.rebuilds() > 0);
  await new Promise(requestAnimationFrame);
  assert.equal(input('full cone angle (°)').value, '55');
  assert(Math.abs(Number(input('exported cone cosine').value) - Math.cos((27.5 * Math.PI) / 180)) < 0.000001);
  console.log('PASS recovered/editable cone values, live width/cosine and preview rebuild');
} finally {
  await dispose?.();
  await cleanup();
}
