// tier: fast

import { jukeboxPosition } from '../src/core/session/jukebox';
import { createJukebox } from '../src/server/session/jukebox';
import type { SessionMember } from '../src/server/session/presence';
import { check, failures } from './check';

const member = (id: string, role: SessionMember['role'] = 'viewer'): SessionMember => ({
  id, username: id, role,
});

let now = 1_000;
const jukebox = createJukebox(() => now);
const ada = member('ada');
const grace = member('grace');
const lin = member('lin', 'moderator');

check(!jukebox.add(ada, 'https://example.com/watch?v=dQw4w9WgXcQ').ok,
  'the server accepts only public YouTube identities');
const first = jukebox.add(ada, 'https://youtu.be/dQw4w9WgXcQ');
check(first.ok && first.state.current?.userId === 'ada' && first.state.playing,
  'the first contribution becomes the server-wide current video');
if (!first.ok || !first.state.current) process.exit(1);
const firstId = first.state.current.id;

jukebox.add(ada, 'M7lc1UVf-VE');
jukebox.add(ada, 'aqz-KE-bpKQ');
jukebox.add(grace, 'ysz5S6PUM-U');
const fair = jukebox.snapshot();
check(fair.queue.map(entry => entry.userId).join(',') === 'ada,grace,ada',
  'fair insertion gives everybody a first pending turn before one person gets a second');

const graceEntry = fair.queue.find(entry => entry.userId === 'grace')!;
check(!jukebox.remove(ada, graceEntry.id).ok,
  'an ordinary member cannot remove somebody else’s queued video');
check(jukebox.remove(lin, graceEntry.id).ok,
  'a moderator can remove somebody else’s queued video');

const versionBeforeSeek = jukebox.snapshot().mediaVersion;
now = 5_000;
const sought = jukebox.seek(firstId, 42.5);
check(sought.ok && sought.state.position === 42.5 && sought.state.changedAt === now
  && sought.state.mediaVersion === versionBeforeSeek,
  'a seek re-anchors the shared clock without asking clients to reload the stream');
if (sought.ok) {
  check(jukeboxPosition(sought.state, now + 2_500) === 45,
    'late clients derive the same advancing playhead from server time');
}

now = 6_000;
const paused = jukebox.setPlaying(firstId, false);
check(paused.ok && !paused.state.playing && paused.state.position === 43.5
  && jukeboxPosition(paused.state, now + 5_000) === 43.5,
  'pause freezes the shared playhead without changing the media epoch');
now = 9_000;
const resumed = jukebox.setPlaying(firstId, true);
check(resumed.ok && resumed.state.playing && resumed.state.position === 43.5
  && jukeboxPosition(resumed.state, now + 1_500) === 45,
  'play resumes the same shared media epoch from its frozen position');

check(!jukebox.skip(grace, firstId).ok, 'only the queuer or a moderator can skip the current video');
const skipped = jukebox.skip(ada, firstId);
check(skipped.ok && skipped.state.current?.userId === 'ada' && skipped.state.mediaVersion > versionBeforeSeek,
  'the queuer can skip and the next item starts as a fresh media epoch');
if (!skipped.ok || !skipped.state.current) process.exit(1);

check(!jukebox.ended(firstId, skipped.state.mediaVersion).ok,
  'a stale decoder end cannot double-advance a newer current item');
while (jukebox.snapshot().queue.length) {
  const state = jukebox.snapshot();
  jukebox.skip(lin, state.current!.id);
}
const last = jukebox.snapshot();
const looped = jukebox.ended(last.current!.id, last.mediaVersion);
check(looped.ok && looped.state.current?.id === last.current?.id && looped.state.position === 0
  && looped.state.mediaVersion === last.mediaVersion + 1,
  'the final intact video loops in a new epoch until somebody explicitly skips it');
const finalCurrent = jukebox.snapshot().current!;
check(jukebox.skip(lin, finalCurrent.id).ok && jukebox.snapshot().current === null,
  'a moderator can empty the current item as well as remove pending ones');

if (failures) {
  console.error(`\n${failures} jukebox check(s) failed`);
  process.exit(1);
}
console.log('\njukebox checks passed');
