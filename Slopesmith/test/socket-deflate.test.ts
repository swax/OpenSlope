// tier: fast

import type { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { constants as zlib, deflateRawSync, inflateRawSync } from 'node:zlib';
import { acceptsDeflate, acceptWebSocket, prepareWebSocketText, type WebSocketPeer } from '../src/server/session/socket';
import { check, failures } from './check';

/**
 * `permessage-deflate` on the session channel (RFC 7692), spoken over an in-memory socket so every byte both
 * directions carry can be read back.
 *
 * The server accepts compression in its stateless shape — no context takeover either way — so what has to
 * hold is: it is negotiated only from an offer it can satisfy; a large message to a peer that negotiated it is
 * compressed and inflates back exactly, while a small one and every message to a peer that did not stay plain;
 * a compressed message from the client inflates on its own, whole or fragmented; and the RFC's rules about the
 * compressed bit, plus the size cap an uncompressed message already meets, close the connection when broken.
 */

/** A socket whose writes are kept and whose reads are whatever the test pushes. */
class MemorySocket extends Duplex {
  written: Buffer[] = [];
  _read(): void { /* frames arrive through push() */ }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    done();
  }
}

interface Frame { fin: boolean; rsv1: boolean; opcode: number; payload: Buffer }

/** The server's frames after the handshake, parsed. Server frames are never masked. */
function serverFrames(socket: MemorySocket): { handshake: string; frames: Frame[] } {
  const [head, ...rest] = socket.written;
  let bytes = Buffer.concat(rest);
  const frames: Frame[] = [];
  while (bytes.length >= 2) {
    let length = bytes[1] & 0x7f, at = 2;
    if (length === 126) { length = bytes.readUInt16BE(2); at = 4; }
    else if (length === 127) { length = Number(bytes.readBigUInt64BE(2)); at = 10; }
    frames.push({
      fin: (bytes[0] & 0x80) !== 0, rsv1: (bytes[0] & 0x40) !== 0, opcode: bytes[0] & 0x0f,
      payload: bytes.subarray(at, at + length),
    });
    bytes = bytes.subarray(at + length);
  }
  return { handshake: head.toString('latin1'), frames };
}

/** One client frame: always masked, as a browser's are. */
function clientFrame(opcode: number, payload: Buffer, options: { fin?: boolean; rsv1?: boolean } = {}): Buffer {
  const { fin = true, rsv1 = false } = options;
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
  if (length < 126) header[1] = 0x80 | length;
  else if (length < 65536) { header[1] = 0x80 | 126; header.writeUInt16BE(length, 2); }
  else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2); }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index & 3];
  return Buffer.concat([header, mask, masked]);
}

/** A message compressed the way a client without context takeover sends it. */
function clientDeflate(text: string): Buffer {
  const out = deflateRawSync(Buffer.from(text), { finishFlush: zlib.Z_SYNC_FLUSH });
  return out.subarray(0, out.length - 4);
}

const inflate = (payload: Buffer): string =>
  inflateRawSync(Buffer.concat([payload, Buffer.from([0, 0, 0xff, 0xff])]), { finishFlush: zlib.Z_SYNC_FLUSH })
    .toString('utf8');

function open(extensions?: string): { socket: MemorySocket; peer: WebSocketPeer; received: string[] } {
  const socket = new MemorySocket();
  const request = {
    headers: {
      'sec-websocket-key': Buffer.alloc(16, 3).toString('base64'),
      'sec-websocket-version': '13',
      ...(extensions === undefined ? {} : { 'sec-websocket-extensions': extensions }),
    },
  } as unknown as IncomingMessage;
  const peer = acceptWebSocket(request, socket, Buffer.alloc(0));
  if (!peer) throw new Error('handshake refused');
  const received: string[] = [];
  peer.onMessage(text => received.push(text));
  return { socket, peer, received };
}

/** The close code of the last frame written, or null when the server sent no close. */
function closeCode(socket: MemorySocket): number | null {
  const close = serverFrames(socket).frames.filter(frame => frame.opcode === 0x8).at(-1);
  return close ? close.payload.readUInt16BE(0) : null;
}

const settle = () => new Promise<void>(done => setImmediate(done));
const large = JSON.stringify({ t: 'awareness-batch', peers: Array.from({ length: 40 }, (_, at) => ({ at, name: 'rider' })) });

// ---- negotiation ----
check(acceptsDeflate('permessage-deflate; client_max_window_bits'), 'a Chromium offer is accepted');
check(acceptsDeflate('permessage-deflate'), 'a bare offer is accepted');
check(acceptsDeflate('permessage-deflate; client_max_window_bits=10; server_no_context_takeover'),
  'an offer limiting only the client’s window, or asking for no server context, is accepted');
check(!acceptsDeflate('permessage-deflate; server_max_window_bits=10'),
  'an offer limiting the server’s window is declined');
