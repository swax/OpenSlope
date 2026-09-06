/**
 * Encode a greyscale mask as a PNG and embed it in a finished GLB as an emissive texture.
 *
 * ## Why this exists rather than `GLTFExporter`'s own image path
 *
 * The exporter writes images by drawing them into a canvas and asking it for PNG bytes. Node has no canvas,
 * and the one this repository already depends on (`@napi-rs/canvas`) is a per-platform native binary — its
 * PNG output is a property of the skia build that happens to be installed. A generated character is checked
 * into git and asserted byte-identical to what its source produces, so an encoder whose output can differ
 * between a developer's Windows machine and a Linux CI runner would turn that check into the exact kind of
 * test that only fails somewhere else.
 *
 * Everything here is therefore fully specified: greyscale 8-bit PNG, one filter mode (none), and a zlib
 * stream of STORED deflate blocks. Stored blocks cost about 0.03% over the raw bytes and compress nothing,
 * which is the point — there is no compressor whose heuristics could change between versions. A mask this
 * small (a few kilobytes) does not need the compression, and determinism is worth far more than it.
 *
 * ## Why greyscale
 *
 * glTF multiplies `emissiveTexture` by the material's `emissiveFactor`, so a one-channel mask plus a colour
 * per material gives every light its shape from the texture and its colour from the palette. Two materials
 * can share one atlas and glow different colours, and a repaint stays a hex digit.
 */

export interface GreyImage {
  name: string;
  width: number;
  height: number;
  /** Row-major, one byte per texel. Row 0 is v = 0, which in glTF is the TOP of the image. */
  pixels: Uint8Array;
}

export interface EmbeddedTexture extends GreyImage {
  /** `repeat` is what lets a runtime scroll the texture along a strip; `clamp` suits an atlas. */
  wrap: 'clamp' | 'repeat';
}

/** Which material gets which texture as its emissive mask. Materials are matched by name, because index
 *  order is an exporter detail and a name is what the parts table already says. */
export interface EmissiveAssignment {
  material: string;
  texture: string;
}

