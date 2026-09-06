// tier: fast

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVoiceAudioMount } from '../src/app/ui/chrome/voice-chat';

type FakeMedia = {
  hidden: boolean;
  removed: boolean;
  remove(): void;
};

const media = (): FakeMedia => ({
  hidden: false,
  removed: false,
  remove() { this.removed = true; },
});

const hosted: FakeMedia[] = [];
const host = {
  appendChild(node: FakeMedia) {
    hosted.push(node);
    return node;
  },
};
const mount = createVoiceAudioMount(host as unknown as HTMLElement);

const first = media();
const firstTrack = {
  kind: 'audio',
  attach: () => first as unknown as HTMLMediaElement,
  detach: () => [first as unknown as HTMLMediaElement],
};
mount.attach(firstTrack);
assert.deepEqual(hosted, [first], 'a subscribed voice track mounts in the supplied stable audio host');
assert.equal(first.hidden, true, 'the playback element does not add visible page chrome');
mount.detach(firstTrack);
assert.equal(first.removed, true, 'unsubscribing removes the mounted playback element');

const second = media();
mount.attach({
  kind: 'audio',
  attach: () => second as unknown as HTMLMediaElement,
  detach: () => [second as unknown as HTMLMediaElement],
});
mount.clear();
assert.equal(second.removed, true, 'leaving voice removes every remaining playback element');

const ignored = media();
mount.attach({
  kind: 'video',
  attach: () => ignored as unknown as HTMLMediaElement,
  detach: () => [ignored as unknown as HTMLMediaElement],
});
assert.equal(hosted.includes(ignored), false, 'voice playback ignores non-audio tracks');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/app/main.ts', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../src/app/ui/chrome/chat-box.ts', import.meta.url), 'utf8');
assert.match(html, /<div id="voice-audio" aria-hidden="true"><\/div>/,
  'the editor page provides a permanent audio host outside the rebuilt mode panel');
assert.match(main, /audioHost: document\.getElementById\('voice-audio'\)!/,
  'the voice session receives the permanent page host');
assert.doesNotMatch(chat, /body\.os-riding \.sp-chat \{ display: none; \}/,
  'a Test ride no longer hides the passive recent-chat feed');
assert.match(chat, /body\.os-riding \.sp-chat-line \{ pointer-events: none; cursor: default; \}/,
  'ride chat stays passive and cannot steal a steering or camera gesture');
assert.match(main, /chat\.setSpeakers\(voice\.members\(\)\.filter\(member => member\.speaking\)\)/,
  'LiveKit active-speaker changes feed the chat HUD');
assert.match(main, /if \(target\) chat\.close\(\)/,
  'starting a Test ride closes chat input before retaining its passive HUD');
assert.match(chat, /speaker\.username} is speaking in voice/,
  'the chat HUD labels each active voice speaker by name');

console.log('voice UI: stable playback, ride chat, and named active-speaker HUD');
