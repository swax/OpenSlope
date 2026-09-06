import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * The WebSocket half of the session channel (docs/038), spoken directly over the upgraded socket.
 *
 * RFC 6455 is a framing layer, not a protocol stack: a 20-byte handshake, a length-prefixed frame header and
 * a mask to undo. That is small enough to own, and owning it keeps the service free of a dependency whose
 * whole job is bytes this file already has in hand — the same reasoning that keeps the PNG and WAV codecs in
 * this tree. What the channel above needs is `send(text)`, a message callback and a close callback, so that
 * is the entire surface.
 *
 * Everything below is deliberately strict about what a client may send: a frame that is not masked, a
 * reserved opcode, or a message over the cap closes the connection rather than being interpreted generously.
 * A browser never sends any of them, so a peer that does is either broken or probing.
 */

/** The constant RFC 6455 appends to the client's key before digesting it. Its only job is to prove the server
 *  understood the handshake rather than echoing bytes back. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** What one message may weigh. A pushed revision carries a whole mountain, which is the largest thing this
 *  channel moves, so the cap sits above the largest document rather than above the smallest control frame. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Bytes one slow peer may leave queued after the kernel stops accepting writes. One unusually large
 * topology frame is allowed into an empty queue; nothing is allowed to pile up behind it. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export interface WebSocketPeer {
  /** Send one text message. Silently does nothing once the peer is closed, so callers broadcasting to a list
   *  never have to check first. */
  send(text: string, options?: WebSocketSendOptions): void;
  /** Send a frame prepared once for a fleet-wide broadcast. Buffers are immutable after preparation and may
   * be shared across sockets. */
  sendPrepared(frame: Buffer, options?: WebSocketSendOptions): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

export interface WebSocketSendOptions {
  /** A newer frame under this key supersedes an older one while the peer is backpressured. Only absolute,
   * ephemeral state such as one participant's awareness belongs here. */
  coalesceKey?: string;
}

/** Whether a request is asking to become a WebSocket, as opposed to any other upgrade. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade;
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

/** The `Sec-WebSocket-Accept` value for a client's key. */
const acceptKey = (key: string): string =>
  createHash('sha1').update(key + WS_GUID).digest('base64');

