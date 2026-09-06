import { readLevelGroups } from '../routes/groups';
import {
  cloneImportedProp, deleteImportedProp, importedPropsPayload, renameImportedProp, replaceImportedProp,
  saveImportedProp, updateImportedPropMaterials,
} from '../routes/imported-props';
import {
  levelsWithProps, nativeArtSource, readLevelProps, readLevelPropsJsonWithCacheInfo, readMaterialTables,
  readPhysicsBodySpheres,
} from '../routes/props';
import { adoptRecordArt } from '../props/adopt-art';
import { responseCache } from '../response-cache';
import { invalidateProjectLibrary, readJsonBody, RequestBodyTooLargeError, type ApiHandler } from './common';
import { projectAssetCacheKey } from '../project-assets';

const PROP_IMPORT_LIMIT = 96 * 1024 * 1024;

/** Managing a stored model shares one shape with managing a stored tile: the arguments ride in the query
 *  string, a replacement record rides in the body, and a success invalidates the Custom library so every
 *  connected editor refetches the catalogue. Refusals are 400 with an `{error}` the client shows verbatim. */
const manageProp = (run: (id: number, q: URLSearchParams, body: () => Promise<unknown>) => Promise<Record<string, unknown>>):
  ApiHandler => async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
    res.setHeader('content-type', 'application/json');
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const id = Number(q.get('id'));
      if (!Number.isInteger(id) || id < 0) throw new Error('which model? (no id)');
      const result = await run(id, q, () => readJsonBody(req, PROP_IMPORT_LIMIT));
      invalidateProjectLibrary();
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 400;
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  };

/** One model as the index names it: what to place, what it costs, and what it wears. */
interface PropIndexModel { id: number; name: string; tris: number; pages: string[] }

/**
 * A level's models without their geometry — the read that answers "what can I place from GARI?" (docs/052).
 *
 * The whole payload is megabytes because it carries every vertex; an agent choosing models by name needs the
 * names, the triangle budget and which tiles a model wears, and nothing else. Derived from the same bake the
 * payload itself is served from, so the two can never name different models, and `tris` comes off the packed
 * index buffer's base64 LENGTH — three Uint32 corners to a triangle — rather than by decoding it.
 */
async function levelPropIndex(level: string): Promise<{ level: string; models: PropIndexModel[] }> {
  const payload = await readLevelProps(level);
  const pages = new Map(payload.materials.map(material => [material.id, material.tex]));
  return {
    level: payload.level,
    models: payload.models.map(model => ({
      id: model.id,
      name: model.name,
      tris: model.subs.reduce((total, sub) => total + Buffer.byteLength(sub.idx, 'base64') / 12, 0),
      pages: [...new Set(model.subs.flatMap(sub => pages.get(sub.mat) || []))],
    })),
  };
}

/** GET /api/props -> {levels:[...]} (levels that carry prop tables), GET /api/props?level=<LEVEL> ->
 *  PropsPayload (the level's placed prop models + instances, geometry base64-packed). Feeds the reference
 *  layer's props view (show an extracted level's trees / boulders / banners on its terrain).
 *
 *  Three sub-paths answer what a payload is too big to be asked for: GET /api/props/index?level=<LEVEL> ->
 *  {level, models:[{id, name, tris, pages}]}, the slim catalogue an API caller chooses a model from. The other
 *  two serve the browser's export the answers a bake cannot read off a payload: GET /api/props/materials ->
 *  {tables} every source level's whole Materials[] keyed by sanitised level name, which is what a `usemtl`
 *  slot and an authored model's tile resolve through; GET /api/props/native-art -> which extracted level
 *  supplies the rail skin and gem crystals. */
