// tier: fast

import type { IncomingMessage } from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import { readBody, RequestBodyTooLargeError } from '../src/server/api/common';
import { awarenessPolicyFor } from '../src/server/session/awareness-policy';
import { acceptWebSocket, prepareWebSocketText } from '../src/server/session/socket';
import { check, failures } from './check';

class SlowSocket extends Duplex {
  _read(): void { /* this peer sends nothing */ }
  _write(_chunk: Buffer, _encoding: BufferEncoding, _done: (error?: Error | null) => void): void {
    // Deliberately never acknowledge a write: Writable's queue becomes the slow client's retained backlog.
  }
}

const request = {
  headers: {
    'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
    'sec-websocket-version': '13',
  },
} as IncomingMessage;

const socket = new SlowSocket();
const peer = acceptWebSocket(request, socket, Buffer.alloc(0));
if (!peer) throw new Error('test WebSocket handshake was refused');
const awareness = prepareWebSocketText(JSON.stringify({ t: 'aware', payload: 'x'.repeat(1024 * 1024) }));
peer.sendPrepared(awareness, { coalesceKey: 'aware:one' });
for (let index = 0; index < 20; index++) peer.sendPrepared(awareness, { coalesceKey: 'aware:one' });
check(!peer.closed, 'repeated absolute state for one slow peer is coalesced instead of accumulating');
for (let index = 0; index < 20 && !peer.closed; index++) {
  peer.sendPrepared(awareness, { coalesceKey: `aware:${index + 2}` });
}
check(peer.closed, 'a slow peer retaining too many distinct updates is disconnected at the queue cap');

const exact = new PassThrough();
const exactRead = readBody(exact as unknown as IncomingMessage, 4);
exact.end(Buffer.from('1234'));
check((await exactRead).toString() === '1234', 'an HTTP body at the configured limit is accepted');

const oversized = new PassThrough();
const oversizedRead = readBody(oversized as unknown as IncomingMessage, 4);
oversized.end(Buffer.from('12345'));
let refused = false;
try { await oversizedRead; }
catch (error) { refused = error instanceof RequestBodyTooLargeError && error.statusCode === 413; }
check(refused, 'an HTTP body over the configured limit is refused as 413');

const smallPolicy = awarenessPolicyFor(25);
const mediumPolicy = awarenessPolicyFor(26);
const busyPolicy = awarenessPolicyFor(51);
const largePolicy = awarenessPolicyFor(76);
check(smallPolicy.flushMs === 30 && smallPolicy.publishMs === 80
  && mediumPolicy.flushMs === 80 && mediumPolicy.publishMs === 80
  && busyPolicy.flushMs === 125 && busyPolicy.publishMs === 125
  && largePolicy.flushMs === 200 && largePolicy.publishMs === 200,
'awareness batching slows at the configured room-size boundaries');
check(awarenessPolicyFor(74, largePolicy) === largePolicy
  && awarenessPolicyFor(72, largePolicy) === busyPolicy,
'awareness pacing uses departure hysteresis instead of bouncing at a room-size boundary');

if (failures) process.exitCode = 1;
else console.log('TRANSPORT GUARDS PASS');
