import type { RetopologyJobRequest } from '../../core/mesh/retopology/job-contract';
import {
  cancelRetopologyJob, createRetopologyJob, retopologyCapabilities,
  retopologyJobResult, retopologyJobStatus,
} from '../retopology/jobs';
import { jsonResponse, readJsonBody, type ApiHandler } from './common';

/** Native retopology is a long-running server capability. POST creates an immutable snapshot job, GET polls
 * its small status record, GET /result retrieves the completed document, and DELETE cancels queued/running work. */
export const retopologyRoutes: Record<string, ApiHandler> = {
  '/api/retopology': async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path ? path.split('/') : [];
    try {
      if (req.method === 'GET' && parts[0] === 'capabilities') {
        jsonResponse(res, 200, retopologyCapabilities());
        return;
      }
      if (req.method === 'POST' && parts[0] === 'jobs' && parts.length === 1) {
        const body = await readJsonBody(req, 64 * 1024 * 1024) as RetopologyJobRequest;
        if (!body || typeof body !== 'object' || !body.document) throw new Error('A mountain document is required');
        jsonResponse(res, 202, createRetopologyJob(body.document, body.options, body.selectedQuadIds));
        return;
      }
      if (parts[0] === 'jobs' && typeof parts[1] === 'string' && /^[0-9a-f-]{36}$/i.test(parts[1])) {
        const id = parts[1];
        if (req.method === 'GET' && parts.length === 2) {
          const status = retopologyJobStatus(id);
          if (!status) { jsonResponse(res, 404, { error: 'Retopology job not found or expired' }); return; }
          jsonResponse(res, 200, status);
          return;
        }
        if (req.method === 'GET' && parts[2] === 'result' && parts.length === 3) {
          const status = retopologyJobStatus(id);
          if (!status) { jsonResponse(res, 404, { error: 'Retopology job not found or expired' }); return; }
          if (status.phase !== 'complete') { jsonResponse(res, 409, { error: 'Retopology result is not ready', status }); return; }
          jsonResponse(res, 200, retopologyJobResult(id));
          return;
        }
        if (req.method === 'DELETE' && parts.length === 2) {
          const status = cancelRetopologyJob(id);
          if (!status) { jsonResponse(res, 404, { error: 'Retopology job not found or expired' }); return; }
          jsonResponse(res, 200, status);
          return;
        }
      }
      res.statusCode = 404;
      res.end('Retopology route not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jsonResponse(res, message.includes('not installed') ? 503 : message.includes('worker is busy') ? 429 : 400,
        { error: message });
    }
  },
};
