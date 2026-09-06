import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mapsRoot } from '../workspace-config';
import {
  ensureDir, listDir, listEntries, mapLimit, pathExists, readBytesOrNull, readJsonOr, READ_CONCURRENCY,
} from '../fs-async';
import { decodePng, encodePng } from './png';
import type { Rgba } from '../../core/paint/ground-textures';
import type { ExportFile } from '../../core/export/files';
import type { SkyboxDoc } from '../../core/doc/types';
import type { FalGenerationProvenance } from '../../core/paint/fal-models';
import {
  AUTHORING_SKY_GEOMETRY, SKY_TIERS, panoramaSize, skyRingFromDocument, type SkyRing,
} from '../../core/sky/ring';
import { deriveGroundTile, fitToBand, stitchPanorama } from '../../core/sky/slice';
import { composeSkybox, type SkyboxPageSource } from '../../core/export/skybox';
import { safeDataName, storeUnderFreeName } from './safe-name';
import { projectAssetCacheKey, projectAssetPath } from '../project-assets';
import { referenceAssetRevision } from '../reference-asset-revisions';

/**
 * Serve skyboxes to the editor: the shipped ones a level was extracted with (Maps/<L>/Skybox/), and the
 * panoramas the author loads into the current mountain. Both reach the client as ONE stitched panorama PNG —
 * the horizon band unrolled — which is what the Skybox panel previews and what the viewport wraps round its
 * backdrop cylinder. The measured page split only re-appears at export.
 *
 * A custom sky is normalised to a band panorama the moment it is loaded, so everything downstream (preview,
 * viewport, export, repack) reads one predictable image regardless of what was dropped on it.
 */

/** Where this mountain's own panoramas live. */
const skiesDir = () => projectAssetPath('skies');

/** Level folders that ship an extracted skybox and its measured composition sidecar. */
export async function levelsWithSkybox(): Promise<string[]> {
  const dirs = (await listEntries(mapsRoot())).filter(entry => entry.isDirectory).map(entry => entry.name);
  const shipped = await mapLimit(dirs, READ_CONCURRENCY, async name => {
    const sky = join(mapsRoot(), name, 'Skybox');
    const [meshes, textures, ring] = await Promise.all([
      pathExists(join(sky, 'Meshes')), pathExists(join(sky, 'Textures')), pathExists(join(sky, 'Ring.json')),
    ]);
    return meshes && textures && ring;
  });
  return dirs.filter((_name, index) => shipped[index]).sort();
}

/** The panoramas owned by the open mountain, by bare name. */
export async function listCustomSkies(): Promise<string[]> {
  return (await listDir(skiesDir())).filter(f => /\.png$/i.test(f)).map(f => f.replace(/\.png$/i, '')).sort();
}

/** Read the metadata Snowknife measured from this level's extracted OBJ/PNG files. */
export async function readSkyRing(level: string): Promise<SkyRing> {
  const safe = safeDataName(level);
  const raw = await readJsonOr<unknown>(join(mapsRoot(), safe, 'Skybox', 'Ring.json'), null);
  const ring = skyRingFromDocument(raw);
  if (!ring) throw new Error(`${safe}/Skybox/Ring.json is missing or invalid — rerun \`snowknife skybox\``);
  return ring;
}

/** One of a level's measured sky pages, decoded. */
export async function readSkyTile(level: string, index: number): Promise<Rgba> {
  const file = join(mapsRoot(), safeDataName(level), 'Skybox', 'Textures', String(index).padStart(4, '0') + '.png');
  const bytes = await readBytesOrNull(file);
  if (!bytes) throw new Error(`no sky tile ${level}/${index}`);
  return decodePng(bytes);
}

/** A level's sky, unrolled: its measured wall panels stitched back into one horizon panorama at their real
 *  azimuth spans. The in-flight stitch is cached, not just its result, so several clients opening the same
 *  level share one pass over the pages instead of each decoding and stitching their own. */
const panoCache = new Map<string, Promise<Buffer>>();

/** A Maps watcher invalidation must reach the stitched source cache as well as the HTTP response cache. */
export function invalidateReferenceSkyCache(level?: string): void {
  if (level) panoCache.delete(safeDataName(level));
  else panoCache.clear();
}

export function readLevelPanorama(level: string): Promise<Buffer> {
  const safe = safeDataName(level);
  let pending = panoCache.get(safe);
  if (!pending) {
    pending = stitchLevelPanorama(safe);
    panoCache.set(safe, pending);
    void pending.catch(() => { if (panoCache.get(safe) === pending) panoCache.delete(safe); });
  }
  return pending;
}

