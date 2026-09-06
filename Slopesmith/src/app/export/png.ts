import type { Rgba } from '../../core/paint/ground-textures';
import { crc32 } from './crc32';

/**
 * Minimal PNG encoder (8-bit RGBA, filter 0) — the browser half of the export's `encodePng`.
 *
 * The same hand-rolled writer the server runs, over `Uint8Array` and `CompressionStream` instead of `Buffer`
 * and `node:zlib`: four chunks, one filter mode, and the deflate the platform already ships. `CompressionStream
 * ('deflate')` emits the zlib wrapper an IDAT wants, so nothing here has to know about adler sums.
 *
 * This writes the pages an export GENERATES — the procedural terrain tiles, the baked lightmaps, a custom
 * sky's 25 slices. A page that already exists as a file is never re-encoded; it ships verbatim through the
 * byte cache (app/net/asset-bytes.ts).
 */

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function encodePng(img: Rgba): Promise<Uint8Array> {
  const { w, h, data } = img;

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, w);
  header.setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  // compression / filter / interlace = 0

  const stride = w * 4;
  const raw = new Uint8Array(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * A stored PNG's pixels, decoded by the browser's own image pipeline.
 *
 * Only the paths that RESAMPLE need this — a custom sky's panorama, which is cut into 25 pages against the
 * ring's real azimuth spans. Everything that merely copies a page keeps the file's own bytes instead, so a
 * decode never sits between a shipped tile and the folder it lands in.
 */
export async function decodePng(bytes: Uint8Array): Promise<Rgba> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no 2D canvas context to decode a PNG with');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { w: image.width, h: image.height, data: new Uint8Array(image.data.buffer) };
  } finally { bitmap.close(); }
}
