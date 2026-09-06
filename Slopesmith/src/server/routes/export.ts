import { randomUUID } from 'node:crypto';
import { cp, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { ensureDir } from '../fs-async';
import { serialize } from '../serialize';
import type { EditDoc } from '../../core/doc/doc-edit';
import { buildExportFolder, exportFolderName } from '../../core/export/folder';
import { DISC_SLOT } from '../../core/export/disc';
import { safeDataName } from '../../core/export/names';
import type { ExportFolder } from '../../core/export/files';
import type { ExportProvider } from '../../core/export/provider';
import type { ModelGeom } from './props';
import { nativeArtSource, readMaterialTables, readModelGeometries } from './props';
import { readCustomSoundBytes } from './sounds';
import {
  listSoundBankLevels, readCourseEffectSoundBytes, readEnvironmentSoundBytes, readNamedEffectSoundBytes, readSoundIndex,
} from './audio';
import { encodePng } from './png';
import { readParticleTextureBytes, readReferenceTextureBytes } from './textures';
import { importedPropsPayload } from './imported-props';
import { groupDefIndex } from './groups';
import { skyboxFiles } from './skybox';
import { stageRaceMusic } from './music';
import { mapsRoot } from '../workspace-config';

/** Manifest and command lines take POSIX separators, which Windows accepts too. */
const slash = (path: string) => path.split(sep).join('/');

/**
 * The node side of the export seam: every byte `buildExportFolder` asks for, read off the extracted library
 * under the configured Maps root.
 *
 * The composition itself is core and knows nothing about a filesystem, so the same folder is built here and
 * in a browser holding the same assets over HTTP. Bound to one destination because two of the answers are
 * about it: the disc recipe's commands name this folder, and staging the race track has to see the `Music/`
 * already there before it can preserve or clear it.
 */
function nodeExportProvider(dir: string): ExportProvider {
  return {
    groupDefs: levels => groupDefIndex(levels),

    async modelGeometry(models) {
      const byLevel = new Map<string, Set<number>>();
      for (const { level, model } of models) {
        let ids = byLevel.get(level);
        if (!ids) byLevel.set(level, ids = new Set());
        ids.add(model);
      }
      // One read per source level rather than one per model: a level's models share meshes heavily, and the
      // reader dedupes them across the whole requested set.
      const geometry = new Map<string, ModelGeom>();
      for (const [level, ids] of byLevel) {
        let read: Map<number, ModelGeom>;
        try { read = await readModelGeometries(level, ids); } catch { continue; } // a missing level ships nothing
        for (const [id, mg] of read) geometry.set(`${safeDataName(level)}:${id}`, mg);
      }
      return (level, model) => geometry.get(`${safeDataName(level)}:${model}`) ?? null;
    },

    materialTables: () => readMaterialTables(),
    importedProps: () => importedPropsPayload(),
    nativeArt: () => nativeArtSource(),
    referenceTexture: (level, name) => readReferenceTextureBytes(level, name),
    particleTexture: (name, donorLevel) => readParticleTextureBytes(name, donorLevel),
    customSound: file => readCustomSoundBytes(file),
    soundIndex: async level => {
      const source = level?.trim() || (await listSoundBankLevels())[0];
      return source ? readSoundIndex(source) : null;
    },
    courseEffectSound: (level, slot, bank) => readCourseEffectSoundBytes(level, slot, bank),
    namedEffectSound: (level, slot, bank) => readNamedEffectSoundBytes(level, slot, bank),
    environmentEffectSound: (bank, slot, loop) => readEnvironmentSoundBytes(bank, slot, loop),
    skybox: sky => skyboxFiles(sky),
    encodePng: async image => encodePng(image),
    stageRaceMusic: (selection, arrangement) => stageRaceMusic(selection, dir, arrangement),

    async discRecipePaths() {
      const levelData = join(mapsRoot(), DISC_SLOT);
      return {
        exportDir: slash(dir),
        levelData: slash(levelData),
        levelDataRelative: slash(relative(dir, levelData) || '.'),
      };
    },
  };
}

/** Apply one composed export to a private tree. `dir` is never the live destination. */
async function applyExportFolder(dir: string, folder: ExportFolder): Promise<void> {
  for (const path of folder.remove) await rm(join(dir, ...path.split('/')), { recursive: true, force: true });
  const made = new Set<string>();
  const ensure = async (target: string) => {
    if (made.has(target)) return;
    await ensureDir(target);
    made.add(target);
  };
  await ensure(join(dir, 'Textures'));   // every export carries one, painted or not
  for (const file of folder.files) {
    const full = join(dir, ...file.path.split('/'));
    await ensure(dirname(full));
    await writeFile(full, file.bytes);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Replace the owned export content transactionally while preserving files the exporter does not own.
 *
 * The complete next tree is prepared beside the destination. Only after every removal and write succeeds is the
 * previous tree renamed aside and the staged tree renamed into its place. A failed commit restores the previous
 * directory; an interrupted commit still leaves that complete directory under the adjacent backup name.
 */
export async function writeExportFolder(dir: string, folder: ExportFolder): Promise<void> {
  const parent = dirname(dir);
  const leaf = basename(dir);
  const token = `${process.pid}-${randomUUID()}`;
  const staging = join(parent, `.${leaf}.export-staging-${token}`);
  const backup = join(parent, `.${leaf}.export-backup-${token}`);
  await ensureDir(parent);
  const hadPrevious = await pathExists(dir);

  try {
    if (hadPrevious) await cp(dir, staging, { recursive: true, errorOnExist: true, force: false });
    else await ensureDir(staging);
    await applyExportFolder(staging, folder);

    if (hadPrevious) await rename(dir, backup);
    try {
      await rename(staging, dir);
    } catch (commitError) {
      if (hadPrevious) {
        try { await rename(backup, dir); }
        catch (restoreError) {
          throw new AggregateError([commitError, restoreError], `Export commit and rollback both failed for ${dir}`,
            { cause: restoreError });
        }
      }
      throw commitError;
    }

    // The new tree is live. A cleanup failure must not report the committed export as failed; the uniquely named
    // backup is complete and can be removed on the next housekeeping pass.
    if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export interface ExportResult {
  dir: string;
  log: string;
}

/**
 * Write the authored level folder to disk through the node byte provider.
 *
 * What the folder contains is decided by `buildExportFolder`, against no particular target; this supplies the
 * bytes it asks for and the destination it lands in. The editor exports in the browser against the same
 * composition, so this is the headless path — what `npm run smoke` bakes a real `snowknife gltf` over, and what
 * the export tests assert against — rather than a second implementation of it.
 */
export async function exportLevel(doc: EditDoc, opts?: {
  outDir?: string; lighting?: boolean; aiPaths?: boolean;
}): Promise<ExportResult> {
  const name = exportFolderName(doc);
  const dir = opts?.outDir ?? join(mapsRoot(), name);
  // One export at a time. Two concurrent runs interleave writes into the same level folder, so the second
  // observes the first one's half-written files. Exports are deliberate, infrequent acts, and queueing them
  // costs a wait rather than a corrupted map folder.
  return serialize('export', async () => {
    const folder = await buildExportFolder(doc, nodeExportProvider(dir),
      { lighting: opts?.lighting, aiPaths: opts?.aiPaths });
    await writeExportFolder(dir, folder);
    return { dir, log: folder.log.join('\n') };
  });
}
