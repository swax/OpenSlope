import { responseCache } from '../response-cache';
import {
  levelsWithSkybox, listCustomSkies, readCustomGroundPng, readCustomSkyPng, readLevelGroundPng,
  readLevelGroundRevision, readLevelPanorama, readLevelPanoramaRevision, readSkyPageBytes,
  readSkyPageRevision, readSkyRing, readSkyRingFiles, resolveSkyRingLevel, saveCustomSky,
} from '../routes/skybox';
import {
  CUSTOM_ASSET_CACHE_CONTROL, invalidateProjectLibrary, readBody, readFalGenerationHeader,
  referenceAssetCacheControl, REFERENCE_ASSET_CACHE_CONTROL, RequestBodyTooLargeError, type ApiHandler,
} from './common';
import { projectAssetCacheKey } from '../project-assets';

const SKY_UPLOAD_LIMIT = 64 * 1024 * 1024;

/** GET /api/skybox -> {levels:[...], skies:[...]} (levels that ship a sky, plus the user's own panoramas),
 *  GET /api/skypano?level=<LEVEL> | ?sky=<NAME> -> that sky's horizon panorama PNG (its measured wall panels
 *  stitched at their real azimuth spans), GET /api/skyground?level=<LEVEL> -> its ground disc,
 *  POST /api/skyupload?name=<NAME> -> store an image as a panorama (re-projected into the ring band); the
 *  answer's `name` is the name it landed under, `<NAME>_2` and up when the name was taken (docs/038).
 *  Feeds the Skybox panels on both the Reference and Mountain tabs (docs/025).
 *
 *  Two sub-paths serve an export composed in the browser, which needs the ring itself rather than the
 *  stitched preview: GET /api/skybox/ring?level=<PREFERRED> -> the ring level actually resolved, its
 *  `Skybox/` shell (Models.json, Materials.json, Meshes/*, Ring.json) base64'd, and its complete measured ring;
 *  GET /api/skybox/page?level=<LEVEL>&index=<slot> -> one shipped page, verbatim. */
export const skyboxRoutes: Record<string, ApiHandler> = {
  '/api/skybox': async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    // A ring or a page that cannot be found is a missing asset, the same 404 the byte routes below answer
    // with; the catalogue is a read of the whole library, so its failure is the server's.
    if (url.pathname === '/ring' || url.pathname === '/page') {
      try {
        if (url.pathname === '/page') {
          const level = url.searchParams.get('level') ?? '';
          const index = Number(url.searchParams.get('index') ?? '-1');
          await responseCache.bytes(req, res, `sky-page:${level}:${index}`, 'image/png',
            REFERENCE_ASSET_CACHE_CONTROL, () => readSkyPageBytes(level, index));
        return;
        }
        const preferred = url.searchParams.get('level') ?? '';
        await responseCache.json(req, res, `sky-ring:${preferred}`, async () => {
          const level = await resolveSkyRingLevel(preferred);
          const [files, ring] = await Promise.all([readSkyRingFiles(level), readSkyRing(level)]);
          const pageVersions = await Promise.all(Array.from(
            { length: ring.tiles.length }, (_unused, index) => readSkyPageRevision(level, index)));
          return {
            level,
            ring,
            pageVersions,
            files: files.map(file => ({ path: file.path, bytes: Buffer.from(file.bytes).toString('base64') })),
          };
        });
      } catch (e) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
      }
      return;
    }
    try {
      await responseCache.json(req, res, projectAssetCacheKey('skybox'), async () => {
        const levels = await levelsWithSkybox();
        const entries = await Promise.all(levels.map(async level => {
          const [ring, panorama, ground] = await Promise.all([
            readSkyRing(level),
            readLevelPanoramaRevision(level).catch(() => null),
            readLevelGroundRevision(level).catch(() => null),
          ]);
          return { level, ring, panorama, ground };
        }));
        const rings = Object.fromEntries(entries.map(entry => [entry.level, entry.ring]));
        const versions = Object.fromEntries(entries.map(entry => [entry.level, {
          ...(entry.panorama ? { panorama: entry.panorama } : {}),
          ...(entry.ground ? { ground: entry.ground } : {}),
        }]));
        return { levels, skies: await listCustomSkies(), rings, versions };
      });
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  '/api/skypano': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = q.get('level'), sky = q.get('sky');
      // A stored panorama's name is its identity, so a custom sky is immutable. A replaceable extracted sky
      // is immutable when its URL carries the content digest published by the catalogue; older clients get
      // a bounded lifetime instead.
      await responseCache.bytes(req, res, level ? `skypano:level:${level}`
        : projectAssetCacheKey(`skypano:custom:${sky ?? ''}`),
        'image/png', level
          ? referenceAssetCacheControl(await readLevelPanoramaRevision(level)) : CUSTOM_ASSET_CACHE_CONTROL,
        () => level ? readLevelPanorama(level) : readCustomSkyPng(sky ?? ''));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  // a level ships an aerial photo of the ground under its horizon; a custom sky's disc is derived from
  // its own panorama, by the same cut the export makes
  '/api/skyground': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = q.get('level'), sky = q.get('sky');
      await responseCache.bytes(req, res, level ? `skyground:level:${level}`
        : projectAssetCacheKey(`skyground:custom:${sky ?? ''}`),
        'image/png', level ? REFERENCE_ASSET_CACHE_CONTROL : CUSTOM_ASSET_CACHE_CONTROL,
        () => level ? readLevelGroundPng(level) : readCustomGroundPng(sky ?? '', q.get('ring') ?? ''));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  '/api/skyupload': async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const fit = (q.get('fit') ?? 'auto') as 'auto' | 'band' | 'equirect';
      const name = await saveCustomSky(
        q.get('name') ?? 'sky', await readBody(req, SKY_UPLOAD_LIMIT), fit, q.get('ring') ?? '',
        readFalGenerationHeader(req));
      invalidateProjectLibrary();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name }));
    } catch (e) {
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },
};
