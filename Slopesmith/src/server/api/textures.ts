import { generateFal3dMesh, generateFalInpaint, generateFalPanorama, generateFalTexture } from '../routes/fal';
import { countImportedTextureUsers, retargetImportedTexture } from '../routes/imported-props';
import { responseCache } from '../response-cache';
import {
  CUSTOM_TEX_LEVEL, cloneCustomTexture, deleteCustomTexture, deriveLevelTextures, levelsWithTextures,
  readParticleTextureBytes, readReferenceTextureBytes, renameCustomTexture, replaceCustomTextureArt,
  saveCustomTexture,
} from '../routes/textures';
import {
  CUSTOM_ASSET_CACHE_CONTROL, invalidateProjectLibrary, readBody, readFalGenerationHeader, readJsonBody,
  REFERENCE_ASSET_CACHE_CONTROL, RequestBodyTooLargeError, type ApiHandler,
} from './common';
import { projectAssetCacheKey } from '../project-assets';

const TEXTURE_UPLOAD_LIMIT = 32 * 1024 * 1024;
const FAL_REQUEST_LIMIT = 64 * 1024 * 1024;

/** Storing and managing custom tiles share one shape: the arguments ride in the query string, image bytes
 *  (upload and replace) ride in the body, and a success invalidates the shared library the tile belongs to.
 *  Refusals are 400 with an `{error}` the client shows verbatim — "no custom texture snow.png" is the whole
 *  content of that response. */
const manageTexture = (run: (q: URLSearchParams, body: Buffer, req: Parameters<ApiHandler>[0]) =>
  Promise<Record<string, unknown>>): ApiHandler =>
  async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
    res.setHeader('content-type', 'application/json');
    try {
      const body = await readBody(req, TEXTURE_UPLOAD_LIMIT);
      const result = await run(new URL(req.url ?? '', 'http://localhost').searchParams, body, req);
      invalidateProjectLibrary();
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 400;
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  };

const falProxy = (run: (key: string, body: unknown) => Promise<{ bytes: Buffer; type: string; seed: number | null }>): ApiHandler =>
  async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
    try {
      const key = String(req.headers['x-fal-key'] ?? '');
      const body = await readJsonBody(req, FAL_REQUEST_LIMIT);
      const { bytes, type, seed } = await run(key, body);
      res.setHeader('content-type', type);
      res.setHeader('cache-control', 'no-store');
      if (seed != null) res.setHeader('x-fal-seed', String(seed));
      res.end(bytes);
    } catch (e) {
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  };

/** GET /api/textures -> {levels:[...]}, GET /api/textures?level=<LEVEL> -> LevelTextures (sets derived
 *  from the level's Patches.json), GET /api/texture?level=<LEVEL>&name=0019.png -> the PNG bytes,
 *  POST /api/texture-upload?name=<stem> -> store an image as a Custom tile ("Custom/<stem>.png"),
 *  POST /api/fal-texture -> generate a tile through fal.ai (docs/033). Feeds the texture-paint palette +
 *  WYSIWYG preview. */
