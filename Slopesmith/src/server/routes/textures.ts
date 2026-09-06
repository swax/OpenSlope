import { copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapsRoot } from '../workspace-config';
import {
  ensureDir, listDir, listEntries, mapLimit, pathExists, readBytesOrNull, readJsonOr,
  READ_CONCURRENCY,
} from '../fs-async';
import { CUSTOM_TEX_LEVEL, makeTexRef, type LevelTextures, type TexTile } from '../../core/paint/textures';
import type { Rgba } from '../../core/paint/ground-textures';
import type { FalGenerationProvenance } from '../../core/paint/fal-models';
import { decodePng, encodePng } from './png';
import { retargetImportedTexture } from './imported-props';
import { retireName, safeDataName, storeUnderFreeName } from './safe-name';
import { readSlopesmithExportManifest } from './export-manifest';
import { projectAssetPath } from '../project-assets';
import { referenceAssetRevision } from '../reference-asset-revisions';

export { CUSTOM_TEX_LEVEL };

/**
 * Serve the real extracted texture files to the editor's palette as one flat list, most-used-on-terrain
 * first. The tiles are NOT grouped by SurfaceType — that field is physics (ride feel), not the look, so
 * grouping the look by it is meaningless. The count is just each tile's terrain-patch usage (from
 * Patches.json) used to sort the list. Reads Maps/<level>/Textures/*.png + Patches.json off disk.
 */

const PNG = /\.png$/i;
/** Level folders under Maps/ that carry a non-empty Textures/ folder of PNGs. The Custom folder (the
 *  user's own tiles) is excluded — this list is also the export dialog's repack-target menu, and the
 *  Texture Library pins its own Custom entry. */
export async function levelsWithTextures(): Promise<string[]> {
  const candidates = (await listEntries(mapsRoot()))
    .filter(entry => entry.isDirectory && entry.name.toLowerCase() !== CUSTOM_TEX_LEVEL.toLowerCase())
    .map(entry => entry.name);
  const textured = await mapLimit(candidates, READ_CONCURRENCY,
    async name => (await listDir(join(mapsRoot(), name, 'Textures'))).some(f => PNG.test(f)));
  return candidates.filter((_name, index) => textured[index]).sort();
}

const textureDir = (level: string): string => level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()
  ? projectAssetPath('textures') : join(mapsRoot(), safeDataName(level), 'Textures');

/** All PNG file names in a level's Textures/ folder — a level's whole texture bank, slots included. */
export async function textureFiles(level: string): Promise<string[]> {
  return (await listDir(textureDir(level)))
    .filter(f => PNG.test(f)).sort();
}

/** The exact digest ResponseCache will use as this tile's ETag. Metadata routes publish it before image
 * loaders start, so the first byte request already has a permanent content-addressed URL. */
export function referenceTextureRevision(level: string, name: string): Promise<string> {
  const lvl = safeDataName(level);
  return referenceAssetRevision(`texture:${lvl.toLowerCase()}:${name}`,
    () => readReferenceTextureBytes(lvl, name));
}

/** Revisions for the unique texture paths a catalogue or terrain payload is about to expose. */
export async function referenceTextureRevisions(
  level: string, names: Iterable<string>,
): Promise<Record<string, string>> {
  const unique = [...new Set([...names].filter(Boolean))];
  const values = await mapLimit(unique, READ_CONCURRENCY, async name => {
    try { return await referenceTextureRevision(level, name); }
    catch { return null; /* a missing page stays a missing page; it must not keep the terrain from loading */ }
  });
  return Object.fromEntries(unique.flatMap((name, index) => values[index] ? [[name, values[index]]] : []));
}

/** Read a level's Patches.json once: tile -> count of terrain patches that use it. Missing -> empty. */
async function terrainUsage(level: string): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  if (level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()) return usage;
  const json = await readJsonOr<{ Patches?: unknown[] } | null>(join(mapsRoot(), safeDataName(level), 'Patches.json'), null);
  if (!json) return usage;
  const arr = (json.Patches ?? (json as unknown as unknown[])) as Array<Record<string, unknown>>;
  for (const p of arr) {
    const t = p.TexturePath as string | undefined;
    if (!t) continue;
    usage.set(t, (usage.get(t) ?? 0) + 1);
  }
  return usage;
}

