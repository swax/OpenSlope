import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import { canonicalDiscCourse } from '../core/reference/disc-courses';
import { mapLimit } from '../shared/map-data';
import { referenceManifest, type ReferenceFile, type ReferenceManifest } from '../shared/reference-transfer';
import { referenceMusicEncoding, REFERENCE_MUSIC_INDEX } from '../shared/reference-music-encoding';
import { listLevelOrigins } from './routes/levels';
import { mapsRoot } from './workspace-config';
import { serialize } from './serialize';
import { invalidateReferenceLevel } from './api/common';
import { clearReferenceAssetRevisions } from './reference-asset-revisions';
import { invalidateReferenceSkyCache } from './routes/skybox';
import { announceLibraryChanged } from './library-events';
import { forgetReferencePublication } from './public-courses';
import { createLogger } from './log';
import {
  materializeReferenceAliases,
  rememberReferenceFiles,
  reuseReferenceFiles,
  type ReferenceReuse,
} from './reference-file-reuse';

const log = createLogger('reference-upload');
const uploads = new Map<string, Upload>();
const TTL = 30 * 60_000;
interface Upload {
  id: string;
  actor: string;
  root: string;
  directory: string;
  manifest: ReferenceManifest;
  transferFiles: ReferenceFile[];
  aliases: ReferenceReuse['aliases'];
  offset: number;
  total: number;
  timer: ReturnType<typeof setTimeout>;
}

export class ReferenceTransferError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export async function serverReferences() {
  return (await listLevelOrigins()).map(map => ({
    name: map.name,
    course: map.course ?? map.name,
    ...(map.displayName ? { displayName: map.displayName } : {}),
  }));
}

function refresh(name: string) {
  invalidateReferenceLevel(name);
  clearReferenceAssetRevisions();
  invalidateReferenceSkyCache(name);
  announceLibraryChanged('custom'); // Existing library clients reload the prop and texture catalogues.
}

/** Only newly allocated hidden siblings can ever be recursively removed by upload cleanup. */
async function removeStaging(root: string, staging: string) {
  const directory = resolve(staging);
  if (dirname(directory) !== root || !/^\.reference-(upload|remove)-[a-z0-9-]+$/i.test(basename(directory)))
    throw new Error('Invalid reference staging directory.');
  await rm(directory, { recursive: true, force: true });
}

async function discard(upload: Upload) {
  clearTimeout(upload.timer);
  uploads.delete(upload.id);
  await removeStaging(upload.root, upload.directory);
}

function touch(upload: Upload) {
  clearTimeout(upload.timer);
  upload.timer = setTimeout(() => {
    void serialize(`reference-upload:${upload.id}`, () => discard(upload)).catch(error =>
      log.warn('could not remove expired reference upload', { error }),
    );
  }, TTL);
  upload.timer.unref();
}