/* ── PNG ───────────────────────────────────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream of stored (uncompressed) deflate blocks: byte-for-byte specified by RFC 1950/1951. */
function storedZlib(data: Uint8Array): Uint8Array {
  const blocks: number[] = [0x78, 0x01]; // CMF/FLG for deflate, 32K window, fastest level; 0x7801 % 31 === 0
  for (let at = 0; at < data.length || at === 0; at += 65535) {
    const length = Math.min(65535, data.length - at);
    const final = at + length >= data.length ? 1 : 0;
    blocks.push(final, length & 0xff, length >>> 8, ~length & 0xff, (~length >>> 8) & 0xff);
    for (let i = 0; i < length; i++) blocks.push(data[at + i]);
    if (final) break;
  }
  const checksum = adler32(data);
  blocks.push((checksum >>> 24) & 0xff, (checksum >>> 16) & 0xff, (checksum >>> 8) & 0xff, checksum & 0xff);
  return new Uint8Array(blocks);
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

/** An 8-bit greyscale PNG. Deterministic on every platform and every Node version. */
export function encodeGreyPng(image: GreyImage): Uint8Array {
  const { width, height, pixels } = image;
  if (width < 1 || height < 1) throw new Error(`${image.name}: a texture needs a non-zero size`);
  if (pixels.length !== width * height) {
    throw new Error(`${image.name}: expected ${width * height} texels, received ${pixels.length}`);
  }
  // Filter byte 0 ("None") per scanline. A mask is authored, not photographed, so a predictive filter would
  // only buy compression this file has already decided not to use.
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;   // bit depth
  header[9] = 0;   // colour type 0: greyscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', storedZlib(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((sum, one) => sum + one.length, 0));
  let at = 0;
  for (const one of parts) { png.set(one, at); at += one.length; }
  return png;
}

/* ── GLB ───────────────────────────────────────────────────────────────────────────────────────────── */

const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

interface GlbJson {
  buffers?: { byteLength?: number; uri?: string }[];
  bufferViews?: { buffer: number; byteOffset: number; byteLength: number }[];
  images?: { bufferView?: number; mimeType?: string; name?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  textures?: { sampler?: number; source?: number }[];
  materials?: {
    name?: string;
    emissiveFactor?: number[];
    emissiveTexture?: { index: number; texCoord?: number };
  }[];
}

const align4 = (value: number) => (value + 3) & ~3;

/**
 * Attach emissive masks to an exported GLB.
 *
 * `GLTFExporter` has no hook for "use exactly these bytes", so the file is reopened and the images are added
 * the way the spec says they live in a GLB: PNG bytes in the binary chunk, a bufferView over them, and an
 * image/sampler/texture triple pointing at that. Materials are matched by name and given a white
 * `emissiveFactor` only if they had none, so a palette entry that chose its own glow colour keeps it.
 */
export function attachEmissiveTextures(glb: Uint8Array, textures: readonly EmbeddedTexture[],
                                       assignments: readonly EmissiveAssignment[]): Uint8Array {
  if (!textures.length) return glb;
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  let json: GlbJson | null = null;
  // A view into the caller's buffer rather than a copy, so re-exporting a character does not duplicate its
  // whole binary chunk just to append a few kilobytes of PNG to it.
  let bin: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for (let offset = 12; offset < glb.byteLength;) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(glb.subarray(start, start + length)));
    else if (type === BIN_CHUNK) bin = glb.subarray(start, start + length);
    offset = start + length;
  }
  if (!json) throw new Error('exported GLB has no JSON chunk');

  const images = json.images ??= [];
  const samplers = json.samplers ??= [];
  const glTextures = json.textures ??= [];
  const bufferViews = json.bufferViews ??= [];
  const appended: Uint8Array[] = [];
  let binLength = bin.byteLength;
  const textureIndex = new Map<string, number>();
  for (const texture of textures) {
    const png = encodeGreyPng(texture);
    const padding = align4(binLength) - binLength;
    if (padding) appended.push(new Uint8Array(padding));
    binLength += padding;
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: png.byteLength });
    appended.push(png);
    binLength += png.byteLength;
    images.push({ bufferView: bufferViews.length - 1, mimeType: 'image/png', name: texture.name });
    // Linear, and deliberately WITHOUT mipmaps (9729 both ways). An atlas cannot be mipmapped safely: every
    // reduction blends neighbouring cells, so at distance an unlit plate would pick up its neighbour's light
    // and the whole figure would haze over. The masks are smooth and small, which is what makes the
    // aliasing this trades for a non-issue.
    samplers.push({
      magFilter: 9729, minFilter: 9729,
      wrapS: texture.wrap === 'repeat' ? 10497 : 33071,
      wrapT: texture.wrap === 'repeat' ? 10497 : 33071,
    });
    glTextures.push({ sampler: samplers.length - 1, source: images.length - 1 });
    textureIndex.set(texture.name, glTextures.length - 1);
  }

  for (const assignment of assignments) {
    const index = textureIndex.get(assignment.texture);
    if (index === undefined) throw new Error(`no texture named ${assignment.texture}`);
    const material = json.materials?.find(entry => entry.name === assignment.material);
    if (!material) throw new Error(`no material named ${assignment.material} in the exported file`);
    material.emissiveTexture = { index };
    if (!material.emissiveFactor) material.emissiveFactor = [1, 1, 1];
  }

  json.buffers ??= [{}];
  json.buffers[0].byteLength = binLength;

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = align4(jsonBytes.byteLength);
  const binPadded = align4(binLength);
  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546c67, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, total, true);
  outView.setUint32(12, jsonPadded, true);
  outView.setUint32(16, JSON_CHUNK, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonPadded); // JSON pads with spaces, BIN with zeroes
  const binAt = 20 + jsonPadded;
  outView.setUint32(binAt, binPadded, true);
  outView.setUint32(binAt + 4, BIN_CHUNK, true);
  out.set(bin, binAt + 8);
  let at = binAt + 8 + bin.byteLength;
  for (const block of appended) { out.set(block, at); at += block.byteLength; }
  return out;
}

/** Decode an 8-bit greyscale PNG produced by `encodeGreyPng`. Used by the checks to read back what a
 *  built-in actually carries, without pulling in an image decoder. */
export function decodeGreyPng(png: Uint8Array): GreyImage {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.byteLength;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (body[8] !== 8 || body[9] !== 0) throw new Error('not an 8-bit greyscale PNG');
    } else if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const joined = new Uint8Array(data.reduce((sum, one) => sum + one.length, 0));
  let offset = 0;
  for (const one of data) { joined.set(one, offset); offset += one.length; }
  // Skip the two-byte zlib header and the trailing four-byte adler checksum; the rest is stored blocks.
  const raw = inflateStored(joined.subarray(2, joined.length - 4));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width + 1)] !== 0) throw new Error('only filter mode 0 is written by encodeGreyPng');
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { name: 'decoded', width, height, pixels };
}

/** The matching reader for `storedZlib`: walk stored blocks and concatenate their payloads. */
function inflateStored(deflated: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < deflated.length;) {
    const header = deflated[at];
    if ((header >> 1 & 0b11) !== 0) throw new Error('encodeGreyPng only writes stored deflate blocks');
    const length = deflated[at + 1] | (deflated[at + 2] << 8);
    parts.push(deflated.subarray(at + 5, at + 5 + length));
    at += 5 + length;
    if (header & 1) break;
  }
  const out = new Uint8Array(parts.reduce((sum, one) => sum + one.length, 0));
  let offset = 0;
  for (const one of parts) { out.set(one, offset); offset += one.length; }
  return out;
}
