import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { decodeMusicLink, musicEventRoutes, musicWalkAtLevel } from '../src/core/reference/music';
import {
  resolveMusicSampleNode, rideMusicMixTargets, rideMusicPlaybackEnabled,
} from '../src/app/audio/ride-music';
import { createStore } from '../src/app/state/store';
import { exportLevel } from '../src/server/routes/export';
import { listCustomMusic, readCustomMusicBytes, stageRaceMusic } from '../src/server/routes/music';
import {
  readReferenceIntroMusicBytes, readReferenceMusicGraph, readReferenceMusicIndex, readReferenceMusicSampleBytes,
} from '../src/server/routes/reference-music';
import { check, failures, recordFailure } from './check';

function identificationWav(): Buffer {
  const rate = 8000, frames = 800, channels = 1, dataBytes = frames * channels * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0); out.writeUInt32LE(36 + dataBytes, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) out.writeInt16LE(Math.round(Math.sin(i * 440 * Math.PI * 2 / rate) * 8000), 44 + i * 2);
  return out;
}

const requested = process.argv[2];
const assetRoot = mkdtempSync(join(tmpdir(), 'slopesmith-music-assets-'));
process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = assetRoot;
const musicDir = join(assetRoot, 'music');
const fixture = requested ?? `_slopesmith_music_test_${process.pid}.wav`;
const fixturePath = join(musicDir, fixture);
let madeFixture = false;
let outDir = '';

