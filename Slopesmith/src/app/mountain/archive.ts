import type { ExportFile } from '../../core/export/files';
import {
  MOUNTAIN_ARCHIVE_MANIFEST, MOUNTAIN_ARCHIVE_SCHEMA, PROJECT_BUNDLE_SCHEMA,
  type BundleAsset, type BundleAssetKind, type MountainArchiveAsset, type MountainArchiveManifest,
  type ProjectBundle,
} from '../../core/project/transfer';
import { crc32 } from '../export/crc32';
import { zipStoreOnly } from '../export/zip';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_ARCHIVE_BYTES = 180 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 4096;
const ASSET_KINDS = new Set<BundleAssetKind>(['texture', 'sound', 'music', 'sky', 'prop']);

/** A complete editable mountain ready for the browser's download handoff. */
export interface MountainArchiveDownload { filename: string; blob: Blob }
export interface MountainArchiveOptions { filenameStem?: string; checkpoint?: boolean }

const filenameStem = (name: string): string => name.trim()
  // eslint-disable-next-line no-control-regex -- strips the control characters a filename may not carry
  .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
  .replace(/[. ]+$/g, '').slice(0, 80) || 'mountain';

/** A sortable, timezone-explicit instant which is also safe in Windows filenames. */
const filenameTimestamp = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('the mountain transfer has an invalid capture time');
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
};

const assetExtension = (asset: BundleAsset): string => {
  if (asset.kind === 'texture' || asset.kind === 'sky') return '.png';
  if (asset.kind === 'sound') return '.wav';
  if (asset.kind === 'prop') return '.json';
  const match = /\.[A-Za-z0-9]{1,10}$/.exec(asset.name);
  return match?.[0].toLowerCase() ?? '.bin';
};

const assetFolder = (kind: BundleAssetKind): string => kind === 'music' ? 'music' : `${kind}s`;

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesBase64(bytes: Uint8Array): string {
  // `String.fromCharCode(...bytes)` overflows the argument stack for real music and texture payloads.
  const chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(at, at + 0x8000)));
  }
  return btoa(chunks.join(''));
}

/** Turn the server's self-contained transfer bundle into the public, ZIP-based mountain format. */
export function createMountainArchive(bundle: ProjectBundle,
  options: MountainArchiveOptions = {}): MountainArchiveDownload {
  const root = filenameStem(options.filenameStem || bundle.name || bundle.document.name || 'mountain');
  if (!Number.isSafeInteger(bundle.revision) || bundle.revision < 0) {
    throw new Error('the mountain transfer has an invalid revision');
  }
  const files = new Map<string, Uint8Array>();
  const assets: MountainArchiveAsset[] = bundle.assets.map(asset => {
    if (!/^[0-9a-f]{64}$/i.test(asset.hash)) throw new Error(`${asset.kind} ${asset.name} has an invalid hash`);
    const packed = bundle.blobs?.[asset.hash];
    if (!packed) throw new Error(`${asset.kind} ${asset.name} is missing from the mountain transfer`);
    const bytes = base64Bytes(packed);
    if (bytes.length !== asset.size) {
      throw new Error(`${asset.kind} ${asset.name} is ${bytes.length} bytes, expected ${asset.size}`);
    }
    const file = `assets/${assetFolder(asset.kind)}/${asset.hash.toLowerCase()}${assetExtension(asset)}`;
    files.set(file, bytes);
    return { ...asset, hash: asset.hash.toLowerCase(), file };
  });
  const manifest: MountainArchiveManifest = {
    kind: 'slopesmith-mountain', schema: MOUNTAIN_ARCHIVE_SCHEMA,
    name: bundle.name || bundle.document.name || root,
    revision: bundle.revision, takenAt: bundle.takenAt,
    document: 'mountain.slope.json', assets,
    ...(bundle.missing?.length ? { missing: bundle.missing } : {}),
  };
  const entries: ExportFile[] = [
    { path: MOUNTAIN_ARCHIVE_MANIFEST,
      bytes: textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: manifest.document,
      bytes: textEncoder.encode(`${JSON.stringify(bundle.document, null, 2)}\n`) },
    ...[...files].map(([path, bytes]) => ({ path, bytes })),
  ];
  if (entries.reduce((total, entry) => total + entry.bytes.length, 0) > MAX_ARCHIVE_BYTES) {
    throw new Error('the editable mountain is larger than the 180 MB portable archive limit');
  }
  const checkpoint = options.checkpoint ? '-checkpoint' : '';
  const version = `r${bundle.revision}-${filenameTimestamp(bundle.takenAt)}`;
  return { filename: `${root}${checkpoint}-${version}.slopesmith.zip`, blob: zipStoreOnly(root, entries) };
}

interface ZipEntry { name: string; method: number; compressed: Uint8Array; size: number; crc: number }

