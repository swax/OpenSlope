// tier: fast

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'src/app/ui/chrome/users-mode.ts'), 'utf8');
const mainSource = readFileSync(resolve(process.cwd(), 'src/app/main.ts'), 'utf8');
const renderStart = source.indexOf('function render(): void');
const renderEnd = source.indexOf('function refresh(): void', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'the Users panel render function is present');
const render = source.slice(renderStart, renderEnd);

const online = render.indexOf('gui.addFolder(`Online ${online}`)');
const offline = render.indexOf('gui.addFolder(`Offline ${offlineMembers.length}`)');
const offlineClose = render.indexOf('offline.close()', offline);
const jukebox = render.indexOf('buildJukebox()', offline);
const management = render.indexOf('buildManagement()', jukebox);
const mapPermissions = render.indexOf('buildMapPermissions()', management);

assert.ok(online >= 0 && offline > online,
  'online and offline members have separate folders, in that order');
assert.ok(offlineClose > offline && offlineClose < jukebox,
  'the offline-members folder starts collapsed');
assert.ok(jukebox > offline && management > jukebox && mapPermissions > management,
  'map permissions render last, after member, Jukebox, and management panels');
assert.doesNotMatch(render, /appendSection\('Offline'/,
  'offline accounts are no longer mixed into the online roster folder');
assert.doesNotMatch(render, /member\$\{roster\.members\.length === 1[\s\S]*connected/,
  'the Online and Offline folder counts replace the redundant roster summary');
assert.doesNotMatch(render, /detail\(gui, `\$\{roster\.me\.username\} · \$\{roster\.me\.role\}`, 'you'\)/,
  'the roster folders replace the redundant signed-in-user summary row');
assert.match(render, /\.name\('Your status'\)/,
  'signed-in members get an immediate manual status selector above the roster');
assert.match(source, /status-idle[\s\S]*status-away[\s\S]*status-dnd/,
  'Idle, Away, and Do Not Disturb each receive a distinct dot style');
assert.match(source, /aria-label', `\$\{member\.username\}: \$\{STATUS_LABELS\[status\]\}`/,
  'the status dot names its state accessibly instead of relying on color alone');

assert.match(source,
  /gui\.addFolder\(`Jukebox · \$\{playbackEnabled \? 'On' : 'Off'\}`\)/,
  'the Jukebox heading summarizes whether local playback is on or off');
assert.match(source, /sp-jukebox-info[\s\S]*showJukeboxMessageInfo/,
  'a Jukebox status can expose its bridge diagnosis through a clickable info control');
assert.match(source, /info\.setAttribute\('aria-label', jukeboxInfo\.title\)/,
  'the Jukebox info control carries the diagnostic title as its accessible name');
assert.match(mainSource, /video bridge not set up[\s\S]*video bridge failed[\s\S]*course screens off/,
  'YouTube playback says whether the bridge is unconfigured or failed and that course screens are off');
assert.match(mainSource, /actionLabel: 'Open bridge settings'[\s\S]*openSettingsDialog\('integrations'\)/,
  'the fallback diagnosis links directly to the relevant Settings tab');
const jukeboxStart = source.indexOf('function buildJukebox(): void');
const jukeboxEnd = source.indexOf('function buildManagement(): void', jukeboxStart);
assert.doesNotMatch(source.slice(jukeboxStart, jukeboxEnd), /folder\.close\(\)/,
  'the Jukebox starts expanded');
assert.match(source,
  /gui\.addFolder\(`Map permissions · \$\{policy\.restricted \? 'Restricted' : 'Open'\}`\);\s*folder\.close\(\)/,
  'the bottom, collapsed map-permissions heading summarizes its open or restricted policy');

console.log('USERS MODE LAYOUT: PASS');
