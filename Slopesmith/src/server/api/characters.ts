import { responseCache } from '../response-cache';
import { listCharacterModels, readCharacterModelBytes } from '../routes/characters';
import { saveMixamoCharacter } from '../routes/mixamo-character';
import {
  CUSTOM_ASSET_CACHE_CONTROL, invalidateSharedLibrary, readBody, RequestBodyTooLargeError, type ApiHandler,
} from './common';

const CHARACTER_IMPORT_LIMIT = 96 * 1024 * 1024;

/** The server-wide rider library: drop canonical-rig GLBs in `<workspace>/library/characters` and Play
 * discovers them. Avatars belong to the server rather than to a reference map or one authored mountain. */
export const characterRoutes: Record<string, ApiHandler> = {
  '/api/characters': async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    try {
      await responseCache.json(req, res, 'characters', async () => ({ characters: await listCharacterModels() }));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  '/api/character-model': async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    try {
      const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? '';
      // a stored model's file name is its identity — an import is never written over one, so the GLB caches
      await responseCache.bytes(req, res, `character-model:${name}`, 'model/gltf-binary',
        CUSTOM_ASSET_CACHE_CONTROL, () => readCharacterModelBytes(name));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  // POST a Mixamo FBX as the raw request body. Conversion happens here in Node (Three FBXLoader +
  // GLTFExporter, backed by a native image decoder), then only the validated GLB enters the flat catalogue.
  // This deliberately does not invoke Blender or require it to be installed. The report's `file` is the name
  // it landed under, `<stem>_2.glb` and up when the name was taken (docs/038).
  '/api/character-import': async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
    res.setHeader('content-type', 'application/json');
    try {
      const source = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? 'character.fbx';
      const report = await saveMixamoCharacter(source, await readBody(req, CHARACTER_IMPORT_LIMIT));
      invalidateSharedLibrary('characters');
      res.end(JSON.stringify(report));
    } catch (e) {
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 400;
      res.end(JSON.stringify({
        error: e instanceof RequestBodyTooLargeError
          ? 'FBX is larger than the 96 MB import limit'
          : String(e instanceof Error ? e.message : e),
      }));
    }
  },
};