const safeRelativePath = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')) {
    throw new Error(`${what} has an invalid path`);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${what} has an invalid path`);
  return value;
};

/** Locate and read the central directory; local headers are used only to find each entry's payload. */
function zipDirectory(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('the mountain ZIP is larger than 180 MB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let at = bytes.length - 22; at >= earliest; at--) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('that file is not a ZIP archive');
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const count = view.getUint16(end + 10, true);
  const centralBytes = view.getUint32(end + 12, true);
  const centralAt = view.getUint32(end + 16, true);
  if (disk || centralDisk) throw new Error('multi-part ZIP archives are not supported');
  if (count === 0xffff || centralAt === 0xffffffff || centralBytes === 0xffffffff) {
    throw new Error('ZIP64 mountain archives are not supported');
  }
  if (count > MAX_ARCHIVE_FILES || centralAt + centralBytes > end) throw new Error('the ZIP directory is invalid');

  const entries: ZipEntry[] = [];
  let at = centralAt;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error('the ZIP directory is invalid');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end || localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50) {
      throw new Error('the ZIP directory points outside the archive');
    }
    if (flags & 1) throw new Error('encrypted ZIP entries are not supported');
    if (method !== 0 && method !== 8) throw new Error(`ZIP compression method ${method} is not supported`);
    const name = textDecoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localName + localExtra;
    if (dataAt + compressedSize > bytes.length) throw new Error(`ZIP entry ${name} is truncated`);
    expanded += size;
    if (expanded > MAX_ARCHIVE_BYTES) throw new Error('the expanded mountain ZIP is larger than 180 MB');
    entries.push({ name, method, compressed: bytes.subarray(dataAt, dataAt + compressedSize), size, crc });
    at = next;
  }
  return entries;
}

async function inflateEntry(entry: ZipEntry): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressed.length !== entry.size) throw new Error(`ZIP entry ${entry.name} has the wrong size`);
    bytes = entry.compressed.slice();
  } else {
    const stream = new Blob([entry.compressed as BlobPart]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (bytes.length !== entry.size) throw new Error(`ZIP entry ${entry.name} has the wrong expanded size`);
  }
  if (crc32(bytes) !== entry.crc) throw new Error(`ZIP entry ${entry.name} failed its CRC check`);
  return bytes;
}

const archiveAsset = (value: unknown): MountainArchiveAsset => {
  if (!value || typeof value !== 'object') throw new Error('the mountain manifest has an invalid asset');
  const asset = value as Partial<MountainArchiveAsset>;
  if (!ASSET_KINDS.has(asset.kind as BundleAssetKind) || typeof asset.name !== 'string' || !asset.name
    || typeof asset.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.hash)
    || !Number.isSafeInteger(asset.size) || Number(asset.size) < 0) {
    throw new Error('the mountain manifest has an invalid asset');
  }
  if (asset.model !== undefined && !Number.isSafeInteger(asset.model)) {
    throw new Error(`prop ${asset.name} has an invalid model number`);
  }
  return { kind: asset.kind as BundleAssetKind, name: asset.name, hash: asset.hash.toLowerCase(),
    size: Number(asset.size), ...(asset.model === undefined ? {} : { model: Number(asset.model) }),
    file: safeRelativePath(asset.file, `${asset.kind} ${asset.name}`) };
};

/** Read a mountain ZIP made by Slopesmith, accepting both stored and ordinarily deflated ZIP entries. */
export async function readMountainArchive(file: Blob): Promise<ProjectBundle> {
  const entries = zipDirectory(new Uint8Array(await file.arrayBuffer()));
  const manifests = entries.filter(entry => entry.name === MOUNTAIN_ARCHIVE_MANIFEST
    || entry.name.endsWith(`/${MOUNTAIN_ARCHIVE_MANIFEST}`));
  if (manifests.length !== 1) throw new Error('the ZIP must contain exactly one mountain manifest');
  const manifestEntry = manifests[0];
  const root = manifestEntry.name.slice(0, -MOUNTAIN_ARCHIVE_MANIFEST.length);
  const directory = new Map<string, ZipEntry>();
  for (const entry of entries) {
    if (directory.has(entry.name)) throw new Error(`the ZIP contains ${entry.name} more than once`);
    directory.set(entry.name, entry);
  }
  // Inflate only entries the manifest names. An archive may contain harmless thumbnails or OS metadata; none
  // of it should consume memory merely because it shares a ZIP with the mountain.
  const inflated = new Map<string, Promise<Uint8Array>>();
  const readEntry = (name: string): Promise<Uint8Array> | null => {
    const entry = directory.get(name);
    if (!entry) return null;
    let pending = inflated.get(name);
    if (!pending) { pending = inflateEntry(entry); inflated.set(name, pending); }
    return pending;
  };
  const manifest = JSON.parse(textDecoder.decode(await readEntry(manifestEntry.name)!)) as MountainArchiveManifest;
  if (manifest?.kind !== 'slopesmith-mountain' || manifest.schema !== MOUNTAIN_ARCHIVE_SCHEMA) {
    throw new Error('that ZIP is not a supported Slopesmith mountain');
  }
  const documentPath = root + safeRelativePath(manifest.document, 'the mountain document');
  const documentBytes = readEntry(documentPath);
  if (!documentBytes) throw new Error(`the mountain ZIP is missing ${manifest.document}`);
  const document = JSON.parse(textDecoder.decode(await documentBytes));
  if (!document || typeof document !== 'object') throw new Error('the mountain document is not a JSON object');

  const assets = Array.isArray(manifest.assets) ? manifest.assets.map(archiveAsset) : [];
  const blobs: Record<string, string> = {};
  for (const asset of assets) {
    const payload = readEntry(root + asset.file);
    if (!payload) throw new Error(`the mountain ZIP is missing ${asset.file}`);
    const bytes = await payload;
    if (bytes.length !== asset.size) {
      throw new Error(`${asset.kind} ${asset.name} is ${bytes.length} bytes, expected ${asset.size}`);
    }
    blobs[asset.hash] = bytesBase64(bytes);
  }
  return {
    kind: 'slopesmith-project', schema: PROJECT_BUNDLE_SCHEMA,
    name: typeof manifest.name === 'string' ? manifest.name : '',
    revision: Number.isSafeInteger(manifest.revision) ? manifest.revision : 0,
    takenAt: typeof manifest.takenAt === 'string' ? manifest.takenAt : new Date(0).toISOString(),
    document, assets: assets.map(({ file: _file, ...asset }) => asset), blobs,
    ...(Array.isArray(manifest.missing)
      ? { missing: manifest.missing.filter((entry): entry is string => typeof entry === 'string') } : {}),
  };
}
