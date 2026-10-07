// tier: fast
/**
 * Retopology is opt-in per server (SLOPESMITH_RETOPOLOGY=1). Off, capabilities still answers — saying so, which is
 * what hides the editor's tool — and every job route refuses before it reads a body, so nothing reaching the API
 * can start, read or cancel a solve. On, the same requests reach the job handlers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { retopologyRoutes } from '../src/server/api/retopology';
import { check, failures } from './check';

/** Call the route the way app.ts does: the `/api/retopology` mount is stripped, leaving the rest of the path. */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = {};
  let status = 0;
  let text = '';
  const res = {
    statusCode: 200,
    setHeader() { /* the fake response keeps only what the assertions read */ },
    end(chunk?: string) { status = res.statusCode; text = chunk ?? ''; },
  };
  await retopologyRoutes['/api/retopology'](req, res as unknown as ServerResponse);
  return { status, json: text.startsWith('{') ? JSON.parse(text) : text };
}

const JOB = '/jobs/00000000-0000-4000-8000-000000000000';
const previous = process.env.SLOPESMITH_RETOPOLOGY;
try {
  delete process.env.SLOPESMITH_RETOPOLOGY;
  const off = await call('GET', '/capabilities');
  check(off.status === 200 && off.json.enabled === false, 'capabilities answers, reporting retopology off by default',
    JSON.stringify(off.json.enabled));
  for (const [method, path, body] of [['POST', '/jobs', { document: {} }], ['GET', JOB], ['GET', `${JOB}/result`],
    ['DELETE', JOB]] as const) {
    const refused = await call(method, path, body);
    check(refused.status === 404 && /SLOPESMITH_RETOPOLOGY=1/.test(refused.json.error ?? ''),
      `${method} ${path} refuses while retopology is off`, `${refused.status}`);
  }

  process.env.SLOPESMITH_RETOPOLOGY = '0';
  check((await call('GET', '/capabilities')).json.enabled === false, 'only "1" turns it on');

  process.env.SLOPESMITH_RETOPOLOGY = '1';
  check((await call('GET', '/capabilities')).json.enabled === true, 'SLOPESMITH_RETOPOLOGY=1 reports it on');
  // A request with no mountain is rejected on its merits, which shows the job handler was reached rather than the gate.
  const reached = await call('POST', '/jobs', {});
  check(reached.status === 400 && /mountain document/.test(reached.json.error ?? ''),
    'switched on, a job request reaches the job handler', `${reached.status} ${reached.json.error}`);
  const unknown = await call('GET', JOB);
  check(unknown.status === 404 && /not found/.test(unknown.json.error ?? ''), 'switched on, job lookups reach the job store');
} finally {
  if (previous === undefined) delete process.env.SLOPESMITH_RETOPOLOGY;
  else process.env.SLOPESMITH_RETOPOLOGY = previous;
}

if (failures) process.exitCode = 1;
else console.log('RETOPOLOGY FLAG PASS');