export const textureRoutes: Record<string, ApiHandler> = {
  '/api/textures': async (req, res) => {
    try {
      const level = new URL(req.url ?? '', 'http://localhost').searchParams.get('level');
      const key = level?.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()
        ? projectAssetCacheKey(`textures:${level}`) : level ? `textures:${level}` : 'texture-levels';
      await responseCache.json(req, res, key,
        async () => level ? deriveLevelTextures(level) : { levels: await levelsWithTextures() });
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  '/api/texture': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = q.get('level') ?? '';
      const name = q.get('name') ?? '';
      // A stored custom tile's name is its identity. A replaceable extracted tile becomes equally immutable
      // when its URL carries the content digest published by the level/catalogue response; older clients get
      // a bounded lifetime instead.
      const key = level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()
        ? projectAssetCacheKey(`texture:${level}:${name}`) : `texture:${level}:${name}`;
      const cacheControl = level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()
        ? CUSTOM_ASSET_CACHE_CONTROL : REFERENCE_ASSET_CACHE_CONTROL;
      await responseCache.bytes(req, res, key, 'image/png', cacheControl,
        () => readReferenceTextureBytes(level, name));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },

  // An upload never lands on a name that is taken (docs/038), so `name` in the answer is the name it really
  // got — "cliff" the first time, "cliff_2" the next — and the client paints with that.
  '/api/texture-upload': manageTexture(async (q, body, req) => ({
    name: await saveCustomTexture(q.get('name') ?? 'texture', body, readFalGenerationHeader(req)),
  })),

  // Custom-tile management (docs/005): GET /api/texture-usage?name= -> what a delete or a replace would
  // cost that the editor cannot see for itself; POST /api/texture-rename?from=&to=,
  // /api/texture-clone?from=&to=, /api/texture-replace?name=, /api/texture-delete?name=. Rename and replace
  // repoint imported-prop records; delete only reports them.
  '/api/texture-usage': async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    try {
      const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? '';
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ importedProps: await countImportedTextureUsers(`${CUSTOM_TEX_LEVEL}/${name}`) }));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  '/api/texture-rename': manageTexture(async q => {
    const from = q.get('from') ?? '', to = q.get('to') ?? '';
    const name = await renameCustomTexture(from, to);
    const repointed = await retargetImportedTexture(`${CUSTOM_TEX_LEVEL}/${from}`, `${CUSTOM_TEX_LEVEL}/${name}`);
    return { name, repointed };
  }),

  '/api/texture-clone': manageTexture(async q => ({
    name: await cloneCustomTexture(q.get('from') ?? '', q.get('to') ?? ''),
  })),

  // POST /api/texture-replace?name=<stem> with the new PNG as the body — the deliberate "this tile, new art"
  // move, and the one action that changes what a painted cell shows. It is an upload plus a repoint rather
  // than a write over the old file: the art lands under its own free name, imported-prop records follow, the
  // old tile is removed, and the client repoints the live document from `replaced` to `name`. Nothing has to
  // invalidate a cache, because no URL ever answers with bytes it did not answer with before. The Blender
  // bridge pushes a tile home through the same `replaceCustomTextureArt` (docs/046).
  '/api/texture-replace': manageTexture((q, body) => replaceCustomTextureArt(q.get('name') ?? '', body)),

  '/api/texture-delete': manageTexture(async q => {
    return { deleted: await deleteCustomTexture(q.get('name') ?? '') };
  }),

  // The fal.ai proxies: POST /api/fal-texture {model, prompt, size, seed?}, /api/fal-inpaint
  // {model, prompt, image, mask, seed?}, /api/fal-panorama, /api/fal-3d — all with the key in
  // `x-fal-key` -> the generated bytes (PNG, or GLB for the 3D route; seed echoed in `x-fal-seed`).
  // Proxied rather than called from the browser so the key stays same-origin; it is used for the one
  // call and never stored. The responses are deliberately NOT run through responseCache: every
  // generation is a fresh billed result, and the client saves the bytes it likes through the ordinary
  // upload/import routes.
  '/api/fal-texture': falProxy(async (key, body) => {
    const { png, seed } = await generateFalTexture(key, body as Parameters<typeof generateFalTexture>[1]);
    return { bytes: png, type: 'image/png', seed };
  }),

  // POST /api/fal-inpaint {model, prompt, image, mask, seed?} — the Transition / Decal tabs. The image
  // and mask arrive as PNG data URIs the client composed itself; they pass through to fal untouched and
  // never land on disk.
  '/api/fal-inpaint': falProxy(async (key, body) => {
    const { png, seed } = await generateFalInpaint(key, body as Parameters<typeof generateFalInpaint>[1]);
    return { bytes: png, type: 'image/png', seed };
  }),

  // POST /api/fal-panorama {prompt, image} — the Generate skybox dialog's Hunyuan World pass: a 2:1
  // base view in (as a data URI, straight through, never on disk), a wrapping panorama out.
  '/api/fal-panorama': falProxy(async (key, body) => {
    const { png, seed } = await generateFalPanorama(key, body as Parameters<typeof generateFalPanorama>[1]);
    return { bytes: png, type: 'image/png', seed };
  }),

  // POST /api/fal-3d {model, prompt, image} — the Prop Library's Generate prop dialog (docs/032):
  // a concept image in, a textured GLB out, through fal's queue (these models run for minutes).
  '/api/fal-3d': falProxy(async (key, body) => {
    const { glb, seed } = await generateFal3dMesh(key, body as Parameters<typeof generateFal3dMesh>[1]);
    return { bytes: glb, type: 'model/gltf-binary', seed };
  }),

  '/api/particle-texture': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const name = q.get('name') ?? 'fog0.png', level = q.get('level') ?? '';
      await responseCache.bytes(req, res, `particle-texture:${level}:${name}`, 'image/png',
        REFERENCE_ASSET_CACHE_CONTROL, () => readParticleTextureBytes(name, level));
    } catch (e) {
      res.statusCode = 404;
      res.end(String(e instanceof Error ? e.message : e));
    }
  },
};
