import { join } from 'node:path';
import { ANNOUNCER_EVENTS, ANNOUNCER_EVENT_IDS, type AnnouncerEvent, type AnnouncerIndex } from '../../core/audio/announcer';
import { listDir, readBytesOrNull } from '../fs-async';
import { mapsRoot } from '../workspace-config';

const root = () => join(mapsRoot(), 'Shared', 'speech', 'mc');
const clipName = /^\d{3,}\.wav$/i;

/** Only the seven named MC banks are exposed; absent extracts are ordinary empty banks. */
export async function readAnnouncerIndex(): Promise<AnnouncerIndex> {
  return Object.fromEntries(await Promise.all(ANNOUNCER_EVENT_IDS.map(async id =>
    [id, (await listDir(join(root(), ANNOUNCER_EVENTS[id].bank))).filter(name => clipName.test(name)).sort()],
  ))) as AnnouncerIndex;
}

export async function readAnnouncerSound(event: string, file: string): Promise<Buffer> {
  if (!ANNOUNCER_EVENT_IDS.includes(event as AnnouncerEvent) || !clipName.test(file))
    throw new Error('Invalid announcer event or clip');
  const bytes = await readBytesOrNull(join(root(), ANNOUNCER_EVENTS[event as AnnouncerEvent].bank, file));
  if (!bytes) throw new Error('Announcer clip is not extracted');
  return bytes;
}