function owned(id: string, actor: string): Upload {
  const upload = uploads.get(id);
  if (!upload || upload.actor !== actor) throw new ReferenceTransferError('Reference upload not found.', 404);
  touch(upload);
  return upload;
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function beginReferenceUpload(actor: string, input: unknown, signal?: AbortSignal) {
  const manifest = referenceManifest(input);
  return serialize('reference-upload-slots', async () => {
    signal?.throwIfAborted();
    if (uploads.size >= 2)
      throw new ReferenceTransferError('Another reference upload is in progress. Try again shortly.', 429);
    const root = await realpath(mapsRoot());
    // A process interruption cannot leave a partial course visible. Reclaim its old hidden staging on retry.
    for (const name of await readdir(root)) {
      if (
        !/^\.reference-(upload|remove)-[a-z0-9-]+$/i.test(name) ||
        [...uploads.values()].some(upload => basename(upload.directory) === name)
      )
        continue;
      const path = join(root, name);
      const entry = await lstat(path);
      if (Date.now() - entry.mtimeMs > TTL) await removeStaging(root, path);
    }
    const existing = (await serverReferences()).find(
      map => canonicalDiscCourse(map.course.toUpperCase()) === canonicalDiscCourse(manifest.course),
    );
    if (existing || (await entryExists(join(root, manifest.course))))
      throw new ReferenceTransferError('This course is already a server reference.', 409);
    const id = randomUUID();
    const directory = join(root, `.reference-upload-${id}`);
    await mkdir(directory);
    // Hold a slot while checking donors too, so concurrent negotiations cannot exceed the upload cap.
    const upload: Upload = {
      id,
      actor,
      root,
      directory,
      manifest,
      transferFiles: manifest.files,
      aliases: [],
      offset: 0,
      total: manifest.files.reduce((sum, file) => sum + file.size, 0),
      timer: setTimeout(() => {}, 0),
    };
    uploads.set(id, upload);
    touch(upload);
    try {
      if (!manifest.reuse) return { id, offset: 0 };
      const reuse = await reuseReferenceFiles(root, directory, manifest.course, manifest.files, signal);
      upload.transferFiles = reuse.missing.map(index => manifest.files[index]);
      upload.aliases = reuse.aliases;
      upload.total = upload.transferFiles.reduce((sum, file) => sum + file.size, 0);
      return { id, offset: 0, missing: reuse.missing, reusedFiles: reuse.reusedFiles, reusedBytes: reuse.reusedBytes };
    } catch (error) {
      await discard(upload);
      throw error;
    }
  });
}

export function referenceUploadStatus(id: string, actor: string) {
  return serialize(`reference-upload:${id}`, async () => ({ offset: owned(id, actor).offset }));
}

/** One bounded contiguous slice of the ordered manifest, distributed directly into its files. */
export function writeReferenceChunk(id: string, actor: string, offset: number, bytes: Buffer) {
  return serialize(`reference-upload:${id}`, async () => {
    const upload = owned(id, actor);
    if (!Number.isSafeInteger(offset) || offset !== upload.offset)
      throw new ReferenceTransferError('Reference upload offset changed. Check upload status before retrying.', 409);
    if (!bytes.length || offset + bytes.length > upload.total)
      throw new ReferenceTransferError('Invalid reference upload size.');
    try {
      let start = 0,
        consumed = 0;
      for (const file of upload.transferFiles) {
        const end = start + file.size;
        if (file.size && end > offset && start < offset + bytes.length) {
          const first = Math.max(offset, start),
            last = Math.min(offset + bytes.length, end);
          const path = join(upload.directory, file.path);
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, bytes.subarray(first - offset, last - offset), { flag: first === start ? 'wx' : 'a' });
          consumed += last - first;
        }
        start = end;
      }
      if (consumed !== bytes.length) throw new Error('Reference upload manifest size mismatch.');
      upload.offset += bytes.length;
      return { offset: upload.offset };
    } catch (error) {
      await discard(upload);
      throw error;
    }
  });
}

