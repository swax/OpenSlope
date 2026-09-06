import { responseCache } from '../response-cache';
import {
  boardSoundSource, listSoundBankLevels, listSoundBanks, readBoardSoundBytes, readBoardSoundIndex,
  readCourseEffectSoundBytes, readEnvironmentSoundBytes, readSoundIndex,
  readNamedEffectSoundBytes,
} from '../routes/audio';
import { allMountainStats, levelCensus } from '../routes/census';
import { readReferenceEffects } from '../routes/effects';
import {
  listLevelOrigins, readLevelAiPaths, readLevelBillboards, readLevelCourse, readLevelLaps, readLevelLightRig,
  readLevelLights, readLevelWorld, readLevelPatches, readLevelShowoffSeconds, readLevelSplines, readLightmapPng,
} from '../routes/levels';
import {
  readReferenceIntroMusicBytes, readReferenceMusicGraph, readReferenceMusicIndex, readReferenceMusicSampleBytes,
} from '../routes/reference-music';
import { referenceTextureRevisions, textureFiles } from '../routes/textures';
import { listCustomSounds, readCustomSoundBytes, saveCustomSound } from '../routes/sounds';
import {
  CUSTOM_ASSET_CACHE_CONTROL, invalidateCensus, invalidateProjectLibrary, readBody, RequestBodyTooLargeError,
  UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, type ApiHandler,
} from './common';
import { projectAssetCacheKey } from '../project-assets';

const SOUND_UPLOAD_LIMIT = 64 * 1024 * 1024;

/** GET /api/levels -> {levels:[...], maps:[{name, origin, course?, retailData, reasons}]}, GET /api/level?name=<LEVEL>
 *  -> {name, patches:[...], course, light, splines, aiPaths, laps, showoffSeconds} for the read-only reference
 *  layer (study an extracted level's terrain - its main course line, its grind splines + AI-path network, the
 *  sun seeded from its own Lights.json light records, and how it is raced: passes down the course, and seconds
 *  on the showoff clock). */
