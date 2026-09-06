import { responseCache } from '../response-cache';
import { customMusicContentType, listCustomMusic, readCustomMusicBytes, saveCustomMusic } from '../routes/music';
import {
  CUSTOM_ASSET_CACHE_CONTROL, invalidateProjectLibrary, readBody, RequestBodyTooLargeError, type ApiHandler,
} from './common';
import { projectAssetCacheKey } from '../project-assets';

const MUSIC_UPLOAD_LIMIT = 256 * 1024 * 1024;

/** Full-length author music library: sources live in the open mountain's assets/music, outside Vite's public tree. The
 * scene Sound panel lists and auditions originals here; export performs the PCM16 conversion separately. */
export const musicRoutes: Record<string, ApiHandler> = {
  '/api/custom-music': async (req, res) => {
    try {
      if (req.method === 'GET') {
        await responseCache.json(req, res, projectAssetCacheKey('custom-music'),
          async () => ({ tracks: await listCustomMusic() }));
        return;
      }
      if (req.method === 'POST') {
        const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const name = await saveCustomMusic(q.get('name') ?? 'track.wav', await readBody(req, MUSIC_UPLOAD_LIMIT));
        invalidateProjectLibrary();
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name }));
        return;
      }
      res.statusCode = 405;
      res.end('GET or POST only');
    } catch (e) {
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  '/api/custom-music-file': async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    try {
      const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? '';
      // a track's name is its identity in the library, so a multi-megabyte audition downloads once
      await responseCache.bytes(req, res, projectAssetCacheKey(`custom-music-file:${name}`), customMusicContentType(name),
        CUSTOM_ASSET_CACHE_CONTROL, () => readCustomMusicBytes(name));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },
};
