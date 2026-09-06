import { jsonResponse, type ApiHandler } from './common';

export const restartRoutes: Record<string, ApiHandler> = {
  '/api/restart': (req, res, controls) => {
    if (req.method === 'GET') {
      jsonResponse(res, 200, controls?.restart
        ? { available: true, instance: controls.restart.instance }
        : {
            available: false,
            reason: 'This Slopesmith process is not managed by a restart-capable host.',
          });
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('GET or POST only');
      return;
    }
    if (!controls?.restart) {
      jsonResponse(res, 503, {
        error: 'This Slopesmith process is not managed by a restart-capable host.',
      });
      return;
    }
    if (!controls.restart.request()) {
      jsonResponse(res, 409, { error: 'A server restart is already in progress.' });
      return;
    }
    jsonResponse(res, 202, { restarting: true, instance: controls.restart.instance });
  },
};