export const propRoutes: Record<string, ApiHandler> = {
  '/api/props': async (req, res) => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (url.pathname === '/materials') {
        await responseCache.json(req, res, 'prop-materials',
          async () => ({ tables: Object.fromEntries(await readMaterialTables()) }));
        return;
      }
      if (url.pathname === '/native-art') {
        await responseCache.json(req, res, 'prop-native-art', () => nativeArtSource());
        return;
      }
      if (url.pathname === '/index') {
        const level = url.searchParams.get('level') ?? '';
        await responseCache.json(req, res, `prop-index:${level}`, () => levelPropIndex(level));
        return;
      }
      const level = url.searchParams.get('level');
      if (!level) {
        await responseCache.json(req, res, 'prop-levels', async () => ({ levels: await levelsWithProps() }));
      } else {
        await responseCache.jsonBytes(req, res, `props:${level}`, async () => {
          const generated = await readLevelPropsJsonWithCacheInfo(level);
          res.setHeader('x-slopesmith-persistent-cache', generated.cache);
          return generated.json;
        });
      }
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // Imported GLB props (the open mountain's assets/props, docs/032): GET /api/custom-props -> the '@import'
  // pseudo-level as an ordinary PropsPayload, so the client decodes it with decodeProps like any level.
  // POST /api/custom-prop-import?name=<stem> with the converted record as JSON -> store it under a record
  // file that is free (`<stem>_2.json` and up when the stem was taken — docs/038) and answer with the model
  // number placements persist. The glTF parsing itself is CLIENT-side: GLTFLoader already runs in the
  // browser (it drives the Play rider models), so the server needs no glTF parser at all.
  '/api/custom-props': async (req, res) => {
    try {
      // json() serves private/no-cache (ETag-revalidated) and an import clears the cache, so a newly
      // imported record appears without a reload
      await responseCache.json(req, res, projectAssetCacheKey('custom-props'), () => importedPropsPayload());
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // `?adopt=1` additionally brings the record's ART into this mountain: every ref naming an extracted
  // level's bank is copied into Custom and repointed (docs/032). That is what ⧉ revise prop sends, because a
  // copy whose paint is still the reference's is a copy the author cannot retexture, replace art on, or
  // generate over. It is opt-in rather than automatic because the GLB import path stages its own art and
  // would only pay for a pass that finds nothing.
  '/api/custom-prop-import': async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const record = await readJsonBody(req, PROP_IMPORT_LIMIT) as Parameters<typeof saveImportedProp>[1];
      const art = q.get('adopt') ? await adoptRecordArt(record) : null;
      const { record: saved } = await saveImportedProp(q.get('name') ?? 'prop', record);
      invalidateProjectLibrary();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: saved.id, name: saved.name, ...(art ?? {}) }));
    } catch (e) {
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // Managing what the ＋ tile put there (docs/032): POST /api/custom-prop-rename?id=&to=,
  // /api/custom-prop-clone?id=&to=, /api/custom-prop-replace?id= with a converted record as the body, and
  // /api/custom-prop-delete?id=. Rename and replace keep the model NUMBER, so placements follow them;
  // clone mints a new one and delete spends its number for good.
  '/api/custom-prop-rename': manageProp((id, q) => renameImportedProp(id, q.get('to') ?? '')),

  '/api/custom-prop-clone': manageProp((id, q) => cloneImportedProp(id, q.get('to') ?? '')),

  '/api/custom-prop-replace': manageProp(async (id, _q, body) =>
    replaceImportedProp(id, await body() as Parameters<typeof replaceImportedProp>[1])),

  // Retexturing an already-placed model, so it takes the narrow patch rather than the whole-record replace:
  // the body carries material rows only and can never arrive with a different mesh (docs/032).
  '/api/custom-prop-materials': manageProp(async (id, _q, body) =>
    updateImportedPropMaterials(id, await body())),

  '/api/custom-prop-delete': manageProp(async id => ({ deleted: await deleteImportedProp(id) })),

  // GET /api/physics-body?level=<LEVEL>&idx=<PhysicsIndex> -> {spheres: [[x,y,z,r],...] | null}: the
  // mode-3 body's decoded LEAF SPHERES (model-local raw cm) so the viewport can draw the engine's true
  // collision volume on select [Trailmap: 130-collision-data].
  '/api/physics-body': async (req, res) => {
    try {
      const q = new URL(req.url ?? '', 'http://localhost').searchParams;
      const level = q.get('level') ?? '', idx = Number(q.get('idx') ?? '-1');
      await responseCache.json(req, res, `physics-body:${level}:${idx}`,
        async () => ({ spheres: await readPhysicsBodySpheres(level, idx) }));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },

  // GET /api/groups?level=<LEVEL> -> the level's mined GROUP defs (co-placed model assemblies +
  // fixture lights — docs/015), for the Prop Library's Groups section and group placements.
  '/api/groups': async (req, res) => {
    try {
      const level = new URL(req.url ?? '', 'http://localhost').searchParams.get('level') ?? '';
      await responseCache.json(req, res, `groups:${level}`, () => readLevelGroups(level));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },
};