async function validate(upload: Upload) {
  const files = new Map(upload.manifest.files.map(file => [file.path, file]));
  const required = (path: string) => {
    if (!files.has(path)) throw new Error(`Reference is missing ${path}.`);
  };
  const texture = (name: unknown, prefix: string) => {
    if (typeof name !== 'string' || !name) return;
    required(`${prefix}Textures/${name}`);
  };
  const validateFile = async (file: ReferenceFile) => {
    const path = join(upload.directory, file.path);
    if (!file.size) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '', { flag: 'wx' });
    }
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    if (hash.digest('hex') !== file.sha256) throw new Error(`Reference file failed its hash check: ${file.path}`);
    if (file.path.startsWith('Source/')) return; // Retained lossless sidecars are opaque, never executed.
    if (/\.png$/i.test(file.path)) {
      const bytes = await readFile(path);
      if (
        bytes.length < 24 ||
        bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        !bytes.readUInt32BE(16) ||
        !bytes.readUInt32BE(20) ||
        bytes.readUInt32BE(16) > 8192 ||
        bytes.readUInt32BE(20) > 8192 ||
        bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_777_216
      )
        throw new Error(`Invalid reference image: ${file.path}`);
      await loadImage(bytes);
    }
    if (!/\.json$/i.test(file.path)) return;
    const doc = JSON.parse(await readFile(path, 'utf8'));
    const prefix = file.path.startsWith('Skybox/') ? 'Skybox/' : '';
    if (file.path === 'Patches.json') {
      const patches = doc.Patches ?? doc;
      if (!Array.isArray(patches) || !patches.length || patches.length > 100_000)
        throw new Error('Invalid reference terrain.');
      for (const patch of patches) {
        if (
          !Array.isArray(patch.Points) ||
          patch.Points.length !== 16 ||
          patch.Points.some(
            (point: unknown) => !Array.isArray(point) || point.length < 3 || !point.slice(0, 3).every(Number.isFinite),
          )
        )
          throw new Error('Invalid reference patch controls.');
        texture(patch.TexturePath, '');
        if (Number.isInteger(patch.LightmapID) && patch.LightmapID >= 0)
          required(`Lightmaps/${String(patch.LightmapID).padStart(4, '0')}.png`);
      }
    }
    if (/^(Skybox\/)?Models\.json$/.test(file.path))
      for (const model of doc.Models ?? []) {
        if (model.PlacementCollisionPath) required(`${prefix}Collision/${model.PlacementCollisionPath}`);
        for (const object of model.ModelObjects ?? [])
          for (const mesh of object?.MeshData ?? []) if (mesh?.MeshPath) required(`${prefix}Meshes/${mesh.MeshPath}`);
      }
    if (file.path === 'Instances.json')
      for (const instance of doc.Instances ?? [])
        for (const path of instance.CollsionModelPaths ?? []) required(`Collision/${path}`);
    if (/^(Skybox\/)?Materials\.json$/.test(file.path))
      for (const material of doc.Materials ?? []) {
        texture(material.TexturePath, prefix);
        for (const frame of material.TextureFlipbook ?? []) texture(frame, prefix);
      }
  };
  // Wait for every in-flight read before removing a failed upload, especially on Windows.
  let failure: unknown;
  await mapLimit(upload.manifest.files, 2, async file => {
    if (failure) return;
    try {
      await validateFile(file);
    } catch (error) {
      failure ??= error;
    }
  });
  if (failure) throw failure;
  const encoded = [...files.values()].filter(file => /^Audio\/(Music|Intro)\/.+\.opus$/i.test(file.path));
  if (encoded.length || files.has(REFERENCE_MUSIC_INDEX)) {
    required(REFERENCE_MUSIC_INDEX);
    const index = referenceMusicEncoding(
      JSON.parse(await readFile(join(upload.directory, REFERENCE_MUSIC_INDEX), 'utf8')),
    );
    if (index.files.length !== encoded.length) throw new Error('Reference music encoding index is incomplete.');
    for (const music of index.files) {
      const file = files.get(music.path);
      if (
        !file ||
        file.size !== music.size ||
        file.sha256 !== music.sha256 ||
        files.has(music.path.replace(/\.opus$/i, '.wav'))
      )
        throw new Error('Reference music encoding index does not match its files.');
      const bytes = await readFile(join(upload.directory, music.path));
      if (
        bytes.length < 64 ||
        bytes.toString('ascii', 0, 4) !== 'OggS' ||
        bytes.toString('ascii', 28, 36) !== 'OpusHead'
      )
        throw new Error('Invalid compressed reference music.');
    }
  }
  required('Origin.json');
  required('Import.json');
  const origin = JSON.parse(await readFile(join(upload.directory, 'Origin.json'), 'utf8'));
  const imported = JSON.parse(await readFile(join(upload.directory, 'Import.json'), 'utf8'));
  if (
    origin.Origin !== 'retail' ||
    origin.RetailData !== true ||
    canonicalDiscCourse(String(origin.Course).toUpperCase()) !== canonicalDiscCourse(upload.manifest.course) ||
    imported.Schema !== 'openslope-native-import/v1' ||
    canonicalDiscCourse(String(imported.Course).toUpperCase()) !== canonicalDiscCourse(upload.manifest.course)
  )
    throw new Error('Reference provenance does not match this extracted course.');
}

export function finishReferenceUpload(id: string, actor: string) {
  return serialize(`reference-upload:${id}`, async () => {
    const upload = owned(id, actor);
    if (upload.offset !== upload.total) throw new ReferenceTransferError('Reference upload is incomplete.', 409);
    try {
      await materializeReferenceAliases(upload.directory, upload.aliases);
      await validate(upload);
      return await serialize(`reference-map:${upload.root}`, async () => {
        const course = upload.manifest.course;
        const existing = (await serverReferences()).some(
          map => canonicalDiscCourse(map.course.toUpperCase()) === canonicalDiscCourse(course),
        );
        if (existing || (await entryExists(join(upload.root, course))))
          throw new ReferenceTransferError('This course is already a server reference.', 409);
        await rename(upload.directory, join(upload.root, course));
        clearTimeout(upload.timer);
        uploads.delete(id);
        await rememberReferenceFiles(upload.root, course, upload.manifest.files);
        refresh(course);
        return { name: course, course };
      });
    } catch (error) {
      await discard(upload);
      throw error;
    }
  });
}

export function cancelReferenceUpload(id: string, actor: string) {
  return serialize(`reference-upload:${id}`, async () => discard(owned(id, actor)));
}

export async function removeServerReference(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(name) || /^(shared|custom|riders)$/i.test(name))
    throw new ReferenceTransferError('Invalid reference map name.');
  const root = await realpath(mapsRoot());
  return serialize(`reference-map:${root}`, async () => {
    const map = (await serverReferences()).find(map => map.name === name);
    if (!map) throw new ReferenceTransferError('Reference map not found.', 404);
    const path = join(root, map.name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error('Reference folder must be an ordinary directory.');
    const retired = await mkdtemp(join(root, '.reference-remove-'));
    // Remove the empty reservation before renaming on Windows, where a destination directory cannot exist.
    await rmdir(retired);
    await rename(path, retired);
    refresh(name);
    await forgetReferencePublication(name);
    await removeStaging(root, retired);
  });
}
