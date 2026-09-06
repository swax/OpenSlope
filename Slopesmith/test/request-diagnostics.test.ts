// tier: fast

import {
  beginDiagnosticPhase,
  clearDiagnostics,
  diagnosticsSnapshot,
  runDiagnosticPhase,
  runDiagnosticPhaseAsync,
} from '../src/app/net/diagnostics';
import { fetchJson } from '../src/app/net/fetch-json';
import { check, failures } from './check';

clearDiagnostics();
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ value: 42 }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': '12',
      'x-slopesmith-request-id': 'api-00042',
      'x-slopesmith-cache': 'hit',
      'x-slopesmith-persistent-cache': 'hit',
    },
  });
  const body = await fetchJson<{ value: number }>('/api/test?level=DIAGNOSTIC');
  const request = diagnosticsSnapshot().requests.at(-1);
  check(body.value === 42 && request?.status === 'ok' && request.httpStatus === 200,
    'fetchJson records a completed diagnostic without changing its decoded result');
  check(request?.serverId === 'api-00042' && request.cache === 'hit' && request.bytes === 12,
    'browser request record retains the server correlation id, cache state, and response size');
  check(request?.persistentCache === 'hit', 'browser request record retains the persistent source-cache state');
  check(typeof request?.headersMs === 'number' && typeof request.bodyMs === 'number'
    && typeof request.totalMs === 'number',
  'request diagnostic separates headers, body/decode, and total timing');

  runDiagnosticPhase('props', 'TEST:decode', () => ({ models: 2 }));
  await runDiagnosticPhaseAsync('props', 'TEST:scene-build', async () => Promise.resolve());
  const manual = beginDiagnosticPhase('effects', 'TEST:failure');
  manual.fail(new Error('expected diagnostic failure'));
  const phases = diagnosticsSnapshot().phases;
  check(phases.some(entry => entry.name === 'TEST:decode' && entry.status === 'ok')
    && phases.some(entry => entry.name === 'TEST:scene-build' && entry.status === 'ok'),
  'synchronous and progressive client phases record successful completion');
  check(phases.some(entry => entry.name === 'TEST:failure' && entry.status === 'error'
    && entry.error === 'expected diagnostic failure'),
  'failed client phases retain their actionable error');
} finally {
  globalThis.fetch = originalFetch;
}

if (failures) {
  console.error(`REQUEST DIAGNOSTICS FAIL (${failures})`);
  process.exitCode = 1;
} else {
  console.log('REQUEST DIAGNOSTICS PASS');
}
