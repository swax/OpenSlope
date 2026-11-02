import { preflightFor } from '../routes/preflight';
import { readJsonBody, RequestBodyTooLargeError, type ApiHandler } from './common';

/** POST /api/preflight {doc} -> summarise what the doc ships: its tiles, cells, imported models and sky
 *  (docs/011).
 *
 *  There is no export route. The editor composes and downloads the map ZIP in the browser. The server
 *  supplies asset bytes through the ordinary library routes. This summary remains available to tooling. */
export const exportRoutes: Record<string, ApiHandler> = {
  '/api/preflight': async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('POST only');
      return;
    }
    try {
      const body = (await readJsonBody(req)) as { doc?: unknown };
      const doc = body.doc as Parameters<typeof preflightFor>[0] | undefined;
      // Said once, plainly: everything below reads a mountain's surface, and a body that carries none fails
      // deep inside the classifier with a message about an undefined length.
      if (!doc?.vertices || !doc.quads) {
        throw new Error('Send { doc: … } — a whole mountain document, as GET /api/projects/{id} answers with.');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(await preflightFor(doc)));
    } catch (e) {
      // A document the summariser cannot read is a bad request, not a fault of this server's — and a stack
      // is not an answer to give a caller: it names absolute paths on the machine the server runs on.
      res.statusCode = e instanceof RequestBodyTooLargeError ? 413 : 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
  },
};
