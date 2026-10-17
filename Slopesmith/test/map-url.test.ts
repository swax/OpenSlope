// tier: fast
import assert from 'node:assert/strict';
import { editorAccountUrl, mapNameAtPath, mapPath, pageInPath } from '../src/app/navigation';
import { mapNameInUrl, showMapInUrl } from '../src/app/state/map-url';

for (const [pathname, page] of [
  ['/maps', 'maps'],
  ['/isos', 'isos'],
  ['/play/RUN', 'play'],
  ['/editor/RUN', 'editor'],
  ['/editor', 'editor'],
  ['/ISOS/', 'isos'],
  ['/play/Elysium%20Alps', 'play'],
] as const)
  assert.equal(pageInPath(pathname), page);
for (const pathname of ['/maps/RUN', '/isos/RUN', '/editor/RUN/other', '/players', '/RUN', '/home']) {
  assert.equal(pageInPath(pathname), null);
}
assert.equal(mapPath('play', 'My_Run'), '/play/My_Run');
assert.equal(mapPath('editor', 'maps'), '/editor/maps', 'root page names remain valid mountain names');
assert.equal(mapPath('play', 'Elysium Alps'), '/play/Elysium%20Alps');
assert.equal(mapNameAtPath('/play/Elysium%20Alps', 'play'), 'Elysium Alps');
assert.equal(mapNameAtPath('/editor/My_Run/', 'editor'), 'My_Run');
for (const pathname of ['/play/My_Run', '/editor/%', '/editor/a%2Fb', '/editor/a%5Cb', '/editor/RUN/other']) {
  assert.equal(mapNameAtPath(pathname, 'editor'), '', 'only a valid editor name segment is accepted');
}
assert.equal(editorAccountUrl('profile'), '/editor?account=profile');
assert.equal(editorAccountUrl('settings'), '/editor?account=settings');

// A rename or map switch must keep editor options and fragments without adding a navigation entry.
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
const historyDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'history');
let current = new URL('https://slopesmith.example/editor/RUN?agent=1#camera');
let replacements = 0;
const state = { retained: true };
Object.defineProperty(globalThis, 'location', { configurable: true, get: () => current });
Object.defineProperty(globalThis, 'history', {
  configurable: true,
  value: {
    state,
    replaceState(next: unknown, _unused: string, url: string) {
      assert.equal(next, state);
      current = new URL(url, current);
      replacements++;
    },
  },
});
try {
  assert.equal(mapNameInUrl(), 'RUN');
  showMapInUrl('RENAMED');
  assert.equal(current.href, 'https://slopesmith.example/editor/RENAMED?agent=1#camera');
  assert.equal(mapNameInUrl(), 'RENAMED');
  showMapInUrl('RENAMED');
  assert.equal(replacements, 1, 'an unchanged map does not rewrite history');
  showMapInUrl('assets');
  assert.equal(mapNameInUrl(), 'assets', 'static root directories are valid nested map names');
  showMapInUrl('');
  assert.equal(current.pathname, '/editor', 'no durable map leaves the editor at its base route');
  assert.equal(mapNameInUrl(), '');
  current = new URL('https://slopesmith.example/play/RUN');
  assert.equal(mapNameInUrl(), '', 'a public player route never selects a project for editor boot');
} finally {
  if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
  else Reflect.deleteProperty(globalThis, 'location');
  if (historyDescriptor) Object.defineProperty(globalThis, 'history', historyDescriptor);
  else Reflect.deleteProperty(globalThis, 'history');
}
console.log('MAP URL PASS: separate browse/play/editor routes, named maps and editor rename navigation.');
