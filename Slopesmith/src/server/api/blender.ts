import { readPortalMesh, type PortalKind } from '../../core/blender/portal';
import {
  ackBlenderPush, applyImportedPush, applyTexturePushes, blenderCatalogue, blenderPortal, blenderPortalGlb,
  pendingBlenderPushes, queueModelPush, queueTextureRetarget, type BlenderPushResult,
} from '../routes/blender';
import { requestProjectSnapshot } from '../project-assets';
import { invalidateProjectLibrary, readJsonBody, RequestBodyTooLargeError, type ApiHandler } from './common';

/**
 * The Blender bridge's HTTP surface (docs/046).
 *
 * Everything here is one mount deep and takes `kind` + `id` in the query string, because the other end of it
 * is a Python addon written against `urllib` and nothing else — no client library, no content negotiation,
 * no multipart. A GET answers with the portal JSON the addon builds a Blender mesh from, or with a GLB for
 * whoever is not the addon; a POST hands one back.
 *
 * The routes are bound to the mountain the calling tab has open (`PROJECT_ASSET_MOUNTS` in `app.ts`), which
 * is also what a request carrying no tab id at all resolves to — so the addon, which has no session and no
 * client id, always answers about the map the author is looking at. That is the correct default for a
 * local-first tool and the reason the bridge needs no "which project?" field in its panel.
 */

/** A pushed mesh is mostly geometry — generous enough for a subdivided cage, far under the import route's own
 *  ceiling, and refused before `MAX_IMPORT_TRIS` is even counted. It has room for a slot's edited art beside
 *  it, which `MAX_PORTAL_TEX_BYTES` bounds per tile so a too-big texture is named as one. */
const PUSH_LIMIT = 64 * 1024 * 1024;

function requestedModel(url: string): { kind: PortalKind; id: number } {
  const q = new URL(url, 'http://localhost').searchParams;
  const kind = q.get('kind');
  if (kind !== 'model' && kind !== 'import') throw new Error('which library? (kind=model|import)');
  const id = Number(q.get('id'));
  if (!Number.isInteger(id) || id < 0) throw new Error('which model? (no id)');
  return { kind, id };
}

/** Refusals answer 400 with an `{error}` the addon shows verbatim in its status line, the same contract the
 *  prop-management routes hold with the Prop Library's toasts. */
const failed = (res: Parameters<ApiHandler>[1], error: unknown, status = 400): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
};

export const blenderRoutes: Record<string, ApiHandler> = {
  /**
   * GET  /api/blender                    -> the catalogue: everything Blender may pull from this mountain.
   * GET  /api/blender/mesh?kind=&id=     -> one model as portal JSON (quads for a cage).
   * GET  /api/blender/mesh.glb?kind=&id= -> the same model as a self-contained GLB, textures embedded.
   * GET  /api/blender/pending            -> authored-model push-backs the editor has not applied yet.
   * POST /api/blender/mesh               -> a portal mesh coming home, with any slot whose ART the artist
   *                                         changed carrying it. The body's STAMP says where it goes, so a
   *                                         push cannot be aimed at a model by editing a URL.
   * POST /api/blender/ack?token=         -> the editor applied one of the pending pushes.
   */
  '/api/blender': async (req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0].replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'POST') {
        if (path === '/ack') {
          const token = new URL(url, 'http://localhost').searchParams.get('token') ?? '';
          const cleared = await ackBlenderPush(token);
          // No library announcement: the editor already holds this change — it is the one that applied it.
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ cleared }));
          return;
        }
        if (path !== '/mesh') { res.statusCode = 404; res.end('no such bridge route'); return; }
        const snapshot = await requestProjectSnapshot(req);
        const mesh = readPortalMesh(await readJsonBody(req, PUSH_LIMIT));
        if (mesh.stamp.project !== snapshot.project.id) {
          throw new Error(`that model was pulled from a different mountain (${mesh.stamp.name})`
            + ` — open it in Slopesmith before pushing`);
        }
        // The art goes first, and the order is load-bearing: a replaced tile's ref MOVES, so the geometry
        // half has to be written against the refs that exist once it has (docs/046).
        const art = await applyTexturePushes(mesh);
        try {
          const result: BlenderPushResult = mesh.stamp.kind === 'import'
            ? await applyImportedPush(mesh, art.slotTex)
            // A cage has one slot, and the tile it wears is a document field — so it rides in with the cage
            // rather than as a second edit the author would have to undo separately.
            : await queueModelPush(mesh, art.slotTex.get(0));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            ...result,
            ...(art.written ? { textures: art.written } : {}),
            ...(art.forked ? { forkedTextures: art.forked } : {}),
          }));
        } finally {
          // Reached on the refusal path too, and deliberately. By here the art is on disk and its old ref is
          // gone, so a geometry half that throws — too many triangles, a mesh with no faces a cage can hold —
          // must not also leave every painted cell wearing that tile pointing at a file that no longer
          // exists. The push is refused; the move it already made is still reported.
          await queueTextureRetarget(art.moved);
          // Both kinds announce. An imported record IS the change, so the push tells every connected editor
          // to refetch it; an authored model's push is only WAITING, and the same signal is what wakes a tab
          // up to come and collect it (docs/046 — the inbox is drained off the custom-library event).
          invalidateProjectLibrary();
        }
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405; res.end('GET or POST'); return;
      }

      const snapshot = await requestProjectSnapshot(req);
      if (path === '/pending') {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ pushes: await pendingBlenderPushes() }));
        return;
      }
      if (path === '/mesh' || path === '/mesh.glb') {
        const { kind, id } = requestedModel(url);
        const mesh = await blenderPortal(snapshot.document, snapshot.project.id, kind, id);
        if (path === '/mesh') {
          res.setHeader('content-type', 'application/json');
          // A checked-out model is a snapshot of live authoring, so it is never cached — the whole point is
          // that a pull shows what the editor holds right now.
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(mesh));
          return;
        }
        const glb = await blenderPortalGlb(mesh);
        const file = `${(mesh.stamp.name || 'model').replace(/[^\w.-]+/g, '_')}.glb`;
        res.setHeader('content-type', 'model/gltf-binary');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-disposition', `attachment; filename="${file}"`);
        res.end(Buffer.from(glb));
        return;
      }
      if (path !== '/') { res.statusCode = 404; res.end('no such bridge route'); return; }

      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(await blenderCatalogue(
        { id: snapshot.project.id, name: snapshot.project.name }, snapshot.document)));
    } catch (error) {
      failed(res, error, error instanceof RequestBodyTooLargeError ? 413 : 400);
    }
  },
};
