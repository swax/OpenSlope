import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { PropsPayload } from '../core/reference/props';
import { ensureWorkspace } from './workspace-config';
import {
  fileStamp, listEntries, mapLimit, pathExists, readBytesOrNull, writeFileAtomic, READ_CONCURRENCY,
} from './fs-async';
import { createLogger } from './log';

/** Bump whenever the generated PropsPayload contract or its server-side derivation changes. */
const PROP_PAYLOAD_CACHE_SCHEMA = 6;
const log = createLogger('props-cache');

export interface PersistentPropsPayload {
  payload: PropsPayload;
  cache: 'hit' | 'miss';
  fingerprint: string;
}

export interface PersistentPropsJson {
  json: Buffer;
  cache: 'hit' | 'miss';
  fingerprint: string;
}

/** Only these inputs can affect routes/props.readLevelProps. Texture pixels are served separately; the prop
 * payload depends on CROWD frame names, so those few files are included while ordinary tiles are skipped. */
const TOP_LEVEL_INPUTS = [
  'Models.json', 'Instances.json', 'Materials.json', 'TextureAlpha.overrides.json', 'Effects.json', 'Props.obj',
] as const;

/** A metadata fingerprint is deliberate: validating roughly 3,000 MERQUER source files takes about 200 ms,
 * while opening and parsing all of them takes seconds to tens of seconds on a cold Windows filesystem. Size,
 * nanosecond mtime, ctime, and relative name catch in-place edits as well as additions/removals.
 *
 * The stats are gathered concurrently but folded into the hash in a fixed order, because a fingerprint that
 * depended on completion order would change between runs over identical data and defeat the cache. */
export async function propsPayloadFingerprint(levelDir: string): Promise<string> {
  const root = resolve(levelDir);
  const hash = createHash('sha256');
  hash.update(`slopesmith-props:${PROP_PAYLOAD_CACHE_SCHEMA}\n`);
  hash.update(process.platform === 'win32' ? root.toLowerCase() : root).update('\n');

  const stampOf = async (relativeName: string) =>
    ({ relativeName, stamp: await fileStamp(join(root, relativeName)) });
  const addStamp = ({ relativeName, stamp }: { relativeName: string; stamp: string | null }) => {
    if (stamp === null) hash.update(`${relativeName}:missing\n`);
    else hash.update(`${relativeName.replace(/\\/g, '/').toLowerCase()}:${stamp}\n`);
  };

  const topLevel = await mapLimit(
    [...TOP_LEVEL_INPUTS, join('Audio', 'SoundIndex.json'), join('gltf', 'manifest.json')], READ_CONCURRENCY, stampOf);
  topLevel.forEach(addStamp);

  const addDirectory = async (name: string, accept: (file: string) => boolean) => {
    const dir = join(root, name);
    // An absent directory and an empty one are distinct inputs, and the fingerprint has always told them
    // apart — collapsing them would let a deleted Collision/ hash the same as an emptied one.
    if (!await pathExists(dir)) { hash.update(`${name}:missing\n`); return; }
    const files = (await listEntries(dir))
      .filter(entry => entry.isFile && accept(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
    hash.update(`${name}:count:${files.length}\n`);
    (await mapLimit(files, READ_CONCURRENCY, file => stampOf(join(name, file)))).forEach(addStamp);
  };
  await addDirectory('Meshes', file => file.toLowerCase().endsWith('.obj'));
  await addDirectory('Collision', file => file.toLowerCase().endsWith('.obj'));
  await addDirectory('Textures', file => /^cd\d+\.png$/i.test(file));
  return hash.digest('base64url');
}

const validPayload = (value: unknown, level: string): value is PropsPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<PropsPayload>;
  return payload.level === level && Array.isArray(payload.models)
    && Array.isArray(payload.materials) && Array.isArray(payload.instances);
};

const payloadFromJson = (json: Buffer, level: string): PropsPayload | null => {
  try {
    const value: unknown = JSON.parse(json.toString('utf8'));
    return validPayload(value, level) ? value : null;
  } catch { return null; }
};

const defaultCacheRoot = async () => join((await ensureWorkspace()).workspaceRoot, 'cache', 'reference-props');

/**
 * Read fingerprint-addressed JSON bytes, rebuilding atomically on absence/corruption.
 *
 * The HTTP route deliberately keeps these as bytes: a cold worker can serialize once, transfer its ArrayBuffer,
 * persist it, compress it and send it without cloning a multi-megabyte object into the main isolate or asking
 * that isolate to stringify it again. Cache files live under the workspace, never inside the map library.
 */
export async function readPersistentPropsJson(level: string, levelDir: string,
  build: () => Promise<Uint8Array>, cacheRoot?: string): Promise<PersistentPropsJson> {
  const root = cacheRoot ?? await defaultCacheRoot();
  const fingerprint = await propsPayloadFingerprint(levelDir);
  const cacheFile = join(root, level, `${fingerprint}.json`);
  const cached = await readBytesOrNull(cacheFile);
  if (cached && payloadFromJson(cached, level)) return { json: cached, cache: 'hit', fingerprint };

  const built = await build();
  const json = Buffer.isBuffer(built) ? built
    : built.buffer instanceof ArrayBuffer
      ? Buffer.from(built.buffer, built.byteOffset, built.byteLength)
      : Buffer.from(built);
  try {
    // writeFileAtomic's temporary carries a UUID, so two clients rebuilding the same level concurrently
    // cannot rename over each other's half-written file; both produce the same bytes and the last rename wins.
    await writeFileAtomic(cacheFile, json);
  } catch (error) {
    // The generated response is still valid when a read-only/full cache folder prevents persistence.
    log.warn(`could not persist ${level}`, { error });
  }
  return { json, cache: 'miss', fingerprint };
}

/** Object form for server-side consumers and tests that inspect the payload rather than sending its bytes. */
export async function readPersistentPropsPayload(level: string, levelDir: string,
  build: () => Promise<PropsPayload>, cacheRoot?: string): Promise<PersistentPropsPayload> {
  const stored = await readPersistentPropsJson(level, levelDir,
    async () => Buffer.from(JSON.stringify(await build())), cacheRoot);
  const payload = payloadFromJson(stored.json, level);
  if (!payload) throw new Error(`generated props payload for ${level} was invalid`);
  return { payload, cache: stored.cache, fingerprint: stored.fingerprint };
}