export const levelRoutes: Record<string, ApiHandler> = {
  // Each entry carries the folder's own origin (core/export/origin.ts), so the Reference picker can say what a
  // loaded map is — a retail extract and which slot, or an authored export and whether it borrows retail art.
  '/api/levels': async (req, res) => {
    try {
      await responseCache.json(req, res, 'levels', async () => {
        const maps = await listLevelOrigins();
        return { levels: maps.map(map => map.name), maps };
      });
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // GET /api/level-census -> {mountains:[...]} pricing EVERY map in the library, so the Reference comparison can
  // put a design beside the shipped courses; add &level=<LEVEL> for one mountain plus its heaviest models. Same
  // measurement `npm run budget` prints, from the same read (routes/census.ts).
  //
  // `&refresh=1` re-measures from the files, throwing away both caches in front of the answer: the in-memory
  // response entries here and the fingerprinted records on disk. Two layers deep is why it needs a request of
  // its own — the maps watch already invalidates the fast one when a folder changes, so a refresh is for the
  // case where nothing OBSERVABLE changed and the numbers are still doubted.
  '/api/level-census': async (req, res) => {
    try {
      const query = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = query.get('level')?.trim() ?? '';
      const refresh = query.get('refresh') === '1';
      // Both entries, not just the one asked for: see `invalidateCensus`. Done before the producer runs, so a
      // request already sharing the old promise is the one being replaced rather than the one replacing it.
      if (refresh) invalidateCensus();
      await responseCache.json(req, res, level ? `level-census:${level}` : 'level-census', async () => level
        ? await levelCensus(level, refresh) ?? { error: `no map folder named "${level}"` }
        : { mountains: await allMountainStats(refresh) });
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  '/api/level': async (req, res) => {
    try {
      const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? '';
      // Independent files are read together rather than one after the next. Texture digests share those
      // reads and land in the JSON before image loaders build their first URLs.
      await responseCache.json(req, res, `level:${name}`, async () => {
        const patchesPending = readLevelPatches(name);
        const revisionsPending = Promise.all([patchesPending, textureFiles(name)]).then(([{ patches }, files]) =>
          referenceTextureRevisions(name, [
            ...files, ...patches.flatMap(patch => patch.TexturePath ? [patch.TexturePath] : []),
          ]));
        const [patches, course, light, splines, aiPaths, laps, showoffSeconds, world, billboards,
          textureRevisions] = await Promise.all([
          patchesPending, readLevelCourse(name), readLevelLights(name),
          readLevelSplines(name), readLevelAiPaths(name), readLevelLaps(name), readLevelShowoffSeconds(name),
          readLevelWorld(name), readLevelBillboards(name), revisionsPending,
        ]);
        return {
          ...patches, course, light, splines, aiPaths, laps, showoffSeconds, world, billboards, textureRevisions,
        };
      });
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // GET /api/effects?level=<LEVEL> -> the portable graph plus the original Instances.json effect-slot joins.
  '/api/effects': async (req, res) => {
    try {
      const level = new URL(req.url ?? '', 'http://localhost').searchParams.get('level') ?? '';
      await responseCache.json(req, res, `effects:${level}`, () => readReferenceEffects(level));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // GET /api/reference-music?level=<LEVEL> -> playlist summaries; add &song=<ID> for the complete
  // PathFinder graph used by Reference ▸ Sound study and its annotated node diagram.
  '/api/reference-music': async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    try {
      const query = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = query.get('level') ?? '';
      const song = query.get('song');
      await responseCache.json(req, res, song ? `reference-music:${level}:${song}` : `reference-music:${level}`,
        () => song ? readReferenceMusicGraph(level, song) : readReferenceMusicIndex(level));
    } catch (e) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // GET /api/reference-music-sample?level=<LEVEL>&song=<ID>&sample=<one-based MPF id> -> decoded WAV.
  '/api/reference-music-sample': async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    try {
      const query = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = query.get('level') ?? '';
      const song = query.get('song') ?? '';
      const sample = Number(query.get('sample') ?? '0');
      await responseCache.bytes(req, res, `reference-music-sample:${level}:${song}:${sample}`, 'audio/wav',
        UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, () => readReferenceMusicSampleBytes(level, song, sample));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  // GET /api/reference-intro-music?level=<LEVEL>&stem=<native filename> -> one selected-tier intro WAV.
  '/api/reference-intro-music': async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    try {
      const query = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = query.get('level') ?? '';
      const stem = query.get('stem') ?? '';
      await responseCache.bytes(req, res, `reference-intro-music:${level}:${stem}`, 'audio/wav',
        UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, () => readReferenceIntroMusicBytes(level, stem));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  // GET /api/effect-sound?level=<LEVEL>&slot=82[&bank=crowd|Snowmachine][&loop=1] -> a raw course-bank slot,
  // shared Crowd slot, or named fixed global environment-bank slot. `loop=1` prefers the slot's BNKl loop
  // region for a continuing ExternalSounds voice, falling back to the whole WAV.
  '/api/effect-sound': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = q.get('level') ?? '';
      const slot = Number(q.get('slot') ?? '-1');
      const bank = q.get('bank')?.trim() ?? '';
      const loop = q.get('loop') === '1';
      await responseCache.bytes(req, res, `effect-sound:${level}:${slot}:${bank}:${loop ? 'loop' : 'full'}`,
        'audio/wav', UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, () => bank && bank.toLowerCase() !== 'course'
          ? readNamedEffectSoundBytes(level, slot, bank, loop)
          : readCourseEffectSoundBytes(level, slot, 'course', loop));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  // Authored environment beds use the shared AUDIO.BIG banks without naming an arbitrary donor course.
  // GET /api/environment-sound?bank=Wind1&slot=0[&loop=1] -> the first installed identical bank copy.
  '/api/environment-sound': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const bank = q.get('bank')?.trim() ?? '';
      const slot = Number(q.get('slot') ?? '-1');
      const loop = q.get('loop') === '1';
      await responseCache.bytes(req, res, `environment-sound:${bank}:${slot}:${loop ? 'loop' : 'full'}`,
        'audio/wav', UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, () => readEnvironmentSoundBytes(bank, slot, loop));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  // Sound Library index: GET /api/sound-banks -> {levels:[...]} naming every level with an extracted
  // Audio/SFX tree; GET /api/sound-banks?level=<LEVEL> -> {level, banks:[{name, kind, slots:[...]}]} listing
  // the slots each of that level's banks actually populates. Slot bytes still come from /api/effect-sound.
  '/api/sound-banks': async (req, res) => {
    try {
      const level = new URL(req.url ?? '', 'http://localhost').searchParams.get('level')?.trim() ?? '';
      await responseCache.json(req, res, `sound-banks:${level}`, async () => level
        ? { level, banks: await listSoundBanks(level), soundIndex: await readSoundIndex(level) }
        : { levels: await listSoundBankLevels() });
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // Board-ride audio, from the shared level-independent banks any extracted level carries:
  // GET /api/board-audio -> shared bank sources plus the locally extracted surface-family routes,
  // GET /api/board-sound?slot=4[&bank=zboard|zbxsfx][&loop=1] -> that slot's WAV (loop prefers NNN.loop.wav).
  '/api/board-audio': async (req, res) => {
    try {
      await responseCache.json(req, res, 'board-audio', async () => ({
        board: (await boardSoundSource('zboard'))?.level ?? null,
        boost: (await boardSoundSource('zbxsfx'))?.level ?? null,
        surfaceGroups: (await readBoardSoundIndex())?.SurfaceGroups ?? null,
      }));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  '/api/board-sound': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const bank = q.get('bank')?.trim() || 'zboard';
      const slot = Number(q.get('slot') ?? '-1');
      const loop = q.get('loop') === '1';
      await responseCache.bytes(req, res, `board-sound:${bank}:${slot}:${loop}`, 'audio/wav',
        UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, () => readBoardSoundBytes(bank, slot, loop));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  // Mountain-local hit sounds (assets/sounds): GET /api/custom-sounds -> {sounds:[...]},
  // GET /api/custom-sound?name=<stem>.wav -> normalized PCM16-mono WAV bytes,
  // POST /api/sound-upload?name=<stem> -> store an uploaded WAV (normalized); the answer's `name` is the
  // name it landed under, which is `<stem>_2.wav` and up when the stem was taken (docs/038).
  '/api/custom-sounds': async (req, res) => {
    try {
      await responseCache.json(req, res, projectAssetCacheKey('custom-sounds'),
        async () => ({ sounds: await listCustomSounds() }));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  '/api/custom-sound': async (req, res) => {
    try {
      const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? '';
      // a stored sound's name is its identity — an upload is never written over one, so its bytes cache
      await responseCache.bytes(req, res, projectAssetCacheKey(`custom-sound:${name}`),
        'audio/wav', CUSTOM_ASSET_CACHE_CONTROL,
        () => readCustomSoundBytes(name));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  '/api/sound-upload': async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const name = await saveCustomSound(q.get('name') ?? 'sound', await readBody(req, SOUND_UPLOAD_LIMIT));
      invalidateProjectLibrary();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name }));
    } catch (e) {
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // GET /api/lightrig?level=<LEVEL> -> the level's WHOLE light rig (Lights.json) as a LightRigPayload, for
  // the read-only reference light overlay (show the original sign / tunnel / point lights on the terrain).
  // Fetched on demand only when the overlay is switched on.
  '/api/lightrig': async (req, res) => {
    try {
      const level = new URL(req.url ?? '', 'http://localhost').searchParams.get('level') ?? '';
      await responseCache.json(req, res, `lightrig:${level}`,
        async () => await readLevelLightRig(level) ?? { level, lights: [], error: 'no Lights.json' });
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // GET /api/lightmap?level=<LEVEL>&id=0 -> the level's lightmap PNG (alpha = A_S intensity), for the
  // lighting study to decode and fit the recovered sun against. (Per-surface default slots now surface
  // in the export preflight, POST /api/preflight — docs/011.)
  '/api/lightmap': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = q.get('level') ?? '', id = Number(q.get('id') ?? '0');
      await responseCache.bytes(req, res, `lightmap:${level}:${id}`, 'image/png',
        UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, () => readLightmapPng(level, id));
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
      // Only a known absent map is terminal on the client. Import/read/server failures stay retryable.
      res.statusCode = message.startsWith('no lightmap ') ? 404 : 500;
      res.end(message);
    }
  },
};
