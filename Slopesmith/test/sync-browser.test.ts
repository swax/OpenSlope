import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import { createSessionChannel } from '../src/app/net/session-channel';
import { createRegisterSync } from '../src/app/net/register-sync';
import type { EditDoc } from '../src/core/doc/doc-edit';

// A real browser follows a second editor over the real room/socket, with an isolated project directory.
const root = mkdtempSync(join(tmpdir(), 'slopesmith-sync-browser-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
process.env.PORT = String(api.port);
const vite = await createServer({
  root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let channel: ReturnType<typeof createSessionChannel> | undefined;
let failurePage: Page | undefined;
type Observation = {
  slopesmith: {
    snapshot(): { mode: string; selection: { rail: number | null; railNode: number | null }; camera: unknown };
    doc(): EditDoc;
    errors(): unknown[];
    refresh(): unknown;
    pickAt(x: number, y: number): { target: string; railIndex?: number } | null;
  };
  syncLoadCount: number;
};
try {
  const corners: number[] = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) corners.push(r * 20, 0, c * 20);
  const authored = meshFromNet({ rows: 6, cols: 6, spacing: 20, corners, paint: {} },
    { name: 'SYNC_BROWSER', course: starterCourse(), baseSurface: 1 });
  const centre = [50, 0, 50];
  authored.rails = [{ id: 'rail:sync', name: 'Sync rail', height: 3, texture: '', nodes: [
    [centre[0] - 15, centre[1] + 3, centre[2]], [centre[0] + 15, centre[1] + 3, centre[2]],
  ] }];
  const created = await fetch(`${api.url}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-slopesmith-client': 'browser-fixture' },
    body: JSON.stringify({ document: authored }),
  });
  assert(created.ok);
  const project = await created.json() as { project: { id: string }; document: EditDoc };
  await vite.listen();
  browser = await chromium.launch({
    executablePath: chromiumExecutable(), headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  failurePage = page;
  const errors: string[] = [];
  let musicRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/custom-music') musicRequests++;
  });
  page.on('pageerror', error => errors.push(error.message));
  // A long silent WAV exercises the real preview lifetime without needing extracted game audio.
  const pcmBytes = 8000 * 60 * 2;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + pcmBytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcmBytes, 40);
  await page.route('**/api/board-audio', route => route.fulfill({ json: { board: 'zboard', surfaceGroups: [] } }));
  await page.route('**/api/board-sound?*', route => route.fulfill({ contentType: 'audio/wav', body: wav }));
  await page.goto(`${vite.resolvedUrls!.local[0]}?map=SYNC_BROWSER&agent=1`);
  await page.waitForFunction(() => !!(window as unknown as Observation).slopesmith
    && document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false', undefined, { timeout: 60_000 });
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert((await page.locator('body').innerText()).includes('Edit'));
  console.log('Browser loaded: editor controls render, no Vite overlay.');

  // Pick a rail through the UI, then move the camera off its default framing. The old loading path
  // would clear this selection and call focusMountain() on every remote topology edit.
  await page.getByRole('button', { name: 'Props', exact: true }).first().click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.refresh());
  await page.screenshot({ path: join(root, 'before.png') });
  const rail = page.locator('[data-agent-ref="rail:0"]');
  await rail.waitFor({ state: 'visible' });
  // Agent proxies deliberately pass pointer events through to the canvas. Click their observed location.
  const box = await rail.boundingBox();
  assert(box);
  const hit = await page.evaluate(box => {
    const observe = (window as unknown as Observation).slopesmith;
    // The proxy names an endpoint; an open tube has no cap there. Find a nearby ray on the actual tube.
    for (let dy = -8; dy <= 8; dy += 1) for (let dx = -8; dx <= 8; dx += 1) {
      const x = box.x + box.width / 2 + dx, y = box.y + box.height / 2 + dy;
      const pick = observe.pickAt(x, y);
      if (pick?.target === 'rail' && pick.railIndex === 0) return { x, y };
    }
    return null;
  }, box);
  assert(hit, 'the rail fixture has a pickable tube');
  await page.mouse.click(hit.x, hit.y);
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.snapshot().selection.rail === 0);
  await page.mouse.move(600, 500);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(700); // let the camera's inertial zoom settle before comparing its position
  const before = await page.evaluate(() => (window as unknown as Observation).slopesmith.snapshot());
  await page.evaluate(() => {
    const observed = window as unknown as Observation;
    observed.syncLoadCount = 0;
    new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'aria-busy')
        && document.querySelector('#load-status')?.getAttribute('aria-busy') === 'true') observed.syncLoadCount++;
    }).observe(document.querySelector('#load-status')!, { attributes: true });
  });

  let doc = project.document, joined = false;
  const sync = createRegisterSync({
    getDoc: () => doc, setDoc: next => { doc = next; },
    channel: {
      assign: (changes, batch) => channel!.assign(changes, batch),
      claim: (ids, delta, changes, batch) => channel!.claim(ids, delta, changes, batch),
      checkDrift: digest => channel!.checkDrift(digest), fetchSections: sections => channel!.fetchSections(sections),
    },
  });
  channel = createSessionChannel({
    clientId: 'remote-browser-test', url: () => `${api.url.replace('http', 'ws')}/api/session?client=remote-browser-test`,
    onJoined: () => { joined = true; sync.connect(); },
    onSync: push => sync.applySync(push.changes, push.by), onLanded: ack => sync.landed(ack),
    onClaim: result => sync.claimed(result), onTopology: push => sync.applyTopology(push),
    onCaughtUp: missed => sync.caughtUp(missed),
  });
  channel.start();
  channel.watch(project.project.id);
  const deadline = Date.now() + 5000;
  while (!joined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(joined);
  const oldCount = doc.quads.length;
  const initialMusicRequests = musicRequests;
  const deleted = applyMeshDelete(doc, { quads: [0] });
  assert(deleted.ok);
  doc = deleted.doc;
  sync.noteEdit();
  sync.flush();
  await page.waitForFunction(count => (window as unknown as Observation).slopesmith.doc().quads.length === count, oldCount - 1);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    snapshot: (window as unknown as Observation).slopesmith.snapshot(),
    loads: (window as unknown as Observation).syncLoadCount,
    errors: (window as unknown as Observation).slopesmith.errors(),
  }));
  assert.deepEqual(after.snapshot.camera, before.camera, 'remote topology preserves camera');
  assert.deepEqual(after.snapshot.selection, before.selection, 'surviving selection remains selected');
  assert.equal(after.snapshot.mode, before.mode);
  assert.equal(after.loads, 0, 'remote topology never opens the map loader');
  assert.deepEqual(after.errors, []);
  assert.deepEqual(errors, []);
  assert.equal(musicRequests, initialMusicRequests, 'terrain sync does not reload the hidden music library');

  // Keep a Sound field focused and a real audio preview playing while another terrain snapshot arrives.
  await page.getByRole('button', { name: 'Scene', exact: true }).first().click();
  await page.locator('.sp-scene-categories').getByRole('button', { name: /Sound/ }).click();
  await page.locator('.sp-scene-gui .lil-title').filter({ hasText: /^Board sound$/ }).click();
  await page.getByRole('button', { name: /hear surface/ }).first().click();
  await page.getByRole('button', { name: /stop sound/ }).first().waitFor({ state: 'visible' });
  const bpm = page.getByRole('textbox', { name: 'BPM', exact: true });
  await bpm.focus();
  const soundInput = await bpm.elementHandle();
  const courseInput = await page.getByLabel('base ride feel', { exact: true }).elementHandle();
  assert(soundInput && courseInput);
  const second = applyMeshDelete(doc, { quads: [0] });
  assert(second.ok);
  doc = second.doc;
  sync.noteEdit(); sync.flush();
  await page.waitForFunction(count => (window as unknown as Observation).slopesmith.doc().quads.length === count, oldCount - 2);
  await page.waitForTimeout(300);
  assert(await soundInput.evaluate(input => input.isConnected && document.activeElement === input),
    'untouched Sound field retains its DOM node and focus');
  assert(await courseInput.evaluate(input => input.isConnected), 'untouched Course controls retain their DOM nodes');
  assert.equal(musicRequests, initialMusicRequests, 'terrain sync does not refetch the visible music library');
  assert(await page.getByRole('button', { name: /stop sound/ }).first().isVisible(), 'board preview survives sync');
  await bpm.fill('141');
  await bpm.press('Tab');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().raceMusicArrangement?.bpm === 141);
  await page.locator('.sp-scene-categories').getByRole('button', { name: /Course/ }).click();
  const surface = page.getByLabel('base ride feel', { exact: true });
  const surfaceLabel = await surface.locator('option').filter({ hasText: /^2 / }).textContent();
  assert(surfaceLabel);
  await surface.selectOption({ label: surfaceLabel });
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().baseSurface === 2);
  const editDeadline = Date.now() + 5000;
  while ((doc.baseSurface !== 2 || doc.raceMusicArrangement?.bpm !== 141) && Date.now() < editDeadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(doc.baseSurface, 2, 'preserved Course control writes the current document and reaches the other editor');
  assert.equal(doc.raceMusicArrangement?.bpm, 141, 'preserved Sound control writes the current document');

  // A snapshot that DOES change Course settings must still update the inspector.
  const third = applyMeshDelete(doc, { quads: [0] });
  assert(third.ok);
  doc = third.doc;
  doc.baseSurface = 3;
  sync.noteEdit(); sync.flush();
  await page.waitForFunction(count => (window as unknown as Observation).slopesmith.doc().quads.length === count, oldCount - 3);
  await page.waitForFunction(() => [...document.querySelectorAll('.sp-scene-gui .lil-controller')].some(controller =>
    controller.querySelector('.lil-name')?.textContent === 'base ride feel' && controller.querySelector('select')?.value.startsWith('3 ')));
  assert((await surface.inputValue()).startsWith('3 '), 'changed Course settings are refreshed');
  assert.equal(await courseInput.evaluate(input => input.isConnected), false, 'affected Course controls are replaced');

  // Somebody else's topology no longer resets this editor's undo (docs/039): the Course edit made before it is
  // still one Ctrl+Z away, and undoing it re-asserts what this editor had before — over the remote value.
  const undoButton = page.getByRole('button', { name: 'Undo', exact: true }).first();
  assert(await undoButton.isEnabled(), 'a register edit made before a remote topology change can still be undone');
  await undoButton.click();
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().baseSurface === 1);
  const undoDeadline = Date.now() + 5000;
  while (doc.baseSurface !== 1 && Date.now() < undoDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(doc.baseSurface, 1, 'and the undo reaches the other editor as an ordinary assignment');
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(root, 'synced.png') });
  console.log(`SYNC BROWSER PASS: remote edits preserve camera, selection, focus and audio; retained controls edit the live map; changed controls refresh. Screenshot: ${join(root, 'synced.png')}`);
} catch (error) {
  if (failurePage) {
    await failurePage.screenshot({ path: join(root, 'failure.png') });
    console.error(`Browser failure screenshot: ${join(root, 'failure.png')}`);
    console.error(await failurePage.locator('.sp-scene-gui').innerText());
  }
  throw error;
} finally {
  channel?.close();
  await browser?.close();
  await vite.close();
  await api.close();
}