/**
 * A level's paintable textures as one flat list: every PNG in Textures/, most-used-on-terrain first
 * (count 0 = a prop/skybox tile never used on terrain, sorted after the terrain tiles by name).
 */
export async function deriveLevelTextures(level: string): Promise<LevelTextures> {
  const lvl = safeDataName(level);
  const [usage, files] = await Promise.all([terrainUsage(lvl), textureFiles(lvl)]);
  const revisions = lvl.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()
    ? {} : await referenceTextureRevisions(lvl, files);
  const tiles: TexTile[] = files
    .map((name): TexTile => ({
      name,
      count: usage.get(name) ?? 0,
      ...(revisions[name] ? { revision: revisions[name] } : {}),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { level: lvl, tiles };
}

/** Read a tile's PNG bytes for serving to the palette and copying at export. */
export async function readTextureBytes(level: string, name: string): Promise<Buffer> {
  const file = join(textureDir(level), safeDataName(name.replace(PNG, '')) + '.png');
  const bytes = await readBytesOrNull(file);
  if (!bytes) throw new Error(`no texture ${level}/${name}`);
  return bytes;
}

async function tryTexture(level: string, name: string): Promise<Buffer | null> {
  try { return await readTextureBytes(level, name); }
  catch { return null; }
}

/** Resolve a Patches.json texture as a reference asset. Authored ISO exports can carry three forms:
 *  a local bare page, a qualified logical dependency (Custom/foo.png or GARI/0012.png), or a bare target
 *  slot whose donor is retained in Slopesmith.json. Prefer the staged local copy so an export stays useful
 *  after its author changes the shared library; fall back to the receiver's configured maps library. */
export async function readReferenceTextureBytes(level: string, name: string): Promise<Buffer> {
  const lvl = safeDataName(level);
  if (lvl.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()) return readTextureBytes(CUSTOM_TEX_LEVEL, name);
  const ref = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const levelDir = join(mapsRoot(), lvl);
  const manifest = await readSlopesmithExportManifest(levelDir);
  const described = manifest?.textures[ref];

  if (described?.staged) {
    const bytes = await tryTexture(lvl, described.staged);
    if (bytes) return bytes;
  }

  const slash = ref.indexOf('/');
  if (slash >= 0) {
    const sourceLevel = safeDataName(ref.slice(0, slash));
    const sourceName = ref.slice(slash + 1);
    // Current exports stage qualified pages under their bare name for Unity and portable reference use.
    const local = await tryTexture(lvl, sourceName);
    if (local) return local;
    const source = await tryTexture(sourceLevel, sourceName);
    if (source) return source;
  } else {
    const local = await tryTexture(lvl, ref);
    if (local) return local;
  }

  if (described) {
    const source = await tryTexture(described.level, described.name);
    if (source) return source;
  }
  throw new Error(`no reference texture ${level}/${name}`);
}

/** Max stored edge for a custom tile — big photos shrink to this. Terrain tiles are 128², so 512 is plenty of
 *  headroom for art the viewport and Unity render at full detail; what a page must shrink to for a disc is a
 *  property of the disc, and `snowknife repack` conforms it there. */
export const MAX_CUSTOM_TEX = 512;

/** Width/height straight out of the IHDR, so sizing a tile never pays for a full decode. */
export function pngSize(bytes: Buffer): { w: number; h: number } {
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

const customTextureDir = () => projectAssetPath('textures');

/**
 * Custom-tile storage and management: store, rename, duplicate, replace, delete. All of it is confined to
 * the open mountain's `assets/textures` folder by construction, and `safeDataName` reduces the caller's stem
 * to the level-asset alphabet, so no argument can address a file outside that project or an extracted bank.
 *
 * A stored tile's name is its identity: storing under a name that is taken lands beside the original as
 * `name_2` (docs/038), and `rename`/`clone` onto a taken name do the same. Deleting a tile retires its name
 * rather than returning it to the pool, and renaming retires the name it moved off, so "Custom/foo.png" names
 * one set of bytes for good rather than only while that file happens to exist — which is what lets painted
 * cells, model materials and HTTP caches all treat the ref as an identity. Deliberately putting new art on an
 * existing tile is `replaceCustomTexture`.
 */
const customTextureStem = (name: string) => safeDataName(name.replace(PNG, '')) || 'texture';
const customTexturePath = (name: string) => join(customTextureDir(), `${customTextureStem(name)}.png`);
const customTextureGenerationPath = (name: string) =>
  join(customTextureDir(), `${customTextureStem(name)}.generation.json`);

const writeGeneration = (file: string, generation?: FalGenerationProvenance) => generation
  ? writeFile(file, JSON.stringify(generation, null, 2) + '\n', 'utf8')
  : Promise.resolve();

const customTileTaken = async (stem: string) => pathExists(join(customTextureDir(), `${stem}.png`));

/**
 * Store an image the user loaded as a paintable tile under the open mountain's `assets/textures/`. The bytes are decoded
 * and re-encoded — normalising every 8-bit PNG flavour to plain RGBA and shrinking anything over
 * MAX_CUSTOM_TEX — so a stored custom tile is the same kind of file the extracted levels carry. Returns the
 * stored file name, which is `name_2.png` and up when the name was already taken.
 */
export async function saveCustomTexture(name: string, bytes: Buffer,
  generation?: FalGenerationProvenance): Promise<string> {
  const png = encodePng(shrinkToFit(decodePng(bytes), MAX_CUSTOM_TEX));
  const { name: stem } = await storeUnderFreeName({
    library: customTextureDir(),
    name: name.replace(PNG, ''),
    fallback: 'texture',
    taken: customTileTaken,
    write: async stored => {
      await ensureDir(customTextureDir());
      await Promise.all([
        writeFile(join(customTextureDir(), `${stored}.png`), png),
        writeGeneration(join(customTextureDir(), `${stored}.generation.json`), generation),
      ]);
    },
  });
  return `${stem}.png`;
}

/**
 * Store a tile that several models are expected to SHARE, reusing the name when the bytes already stored
 * under it are the bytes being written.
 *
 * `saveCustomTexture` never overwrites, and that is exactly right for an upload: two files called `snow`
 * are two different pictures, so the second lands as `snow_2` and no ref ever comes to mean something else
 * (docs/038). A KIT is the case where that rule costs something real. Ten props cut from one atlas embed
 * the identical page ten times, and staging them one at a time spends ten slots of the Custom bank — and
 * later ten pages of a PS2 texture budget — on ten copies of one image.
 *
 * So a name that is taken by THE SAME BYTES is not taken at all: the ref already names them, and answering
 * with it hands out a URL whose content has not changed. Different bytes under that name fall straight
 * through to the ordinary never-overwrite path, and a retired name is still retired, because in neither
 * case would the existing ref be naming what the caller is holding.
 *
 * The comparison runs against the CANONICAL encoding (decoded, shrunk, re-encoded) rather than the caller's
 * bytes, so two exports of one atlas that differ only in their PNG chunking still land as one tile.
 */
export async function saveSharedCustomTexture(name: string, bytes: Buffer): Promise<string> {
  const png = encodePng(shrinkToFit(decodePng(bytes), MAX_CUSTOM_TEX));
  // Whether the stem the loop settled on already holds `png`; decided inside the library's name lock by the
  // same predicate that picks the name, so a concurrent import cannot land between the check and the write.
  let reused = false;
  const { name: stem } = await storeUnderFreeName({
    library: customTextureDir(),
    name: name.replace(PNG, ''),
    fallback: 'texture',
    taken: async candidate => {
      const stored = await readBytesOrNull(join(customTextureDir(), `${candidate}.png`));
      reused = !!stored && stored.equals(png);
      return !!stored && !reused;
    },
    // Rewriting identical bytes would be harmless but not free: it moves the file's mtime, which is what
    // the response cache validates against, so every viewer would refetch a page that did not change.
    write: async stored => {
      if (reused) return;
      await ensureDir(customTextureDir());
      await writeFile(join(customTextureDir(), `${stored}.png`), png);
    },
  });
  return `${stem}.png`;
}

/** True if a Custom tile of this name exists — the client's "name is taken" check. */
export async function customTextureExists(name: string): Promise<boolean> {
  return pathExists(customTexturePath(name));
}

/** Rename a Custom tile. Returns the stored file name, which may differ from `to` after sanitising and after
 *  stepping past a name that is already taken. The name it moves off is retired with the move, because a
 *  rename frees a name exactly the way a delete does. */
export async function renameCustomTexture(from: string, to: string): Promise<string> {
  const source = customTextureStem(from);
  const src = join(customTextureDir(), `${source}.png`);
  if (!await pathExists(src)) throw new Error(`no custom texture ${from}`);
  const stem = safeDataName(to.replace(PNG, ''));
  if (!stem) throw new Error('the new name has no usable characters');
  if (stem.toLowerCase() === source.toLowerCase()) return `${stem}.png`;  // no-op, not a collision
  const { name: free } = await storeUnderFreeName({
    library: customTextureDir(),
    name: stem,
    fallback: stem,
    taken: customTileTaken,
    write: async stored => {
      await rename(src, join(customTextureDir(), `${stored}.png`));
      const generation = customTextureGenerationPath(source);
      if (await pathExists(generation)) {
        await rename(generation, join(customTextureDir(), `${stored}.generation.json`));
      }
    },
    retires: source,
  });
  return `${free}.png`;
}

/** Duplicate a Custom tile under a new name — the "keep this one, then regenerate over the copy" move. */
export async function cloneCustomTexture(from: string, to: string): Promise<string> {
  const src = customTexturePath(from);
  if (!await pathExists(src)) throw new Error(`no custom texture ${from}`);
  const stem = safeDataName(to.replace(PNG, ''));
  if (!stem) throw new Error('the new name has no usable characters');
  const { name: free } = await storeUnderFreeName({
    library: customTextureDir(),
    name: stem,
    fallback: stem,
    taken: customTileTaken,
    write: async stored => {
      await copyFile(src, join(customTextureDir(), `${stored}.png`));
      const generation = customTextureGenerationPath(from);
      if (await pathExists(generation)) {
        await copyFile(generation, join(customTextureDir(), `${stored}.generation.json`));
      }
    },
  });
  return `${free}.png`;
}

/**
 * Put new art on an existing tile: the iterate-on-one-tile loop, as a thing you chose rather than a thing a
 * matching name did to you (docs/038).
 *
 * It is an upload plus a repoint, not a write over the old bytes. The new art is stored under its own free
 * name, everything wearing the old ref is moved onto the new one by the caller, and the old file is removed —
 * retiring its name, since the cleanup is an ordinary delete. So the author gets what overwriting gave them —
 * every model and painted cell wearing the tile shows the new art — while no URL ever answers with different
 * bytes than it did a moment ago, which is what keeps caches out of it. Returns both names so the caller can
 * repoint between them.
 */
export async function replaceCustomTexture(from: string, bytes: Buffer): Promise<{ from: string; to: string }> {
  const stem = safeDataName(from.replace(PNG, ''));
  if (!stem || !await customTextureExists(stem)) throw new Error(`no custom texture ${from}`);
  // The new art asks for the BASE name, not the one it is replacing. A replace can never reuse a name — new
  // bytes need a new ref — but it need not compound one either: replacing `lamp_2` walks the counter on to
  // `lamp_3`, where asking under `lamp_2` would land `lamp_2_2`, then `lamp_2_2_2`. Iterating on one tile is
  // precisely what this function is for, so it is the case that would have gone furthest down that road.
  const to = await saveCustomTexture(stem.replace(/_\d+$/, '') || stem, bytes);
  return { from: `${stem}.png`, to };
}

/**
 * The whole of "put new art on this tile": store it, move every STORED thing wearing the old ref onto the new
 * one, and remove the tile it replaced.
 *
 * `replaceCustomTexture` above is only the first third of that, and the remaining two are not optional — a
 * replace that skipped them would leave imported records pointing at a file this call is about to delete. It
 * lives here as one function because two callers perform it and they must not be able to drift: the Texture
 * Library's **⟳ replace art** (`/api/texture-replace`) and a texture pushed home from Blender (docs/046).
 *
 * The LIVE DOCUMENT's half — painted cells, and the tile an authored model wears — is deliberately not here.
 * It belongs to the browser and goes through history, so both callers hand the returned `{replaced, name}`
 * pair to a client that repoints it as an undoable edit (`retargetDocTex`).
 */
export async function replaceCustomTextureArt(name: string, bytes: Buffer):
Promise<{ name: string; replaced: string; repointed: number }> {
  const { from, to } = await replaceCustomTexture(name, bytes);
  const repointed = await retargetImportedTexture(
    makeTexRef(CUSTOM_TEX_LEVEL, from), makeTexRef(CUSTOM_TEX_LEVEL, to));
  await deleteCustomTexture(from);
  return { name: to, replaced: from, repointed };
}

/** Delete a Custom tile and retire its name, so a later upload called `snow` lands as `snow_2` instead of
 *  answering the URL the deleted tile owned (docs/038). Missing is not an error — the goal state is "gone",
 *  and a double-click on the delete button should not produce a failure the author has to think about; a
 *  tile that was not there frees no name and retires nothing. */
export async function deleteCustomTexture(name: string): Promise<boolean> {
  const stem = customTextureStem(name);
  return retireName(customTextureDir(), stem, async () => {
    const file = join(customTextureDir(), `${stem}.png`);
    if (!await pathExists(file)) return false;
    await Promise.all([
      rm(file, { force: true }),
      rm(customTextureGenerationPath(stem), { force: true }),
    ]);
    return true;
  });
}

/** Bilinear shrink keeping aspect so neither edge exceeds `max`; never upscales. */
export function shrinkToFit(img: Rgba, max: number): Rgba {
  const scale = Math.min(1, max / Math.max(img.w, img.h));
  if (scale >= 1) return img;
  return resample(img, Math.max(1, Math.round(img.w * scale)), Math.max(1, Math.round(img.h * scale)));
}

/** Bilinear resample to an exact size — each edge scales independently, so this does not preserve aspect. */
function resample(img: Rgba, w: number, h: number): Rgba {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = ((y + 0.5) * img.h) / h - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(img.h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = ((x + 0.5) * img.w) / w - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(img.w - 1, x0 + 1), fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const tl = img.data[(y0 * img.w + x0) * 4 + c], tr = img.data[(y0 * img.w + x1) * 4 + c];
        const bl = img.data[(y1 * img.w + x0) * 4 + c], br = img.data[(y1 * img.w + x1) * 4 + c];
        const top = tl + (tr - tl) * fx, bot = bl + (br - bl) * fx;
        out[(y * w + x) * 4 + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return { w, h, data: out };
}

/** Read one sprite from the level-independent PARTICLE.SSH extraction. Prefer the requested level, then the
 * first extracted copy: the shared bank is identical across courses, while authored mountains have no donor. */
export async function readParticleTextureBytes(name: string, preferredLevel = ''): Promise<Buffer> {
  const fileName = safeDataName(name.replace(PNG, '')) + '.png';
  const textured = await levelsWithTextures();
  const levels = preferredLevel ? [safeDataName(preferredLevel), ...textured] : textured;
  // Preference order, so the requested level wins even when a later one also carries the sprite.
  for (const level of new Set(levels)) {
    const bytes = await readBytesOrNull(join(mapsRoot(), level, 'Textures', 'Particles', fileName));
    if (bytes) return bytes;
  }
  throw new Error(`no shared particle texture ${name}`);
}