export function readLevelPanoramaRevision(level: string): Promise<string> {
  const safe = safeDataName(level);
  return referenceAssetRevision(`skypano:${safe.toLowerCase()}`, async () => {
    const ring = await readSkyRing(safe);
    const ringBytes = await readBytesOrNull(join(mapsRoot(), safe, 'Skybox', 'Ring.json'));
    if (!ringBytes) throw new Error(`no sky ring for ${safe}`);
    const indexes = [...new Set(ring.panels.map(panel => panel.index))];
    const pages = await mapLimit(indexes, READ_CONCURRENCY, async index => {
      try { return await readSkyPageBytes(safe, index); }
      catch { return null; /* stitchLevelPanorama renders this same missing page as a gap */ }
    });
    const chunks: Buffer[] = [ringBytes];
    indexes.forEach((index, at) => {
      const page = pages[at];
      chunks.push(Buffer.from(`\npage:${index}:${page?.length ?? -1}\n`));
      if (page) chunks.push(page);
    });
    return Buffer.concat(chunks);
  });
}

async function stitchLevelPanorama(safe: string): Promise<Buffer> {
  const ring = await readSkyRing(safe);
  const loaded = await mapLimit(ring.panels, READ_CONCURRENCY, async p => {
    try { return [p.index, await readSkyTile(safe, p.index)] as const; }
    catch { return [p.index, null] as const; /* a missing page draws as a gap */ }
  });
  const tiles: (Rgba | null)[] = Array.from({ length: ring.tiles.length }, () => null);
  for (const [index, tile] of loaded) tiles[index] = tile;
  // size the panorama off the level's own upper tiles, so a stitch never throws away resolution
  const upperIndex = ring.panels.find(panel => panel.band === 'upper')!.index;
  const upper = ring.tiles[upperIndex]?.w ?? SKY_TIERS.standard.upper;
  const { w, h } = panoramaSize(upper, ring);
  return encodePng(stitchPanorama(tiles, ring, w, h));
}

/** A level's measured ground-disc page — the aerial view of the terrain below the horizon. Served alongside the
 *  panorama because it is a different projection (radial, looking straight down) and can't be stitched into
 *  the band. */
export async function readLevelGroundPng(level: string): Promise<Buffer> {
  const safe = safeDataName(level);
  const ring = await readSkyRing(safe);
  const file = join(mapsRoot(), safe, 'Skybox', 'Textures', String(ring.groundIndex).padStart(4, '0') + '.png');
  const bytes = await readBytesOrNull(file);
  if (!bytes) throw new Error(`no ground disc for ${level}`);
  return bytes;
}

export function readLevelGroundRevision(level: string): Promise<string> {
  const safe = safeDataName(level);
  return referenceAssetRevision(`skyground:${safe.toLowerCase()}`, () => readLevelGroundPng(safe));
}

/** A custom sky has no aerial photo of the ground below it, so its disc is DERIVED from the panorama's
 *  bottom edge — the same cut the export makes, so the editor shows exactly what ships. */
const groundCache = new Map<string, Promise<Buffer>>();

export function readCustomGroundPng(name: string, preferredRing = ''): Promise<Buffer> {
  const safe = safeDataName(name);
  const key = projectAssetCacheKey(`skyground:${safe}:${safeDataName(preferredRing)}`);
  let pending = groundCache.get(key);
  if (!pending) {
    pending = deriveCustomGround(safe, preferredRing);
    groundCache.set(key, pending);
    void pending.catch(() => { if (groundCache.get(key) === pending) groundCache.delete(key); });
  }
  return pending;
}

async function deriveCustomGround(safe: string, preferredRing: string): Promise<Buffer> {
  const ring = await optionalSkyRing(preferredRing);
  return encodePng(deriveGroundTile(
    decodePng(await readCustomSkyPng(safe)), SKY_TIERS.high.ground, ring ?? AUTHORING_SKY_GEOMETRY));
}

const skyFile = (name: string) => join(skiesDir(), safeDataName(name) + '.png');

/**
 * Take an image the user loaded and keep it as a sky. Whatever came in — a wide strip, a 2:1 equirect, a
 * square, a screenshot — is re-projected into the ring band (fitToBand) before it is stored, so from here on
 * every sky in the system is the same kind of image. A name that is taken lands beside the original as
 * `name_2` rather than over it (docs/038), which is also what keeps the derived-ground cache above honest:
 * a stored panorama's bytes never change under it. Returns the stored name.
 */
export async function saveCustomSky(name: string, bytes: Buffer,
  fit: 'auto' | 'band' | 'equirect' = 'auto', preferredRing = '',
  generation?: FalGenerationProvenance): Promise<string> {
  const src = decodePng(bytes);
  const ring = await optionalSkyRing(preferredRing);
  // Without any extracted map, use a plainly generic authoring canvas. Export later re-samples it against
  // the selected map's measured ring; no retail geometry is needed merely to keep a user's panorama.
  const { w, h } = ring ? panoramaSize(SKY_TIERS.high.upper, ring) : { w: 2048, h: 512 };
  const band = encodePng(fitToBand(src, w, h, ring ?? AUTHORING_SKY_GEOMETRY, fit));
  const { name: safe } = await storeUnderFreeName({
    library: skiesDir(),
    name,
    fallback: 'sky',
    taken: candidate => pathExists(skyFile(candidate)),
    write: async stored => {
      await ensureDir(skiesDir());
      await Promise.all([
        writeFile(skyFile(stored), band),
        generation
          ? writeFile(join(skiesDir(), `${safeDataName(stored)}.generation.json`),
            JSON.stringify(generation, null, 2) + '\n', 'utf8')
          : Promise.resolve(),
      ]);
    },
  });
  return safe;
}

