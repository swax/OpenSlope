// tier: fast

/**
 * The server-side PNG decoder refuses a header that lies about the image behind it.
 *
 * `decodePng` sits behind every upload that carries a picture — texture, sky, Blender push, transfer import —
 * and used to size its buffers off IHDR alone: a few hundred bytes claiming 60,000 × 60,000 pixels allocated
 * gigabytes before a single byte of IDAT was read, and an IDAT that unpacked to more than the header promised
 * was inflated whole. So what is pinned here is that the header is checked against a ceiling and the data
 * against the header, in both directions, and that an honest image still decodes.
 *
 * Run: tsx test/png-decode.test.ts
 */
import { deflateSync } from 'node:zlib';
import { decodePng, encodePng } from '../src/server/routes/png';
import { check, failures } from './check';

/** A solid-colour RGBA image, encoded the way the server itself encodes one. */
const fixture = (w: number, h: number): Buffer => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([10, 200, 30, 255], i * 4);
  return encodePng({ w, h, data });
};

/** The same bytes with a different IHDR width/height — the header lying, the data unchanged. */
const withHeader = (png: Buffer, w: number, h: number): Buffer => {
  const forged = Buffer.from(png);
  forged.writeUInt32BE(w, 16); // IHDR body starts at 16: signature (8) + length (4) + type (4)
  forged.writeUInt32BE(h, 20);
  return forged;
};

const refuses = (bytes: Buffer, label: string): void => {
  let message = '';
  try { decodePng(bytes); } catch (error) { message = String(error instanceof Error ? error.message : error); }
  check(message !== '', `${label} is refused`, message || 'decoded without complaint');
};

const honest = decodePng(fixture(4, 4));
check(honest.w === 4 && honest.h === 4 && honest.data[1] === 200, 'an honest image still decodes');

refuses(withHeader(fixture(4, 4), 60_000, 60_000), 'a tiny IDAT under a header claiming 3.6 gigapixels');
refuses(withHeader(fixture(4, 4), 0, 4), 'a zero width');
refuses(withHeader(fixture(4, 4), 4, 0), 'a zero height');
refuses(withHeader(fixture(4, 4), 8, 8), 'a header claiming more rows than the data holds');
refuses(withHeader(fixture(4, 4), 2, 2), 'a header claiming fewer rows than the data unpacks to');

// The same claim through the raw stream rather than a forged header: a legal-looking IDAT whose inflated size
// simply is not what a 4x4 RGBA image costs.
const raw = Buffer.alloc(4 * (1 + 4 * 4) + 1, 0);
const idat = deflateSync(raw);
const crc = Buffer.alloc(4);
const chunk = (type: string, body: Buffer) => Buffer.concat([
  (() => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0); return len; })(),
  Buffer.from(type, 'ascii'), body, crc,
]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 6;
refuses(Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]), 'an IDAT one byte longer than the header accounts for');

if (failures) process.exitCode = 1;
else console.log('png-decode: all checks passed');
