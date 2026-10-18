import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { constants, inflateRawSync } from 'node:zlib';

/** Independent wire client: exercises real upgrades, compressed frames, and masked client messages. */
export async function playSocket(
  url: string,
  options: { origin: string; cookie?: string; compressed?: boolean; headers?: Record<string, string> },
) {
  return new Promise<{
    seen: any[];
    compressed: boolean;
    closed: boolean;
    send(message: unknown): void;
    close(): void;
    expect(predicate: (message: any) => boolean, from?: number): Promise<any>;
  }>((resolve, reject) => {
    const req = request(url.replace(/^ws/, 'http'), {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        origin: options.origin,
        ...options.headers,
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.compressed ? { 'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits' } : {}),
      },
    });
    req.on('error', reject);
    req.on('response', response => {
      response.resume();
      reject(new Error(`Upgrade refused (${response.statusCode})`));
    });
    req.on('upgrade', (response, socket, head) => {
      let bytes = Buffer.from(head);
      const channel = {
        seen: [] as any[],
        compressed: !!response.headers['sec-websocket-extensions'],
        closed: false,
        close() {
          socket.destroy();
        },
        send(message: unknown) {
          const body = Buffer.from(JSON.stringify(message));
          const mask = randomBytes(4);
          const header = Buffer.alloc(body.length < 126 ? 2 : 4);
          header[0] = 0x81;
          if (body.length < 126) header[1] = 0x80 | body.length;
          else {
            header[1] = 0xfe;
            header.writeUInt16BE(body.length, 2);
          }
          for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
          socket.write(Buffer.concat([header, mask, body]));
        },
        async expect(predicate: (message: any) => boolean, from = 0): Promise<any> {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const found = channel.seen.slice(from).find(predicate);
            if (found) return found;
            await new Promise(done => setTimeout(done, 10));
          }
          assert.fail(`Timed out waiting for play frame; received ${JSON.stringify(channel.seen.slice(from))}`);
        },
      };
      function consume() {
        while (bytes.length >= 2) {
          const opcode = bytes[0] & 15,
            compressed = !!(bytes[0] & 64);
          let size = bytes[1] & 127,
            at = 2;
          if (size === 126) {
            if (bytes.length < 4) return;
            size = bytes.readUInt16BE(2);
            at = 4;
          }
          if (size === 127) {
            if (bytes.length < 10) return;
            size = Number(bytes.readBigUInt64BE(2));
            at = 10;
          }
          if (bytes.length < at + size) return;
          let payload = bytes.subarray(at, at + size);
          bytes = bytes.subarray(at + size);
          if (opcode === 8) {
            channel.closed = true;
            socket.destroy();
            return;
          }
          if (opcode !== 1) continue;
          if (compressed)
            payload = inflateRawSync(Buffer.concat([payload, Buffer.from([0, 0, 255, 255])]), {
              finishFlush: constants.Z_SYNC_FLUSH,
            });
          channel.seen.push(JSON.parse(payload.toString('utf8')));
        }
      }
      socket.on('data', chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        consume();
      });
      socket.on('close', () => {
        channel.closed = true;
      });
      socket.on('error', () => {
        channel.closed = true;
      });
      consume();
      resolve(channel);
    });
    req.end();
  });
}
