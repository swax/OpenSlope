import { REFERENCE_CHUNK_BYTES } from '../../shared/reference-transfer';
import {
  beginReferenceUpload,
  cancelReferenceUpload,
  finishReferenceUpload,
  referenceUploadStatus,
  removeServerReference,
  serverReferences,
  writeReferenceChunk,
} from '../reference-maps';
import type { ApiRequest } from './request';
import { jsonResponse, readBody, readJsonBody, type ApiHandler } from './common';

/** The entire mount is admin-only in app.ts, including upload status and cancellation. */
export const referenceMapRoutes: Record<string, ApiHandler> = {
  '/api/reference-maps': async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const identity = (req as ApiRequest).identity;
    if (!identity || !('user' in identity)) {
      jsonResponse(res, 403, { error: 'Admin sign-in required.' });
      return;
    }
    const actor = identity.user.id;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/' && req.method === 'GET') {
        jsonResponse(res, 200, { maps: await serverReferences() });
        return;
      }
      if (path === '/uploads' && req.method === 'POST') {
        const abort = new AbortController();
        const disconnected = () => {
          if (!res.writableEnded) abort.abort();
        };
        res.once('close', disconnected);
        try {
          const plan = await beginReferenceUpload(actor, await readJsonBody(req, 8 * 1024 ** 2), abort.signal);
          if (res.destroyed) await cancelReferenceUpload(plan.id, actor);
          else jsonResponse(res, 201, plan);
        } finally {
          res.off('close', disconnected);
        }
        return;
      }
      const upload = /^\/uploads\/([a-f0-9-]{36})(\/complete)?$/.exec(path);
      if (upload) {
        if (upload[2] && req.method === 'POST') {
          jsonResponse(res, 201, await finishReferenceUpload(upload[1], actor));
          return;
        }
        if (!upload[2] && req.method === 'GET') {
          jsonResponse(res, 200, await referenceUploadStatus(upload[1], actor));
          return;
        }
        if (!upload[2] && req.method === 'PUT') {
          const offset = url.searchParams.get('offset');
          jsonResponse(
            res,
            200,
            await writeReferenceChunk(
              upload[1],
              actor,
              offset && /^\d+$/.test(offset) ? Number(offset) : NaN,
              await readBody(req, REFERENCE_CHUNK_BYTES),
            ),
          );
          return;
        }
        if (!upload[2] && req.method === 'DELETE') {
          await cancelReferenceUpload(upload[1], actor);
          jsonResponse(res, 200, {});
          return;
        }
      }
      const map = /^\/maps\/([^/]+)$/.exec(path);
      if (map && req.method === 'DELETE') {
        await removeServerReference(decodeURIComponent(map[1]));
        jsonResponse(res, 200, {});
        return;
      }
      jsonResponse(res, 405, { error: 'Unsupported reference-map operation.' });
    } catch (error) {
      if (res.destroyed) return;
      const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 400;
      jsonResponse(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  },
};