/** Refuse an upgrade before it becomes a socket, in the plain HTTP the client is still speaking. */
export function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'}\r\n`
    + 'connection: close\r\ncontent-type: application/json\r\n'
    + `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** One outgoing frame. Server frames are never masked, which is the whole of the server's side of masking. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode; // FIN, because nothing here fragments what it sends
  if (length < 126) header[1] = length;
  else if (length < 65536) { header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([header, payload]);
}

/** Encode fleet-wide text once instead of allocating and concatenating an identical frame per recipient. */
export const prepareWebSocketText = (text: string): Buffer => frame(OPCODE.text, Buffer.from(text, 'utf8'));

/**
 * Complete the handshake and hand back the peer.
 *
 * The caller has already decided the request may connect — this only speaks the protocol. A missing or
 * malformed key is refused here rather than upstream, because it is a fact about the framing rather than
 * about who is asking.
 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WebSocketPeer | null {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (typeof key !== 'string' || !key || String(version) !== '13') {
    refuseUpgrade(socket, 400, 'This endpoint speaks WebSocket version 13.');
    return null;
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n'
    + `sec-websocket-accept: ${acceptKey(key)}\r\n\r\n`);
  // Presence and lease frames are tiny and latency is the whole point of a channel, so they go out rather
  // than waiting for a full segment.
  (socket as { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);

  const messageListeners: Array<(text: string) => void> = [];
  const closeListeners: Array<() => void> = [];
  let closed = false;
  let pending: Buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  /** An interrupted message: the opcode it started with and the fragments seen so far. */
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let fragmentBytes = 0;
  let backpressured = false;
  const coalesced = new Map<string, Buffer>();
  let coalescedBytes = 0;

  function finish(): void {
    if (closed) return;
    closed = true;
    coalesced.clear();
    coalescedBytes = 0;
    socket.destroy();
    for (const listener of closeListeners) listener();
  }

  function fail(code: number, why: string): void {
    if (closed) return;
    const reason = Buffer.from(why.slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + reason.length);
    payload.writeUInt16BE(code, 0);
    reason.copy(payload, 2);
    try { socket.write(frame(OPCODE.close, payload)); } catch { /* the socket is going either way */ }
    finish();
  }

  function deliver(opcode: number, payload: Buffer): void {
    if (opcode === OPCODE.text) {
      const text = payload.toString('utf8');
      for (const listener of messageListeners) listener(text);
    }
    // A binary message is not something this channel speaks; it is dropped rather than guessed at.
  }

  function sendFrame(prepared: Buffer, options: WebSocketSendOptions = {}): void {
    if (closed) return;
    const key = options.coalesceKey;
    if (backpressured && key) {
      const prior = coalesced.get(key);
      coalescedBytes += prepared.length - (prior?.length ?? 0);
      coalesced.set(key, prepared);
      if (socket.writableLength + coalescedBytes > MAX_BUFFERED_BYTES) fail(1013, 'client is not keeping up');
      return;
    }
    // One large authoritative frame may stand by itself. Once anything is queued, the cap is absolute: a
    // slow client is disconnected instead of retaining everybody else's edits without bound.
    if (socket.writableLength > 0 && socket.writableLength + coalescedBytes + prepared.length > MAX_BUFFERED_BYTES) {
      fail(1013, 'client is not keeping up');
      return;
    }
    try { backpressured = !socket.write(prepared); } catch { finish(); }
  }

  function flushCoalesced(): void {
    if (closed) return;
    backpressured = false;
    for (const [key, prepared] of coalesced) {
      coalesced.delete(key);
      coalescedBytes -= prepared.length;
      sendFrame(prepared);
      if (closed || backpressured) return;
    }
  }

  /** Parse whatever whole frames `pending` now holds. Anything short is left for the next chunk. */
  function consume(): void {
    for (;;) {
      if (closed || pending.length < 2) return;
      const first = pending[0];
      const second = pending[1];
      if (first & 0x70) { fail(1002, 'reserved bits are set'); return; }
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let at = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        const wide = pending.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MESSAGE_BYTES)) { fail(1009, 'message too large'); return; }
        length = Number(wide);
        at = 10;
      }
      // Every frame from a client is masked. An unmasked one is a peer that is not a browser.
      if (!masked) { fail(1002, 'client frames must be masked'); return; }
      if (length > MAX_MESSAGE_BYTES) { fail(1009, 'message too large'); return; }
      if (pending.length < at + 4 + length) return;
      const mask = pending.subarray(at, at + 4);
      const payload = Buffer.from(pending.subarray(at + 4, at + 4 + length));
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
      pending = pending.subarray(at + 4 + length);

      if (opcode === OPCODE.close) { fail(1000, 'closing'); return; }
      if (opcode === OPCODE.ping) { try { socket.write(frame(OPCODE.pong, payload)); } catch { finish(); } continue; }
      if (opcode === OPCODE.pong) continue;

      if (opcode === OPCODE.continuation) {
        if (!fragmentOpcode) { fail(1002, 'continuation without a start frame'); return; }
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_MESSAGE_BYTES) { fail(1009, 'message too large'); return; }
        fragments.push(payload);
        if (!fin) continue;
        const whole = Buffer.concat(fragments);
        const started = fragmentOpcode;
        fragments = []; fragmentOpcode = 0; fragmentBytes = 0;
        deliver(started, whole);
        continue;
      }
      if (opcode !== OPCODE.text && opcode !== OPCODE.binary) { fail(1002, `unknown opcode ${opcode}`); return; }
      if (fin) { deliver(opcode, payload); continue; }
      fragments = [payload];
      fragmentOpcode = opcode;
      fragmentBytes = payload.length;
    }
  }

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (pending.length > MAX_MESSAGE_BYTES * 2) { fail(1009, 'message too large'); return; }
    try { consume(); } catch { fail(1011, 'frame could not be read'); }
  });
  socket.on('close', finish);
  socket.on('end', finish);
  socket.on('error', finish);
  socket.on('drain', flushCoalesced);

  // Whatever arrived with the upgrade is already the start of the stream.
  if (pending.length) consume();

  return {
    get closed() { return closed; },
    send: (text, options) => sendFrame(prepareWebSocketText(text), options),
    sendPrepared: sendFrame,
    close(code = 1000, reason = ''): void { fail(code, reason); },
    onMessage(listener) { messageListeners.push(listener); },
    onClose(listener) { closeListeners.push(listener); },
  };
}
