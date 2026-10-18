import { issuePlayTicket, playConfig } from '../play';
import { jsonResponse, readJsonBody, type ApiHandler } from './common';
import type { ApiRequest } from './request';
import { validateTicketRequest } from '../../core/session/play-validators.generated.js';

export const playRoutes: Record<string, ApiHandler> = {
  '/api/play': async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
    try {
      if (path === '/config' && req.method === 'GET') {
        jsonResponse(res, 200, playConfig());
        return;
      }
      if (path === '/ticket' && req.method === 'POST') {
        const body = await readJsonBody(req, 12 * 1024);
        if (!validateTicketRequest(body)) {
          jsonResponse(res, 400, { error: 'Invalid play admission request.' });
          return;
        }
        jsonResponse(res, 200, await issuePlayTicket(req as ApiRequest, body, res));
        return;
      }
      jsonResponse(res, 404, { error: 'Unknown play route.' });
    } catch (error) {
      jsonResponse(res, 403, { error: error instanceof Error ? error.message : String(error) });
    }
  },
};