try {
  if (!requested) {
    mkdirSync(musicDir, { recursive: true });
    writeFileSync(fixturePath, identificationWav());
    madeFixture = true;
  }
  check(existsSync(fixturePath), `source exists (${fixture})`);
  check((await listCustomMusic()).includes(fixture), 'music library lists source');
  check((await readCustomMusicBytes(fixture)).length > 44, 'music preview route reads source bytes');

  const doc = blankMountain('MUSIC_TEST');
  doc.raceMusic = fixture;
  doc.raceMusicArrangement = { mode: 'linear-loop', bpm: 138.6, loopStartSeconds: 0.02, loopEndSeconds: 0.08 };
  doc.environmentBed = { bank: 'Wind1', volume: 0.27 };
  const roundTrip = migrateMountain(JSON.parse(JSON.stringify(doc)));
  check(roundTrip.raceMusic === fixture && roundTrip.raceMusicArrangement?.mode === 'linear-loop' &&
    roundTrip.raceMusicArrangement.bpm === 138.6 && roundTrip.environmentBed?.bank === 'Wind1'
    && roundTrip.environmentBed.volume === 0.27,
  'saved-document migration preserves music and environment arrangement');

  check(JSON.stringify(rideMusicMixTargets(false, true, true)) === '{"race":0,"environment":1}'
    && JSON.stringify(rideMusicMixTargets(true, true, true)) === '{"race":1,"environment":0}',
  'Test runtime plays the environment off-board and the race track on-board');
  check(rideMusicPlaybackEnabled(true, false)
    && !rideMusicPlaybackEnabled(true, true)
    && !rideMusicPlaybackEnabled(false, false)
    && !rideMusicPlaybackEnabled(false, true),
  'a playing Jukebox overrides Test music without changing its checked preference');
  const musicDefault = createStore({ mdoc: doc, currentMode: 'play', storedUi: {} });
  const musicMuted = createStore({ mdoc: doc, currentMode: 'play', storedUi: { playMusic: false } });
  const gameQuiet = createStore({ mdoc: doc, currentMode: 'play', storedUi: { playGameVolume: 0.25 } });
  check(musicDefault.playMusicOn && !musicMuted.playMusicOn && musicDefault.playGameVolume === 1
    && gameQuiet.playGameVolume === 0.25,
  'Test audio options default audible and preserve explicit music mute / master volume');

  outDir = mkdtempSync(join(tmpdir(), 'slopesmith-music-export-'));
  const result = await exportLevel(doc, { outDir, lighting: false });
  const staged = join(outDir, 'Music', 'track.wav');
  const arrangementFile = join(outDir, 'Music', 'arrangement.json');
  const environmentFile = join(outDir, 'Audio', 'Environment.json');
  check(existsSync(staged), 'normal export stages Music/track.wav');
  const wav = readFileSync(staged);
  check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', 'staged track is RIFF WAV');
  check(wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 2, 'staged track is PCM16 stereo');
  check(wav.readUInt32LE(24) === 36000, 'staged track is 36 kHz');
  const arrangement = JSON.parse(readFileSync(arrangementFile, 'utf8')) as Record<string, unknown>;
  check(arrangement.version === 1 && arrangement.mode === 'linear-loop' && arrangement.bpm === 138.6 &&
    arrangement.loopStartSeconds === 0.02 && arrangement.loopEndSeconds === 0.08,
  'normal export stages the linear-loop arrangement contract');
  check(result.log.includes(`race music: ${fixture} → Music/track.wav + arrangement.json (linear-loop`),
    'export log identifies the staged arrangement');
  const environment = JSON.parse(readFileSync(environmentFile, 'utf8')) as Record<string, unknown>;
  const environmentBed = environment.Bed as Record<string, unknown>;
  check(environment.Schema === 'openslope-environment-audio/v1' && environmentBed.Bank === 'Wind1'
    && environmentBed.Slot === 0 && environmentBed.Volume === 0.27
    && existsSync(join(outDir, 'Audio', 'SFX', 'Wind1', '000.wav'))
    && existsSync(join(outDir, 'Audio', 'SFX', 'Wind1', '000.loop.wav')),
  'export stages the authored Maps environment contract plus full and loop-region WAVs');

  // Staging composes rather than writes: it says what `Music/` receives and what it must lose first, and the
  // export lands that. So both outcomes are driven through a real export into the same folder.
  const cleared = await stageRaceMusic(null, outDir);
  check(cleared.status === 'cleared' && cleared.existing && !cleared.files.length
    && cleared.remove.join(',') === 'Music/track.wav,Music/arrangement.json',
  'explicit none retires a previously staged track and arrangement');
  doc.raceMusic = null;
  await exportLevel(doc, { outDir, lighting: false });
  check(!existsSync(staged) && !existsSync(arrangementFile),
    'the export clears the retired track and arrangement off disk');

  mkdirSync(join(outDir, 'Music'), { recursive: true });
  writeFileSync(staged, identificationWav());
  writeFileSync(arrangementFile, '{"version":1,"mode":"retail-graph"}');
  const legacy = await stageRaceMusic(undefined, outDir);
  check(legacy.status === 'legacy' && legacy.existing && !legacy.files.length && !legacy.remove.length,
    'legacy documents preserve manually staged track.wav and arrangement');
  delete doc.raceMusic;
  await exportLevel(doc, { outDir, lighting: false });
  check(existsSync(staged) && existsSync(arrangementFile),
    'a legacy export leaves the hand-staged track where it is');

  const referenceIndex = await readReferenceMusicIndex('GARI');
  check(referenceIndex.environment?.Bank === 'Wind1' && referenceIndex.environment.Slot === 0
    && referenceIndex.environment.Volume === 0.15,
  'reference sound study reads the map-declared environment bed');
  check(referenceIndex.intro?.tier === 'C' && referenceIndex.intro.stems.length === 8
    && referenceIndex.intro.stems[0] === 'Garibaldi-C1.wav',
  'reference sound study selects Unity’s preferred intro tier in numeric stem order');
  const introWav = await readReferenceIntroMusicBytes('GARI', referenceIndex.intro!.stems[0]);
  check(introWav.length > 44 && introWav.toString('ascii', 0, 4) === 'RIFF'
    && introWav.toString('ascii', 8, 12) === 'WAVE',
  'reference intro preview serves only an indexed selected-tier WAV');
  const systemSummary = referenceIndex.songs.find(song => song.id === 'systemover');
  check(systemSummary?.nodes === 348 && systemSummary.samples === 318,
    'reference sound study indexes the retail System Overload graph');
  const systemGraph = await readReferenceMusicGraph('GARI', 'systemover');
  const routes = musicEventRoutes(systemGraph);
  check(routes.some(route => route.event === 1 && route.target === 338),
    'event table resolves uber tier 1 to node 338');
  check(routes.some(route => route.event === 10 && route.target === 332),
    'event table resolves the finish stinger to node 332');
  const entryLinks = systemGraph.Nodes[0].LinkRaw.map(decodeMusicLink);
  check(entryLinks.length === 2 && entryLinks[0].min === 0 && entryLinks[0].max === 39 && entryLinks[0].target === 2 &&
    entryLinks[1].min === 39 && entryLinks[1].max === 127 && entryLinks[1].target === 10,
  'reference sound study decodes entry-node path-level branches');
  check(resolveMusicSampleNode(systemGraph, 0, 30) === 2
    && resolveMusicSampleNode(systemGraph, 0, 80) === 10,
  'Test runtime resolves the entry control node at the live PathFinder intensity');
  const calmWalk = musicWalkAtLevel(systemGraph, 2, 30, 8);
  const raceWalk = musicWalkAtLevel(systemGraph, 2, 80, 8);
  check(calmWalk.samples.length === 8 && calmWalk.nodes[1] === 3 && raceWalk.samples.length === 8 && raceWalk.nodes[1] === 11,
    'reference audition follows the first link matching its selected path level');
  const stinger = musicWalkAtLevel(systemGraph, 338);
  check(stinger.stop === 'loop' && stinger.samples.length === 8 && stinger.nodes[0] === 338 && stinger.nodes.at(-1) === 339,
    'reference audition follows a deterministic stinger until its loop returns');
  const referenceWav = await readReferenceMusicSampleBytes('GARI', 'systemover', 1);
  check(referenceWav.length > 44 && referenceWav.toString('ascii', 0, 4) === 'RIFF' &&
    referenceWav.toString('ascii', 8, 12) === 'WAVE', 'reference audition serves the selected decoded WAV');
} catch (e) {
  console.error(e);
  recordFailure();
} finally {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  if (madeFixture) rmSync(fixturePath, { force: true });
  rmSync(assetRoot, { recursive: true, force: true });
}

if (failures) process.exit(1);
console.log(`race-music tests passed (${fixture})`);