export async function readCustomSkyPng(name: string): Promise<Buffer> {
  const bytes = await readBytesOrNull(skyFile(name));
  if (!bytes) throw new Error(`no sky "${name}"`);
  return bytes;
}

/**
 * The level whose ring an authored sky's pages are cut for: a level sky brings its own; a custom sky names the
 * ring it was composed against (`SkyboxDoc.ring`), falling back to any level that ships one. The browser asks
 * for the same answer over `/api/skybox/ring`, so both providers cut against the same geometry.
 */
export async function resolveSkyRingLevel(preferred: string): Promise<string> {
  const shipped = await levelsWithSkybox();
  const wanted = preferred ? safeDataName(preferred) : '';
  const ringLevel = wanted && shipped.includes(wanted) ? wanted : shipped[0];
  if (!ringLevel || !shipped.includes(ringLevel))
    throw new Error(`sky "${wanted || '?'}" has no extracted Skybox/ — run \`snowknife import\` on a level that ships one`);
  return ringLevel;
}

async function optionalSkyRing(preferred = ''): Promise<SkyRing | null> {
  try { return await readSkyRing(await resolveSkyRingLevel(preferred)); }
  catch { return null; }
}

/** A ring level's `Skybox/` shell — Models.json, Materials.json and every mesh — addressed for an export. */
export async function readSkyRingFiles(ringLevel: string): Promise<ExportFile[]> {
  const srcDir = join(mapsRoot(), ringLevel, 'Skybox');
  const read = async (...parts: string[]): Promise<Buffer> => {
    const file = join(srcDir, ...parts);
    const bytes = await readBytesOrNull(file);
    if (!bytes) throw new Error(`skybox source missing: ${file}`);
    return bytes;
  };
  const files: ExportFile[] = [];
  const ringParts = ['Models.json', 'Materials.json', 'Ring.json'];
  const ringBytes = await mapLimit(ringParts, READ_CONCURRENCY, f => read(f));
  ringParts.forEach((f, i) => files.push({ path: `Skybox/${f}`, bytes: ringBytes[i] }));
  const meshNames = await listDir(join(srcDir, 'Meshes'));
  const meshBytes = await mapLimit(meshNames, READ_CONCURRENCY, f => read('Meshes', f));
  meshNames.forEach((f, i) => files.push({ path: `Skybox/Meshes/${f}`, bytes: meshBytes[i] }));
  return files;
}

/** One of a level's measured sky pages as it ships, for an export that lifts the bank verbatim. */
export async function readSkyPageBytes(level: string, index: number): Promise<Buffer> {
  const file = join(mapsRoot(), safeDataName(level), 'Skybox', 'Textures',
    String(index).padStart(4, '0') + '.png');
  const bytes = await readBytesOrNull(file);
  if (!bytes) throw new Error(`skybox source missing: ${file}`);
  return bytes;
}

export function readSkyPageRevision(level: string, index: number): Promise<string> {
  const safe = safeDataName(level);
  return referenceAssetRevision(`sky-page:${safe.toLowerCase()}:${index}`, () => readSkyPageBytes(safe, index));
}

/** The authored sky as an extracted level's `Skybox/` (docs/025), read off the map library. What the folder
 *  contains is `composeSkybox`; this finds the ring and the bytes it cuts. */
export async function skyboxFiles(sky: SkyboxDoc): Promise<{ files: ExportFile[]; log: string[] }> {
  const ringLevel = await resolveSkyRingLevel(sky.source.kind === 'level' ? sky.source.level : sky.ring ?? '');
  const [ringFiles, ring] = await Promise.all([readSkyRingFiles(ringLevel), readSkyRing(ringLevel)]);
  const pages: SkyboxPageSource = sky.source.kind === 'level'
    ? { kind: 'level', pages: await mapLimit(
      Array.from({ length: ring.tiles.length }, (_unused, i) => i), READ_CONCURRENCY,
      i => readSkyPageBytes(ringLevel, i)) }
    : { kind: 'custom', panorama: decodePng(await readCustomSkyPng(sky.source.name)) };
  return composeSkybox(sky, { ringLevel, ringFiles, ring, pages }, async image => encodePng(image));
}

/** Stage a sky straight into a level folder. The subtree is a complete snapshot, so it is cleared first: a
 *  retired or renamed page cannot survive from a previous export under this directory. */
export async function exportSkybox(dir: string, sky: SkyboxDoc): Promise<string[]> {
  const { files, log } = await skyboxFiles(sky);
  await rm(join(dir, 'Skybox'), { recursive: true, force: true });
  const made = new Set<string>();
  for (const file of files) {
    const full = join(dir, ...file.path.split('/'));
    const parent = dirname(full);
    if (!made.has(parent)) { await ensureDir(parent); made.add(parent); }
    await writeFile(full, file.bytes);
  }
  return log;
}