check(acceptsDeflate('permessage-deflate; server_max_window_bits=10, permessage-deflate'),
  'a later acceptable offer is taken when an earlier one is declined');
check(!acceptsDeflate('permessage-deflate; client_no_context_takeover; client_no_context_takeover'),
  'a duplicated parameter declines its offer');
check(!acceptsDeflate('permessage-deflate; client_max_window_bits=99') && !acceptsDeflate('x-webkit-deflate-frame')
  && !acceptsDeflate(undefined), 'nonsense, other extensions and no header at all accept nothing');

{
  const { socket, peer } = open('permessage-deflate; client_max_window_bits');
  check(peer.compressing && /sec-websocket-extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n/
    .test(serverFrames(socket).handshake), 'the handshake answers with stateless compression in both directions');
}
{
  const { socket, peer } = open();
  check(!peer.compressing && !/sec-websocket-extensions/i.test(serverFrames(socket).handshake),
    'a client that offered nothing is answered with no extension');
}

// ---- what the server sends ----
{
  const { socket, peer } = open('permessage-deflate');
  peer.send(large);
  peer.send('{"t":"pong"}');
  await settle();
  const [big, small] = serverFrames(socket).frames;
  check(big.rsv1 && big.payload.length < Buffer.byteLength(large) && inflate(big.payload) === large,
    'a large message is compressed and inflates back exactly',
    `${Buffer.byteLength(large)} → ${big.payload.length} bytes`);
  check(!small.rsv1 && small.payload.toString() === '{"t":"pong"}', 'a small message stays plain');
}
{
  const { socket, peer } = open();
  peer.send(large);
  await settle();
  const [frame] = serverFrames(socket).frames;
  check(!frame.rsv1 && frame.payload.toString() === large, 'a peer without compression is sent plain text');
}
{
  const prepared = prepareWebSocketText(large);
  check(prepared.deflated === prepared.deflated && prepared.plain === prepared.plain
    && prepared.deflated !== prepared.plain, 'a prepared broadcast builds each form once and shares it');
  const compressed = open('permessage-deflate'), plain = open();
  compressed.peer.sendPrepared(prepared);
  plain.peer.sendPrepared(prepared);
  await settle();
  check(serverFrames(compressed.socket).frames[0].rsv1 && !serverFrames(plain.socket).frames[0].rsv1,
    'one prepared broadcast reaches each peer in the form it negotiated');
}

// ---- what the client sends ----
{
  const { socket, received } = open('permessage-deflate');
  socket.push(clientFrame(0x1, clientDeflate(large), { rsv1: true }));
  socket.push(clientFrame(0x1, Buffer.from('plain still works')));
  await settle();
  check(received[0] === large && received[1] === 'plain still works',
    'a compressed client message is inflated, and an uncompressed one beside it is read as it is');

  const packed = clientDeflate(large);
  const cut = Math.floor(packed.length / 2);
  socket.push(clientFrame(0x1, packed.subarray(0, cut), { fin: false, rsv1: true }));
  socket.push(clientFrame(0x0, packed.subarray(cut)));
  await settle();
  check(received[2] === large, 'a compressed message split across a continuation is inflated whole');
  check(closeCode(socket) === null, 'and none of it closed the connection');
}
{
  const { socket, received } = open();
  socket.push(clientFrame(0x1, clientDeflate(large), { rsv1: true }));
  await settle();
  check(!received.length && closeCode(socket) === 1002, 'the compressed bit without negotiation is a protocol error');
}
{
  const { socket } = open('permessage-deflate');
  const packed = clientDeflate(large);
  socket.push(clientFrame(0x1, packed.subarray(0, 4), { fin: false, rsv1: true }));
  socket.push(clientFrame(0x0, packed.subarray(4), { rsv1: true }));
  await settle();
  check(closeCode(socket) === 1002, 'the compressed bit on a continuation is a protocol error');
}
{
  const { socket } = open('permessage-deflate');
  socket.push(clientFrame(0x9, Buffer.from('ping'), { rsv1: true }));
  await settle();
  check(closeCode(socket) === 1002, 'the compressed bit on a control frame is a protocol error');
}
{
  const { socket, received } = open('permessage-deflate');
  const bomb = deflateRawSync(Buffer.alloc(17 * 1024 * 1024, 0x20), { finishFlush: zlib.Z_SYNC_FLUSH });
  socket.push(clientFrame(0x1, bomb.subarray(0, bomb.length - 4), { rsv1: true }));
  await settle();
  check(!received.length && closeCode(socket) === 1009,
    'a small message inflating past the size cap is refused like an oversized one', `${bomb.length} bytes on the wire`);
}
{
  const { socket, received } = open('permessage-deflate');
  socket.push(clientFrame(0x1, Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]), { rsv1: true }));
  await settle();
  check(!received.length && closeCode(socket) === 1007, 'a compressed payload that is not DEFLATE is refused');
}

if (failures) process.exitCode = 1;
