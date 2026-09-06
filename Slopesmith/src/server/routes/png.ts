import { deflateSync, inflateSync } from 'node:zlib';
import type { Rgba } from '../../core/paint/ground-textures';

/** Minimal PNG encoder (8-bit RGBA, filter 0) - enough for snowknife's ImageSharp reader. */
export function encodePng(img: Rgba): Buffer {
  const { w, h, data } = img;

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // compression / filter / interlace = 0

  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The most pixels a PNG may claim before it is refused unread. The sky upload is the widest legitimate input
 * (a 64 MB body, so an 8K 2:1 equirect at most); everything else here is smaller. Above this the header is
 * lying about its size, and believing it would allocate gigabytes off a few hundred bytes of IDAT.
 */
const MAX_PNG_PIXELS = 8192 * 4096;

/**
 * Minimal PNG decoder (8-bit; colour types 0 grey / 2 RGB / 4 grey+alpha / 6 RGBA; filters 0-4) — the
 * companion to encodePng. Lets node read back an extracted level's lightmap pages (the browser uses canvas)
 * so the reference-sun study can fit headlessly. Returns RGBA (grey/RGB expanded, alpha defaulted to 255).
 */
export function decodePng(buf: Buffer): Rgba {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let i = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const body = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4); bitDepth = body[8]; colorType = body[9]; interlace = body[12];
    }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    i += 12 + len; // length(4) + type(4) + data + crc(4)
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('unsupported interlaced PNG');
  if (!w || !h || w * h > MAX_PNG_PIXELS) throw new Error(`unsupported PNG size ${w}x${h}`);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1; // bytes per pixel
  const stride = w * ch;
  // Exactly the bytes the header promises — one filter byte and one row per line. Capping the inflate at that
  // is what stops a small IDAT unpacking into something the header never declared, and a short one is refused
  // rather than zero-filled: either way the header and the data disagree, and that is not a PNG this reads.
  const expected = h * (1 + stride);
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); }
  catch { throw new Error('PNG image data does not match its header'); }
  if (raw.length !== expected) throw new Error('PNG image data does not match its header');
  const out = new Uint8Array(w * h * 4);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;   // recon(left)
      const b = prev[x];                     // recon(up)
      const c = x >= ch ? prev[x - ch] : 0;  // recon(up-left)
      let v = raw[p++];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      if (ch >= 3) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = ch === 4 ? cur[s + 3] : 255; }
      else { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = ch === 2 ? cur[s + 1] : 255; }
    }
    prev.set(cur);
  }
  return { w, h, data: out };
}
