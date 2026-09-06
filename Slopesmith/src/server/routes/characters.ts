import { constants } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWorkspace, mapsRoot } from '../workspace-config';
import { ensureDir, listDir, pathExists, writeJsonAtomic } from '../fs-async';
import { safeDataName } from './safe-name';

const GLB = /\.glb$/i;
let prepared: { root: string; ready: Promise<string> } | null = null;

/** Server-wide rider avatars live with server data rather than with reference maps or one mountain. The first
 * access copies legacy `Maps/Custom/Characters/*.glb` files without deleting or overwriting anything. */
export async function characterLibraryDir(): Promise<string> {
  const workspace = await ensureWorkspace();
  const root = join(workspace.workspaceRoot, 'library', 'characters');
  if (prepared?.root === root) return prepared.ready;
  const ready = (async () => {
    await ensureDir(root);
    const marker = join(root, '.legacy-migrated-v1.json');
    if (!await pathExists(marker)) {
      const legacy = join(mapsRoot(), 'Custom', 'Characters');
      const copied: string[] = [];
      for (const file of (await listDir(legacy)).filter(name => GLB.test(name))) {
        try {
          await copyFile(join(legacy, file), join(root, file), constants.COPYFILE_EXCL);
          copied.push(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      await writeJsonAtomic(marker, { schema: 1, migratedAt: new Date().toISOString(), copied });
    }
    return root;
  })();
  prepared = { root, ready };
  void ready.catch(() => { if (prepared?.ready === ready) prepared = null; });
  return ready;
}

export interface CharacterModelEntry {
  /** Stable selection/persistence id. It is also the file name requested from /api/character-model. */
  id: string;
  file: string;
  label: string;
}

function characterLabel(file: string): string {
  const stem = file.replace(GLB, '').replace(/[-_](?:rigged|character)$/i, '');
  const words = stem.split(/[-_]+/).filter(Boolean);
  return words.map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ') || file;
}

/** Every top-level GLB in the server's `library/characters` folder appears in Play's Rider model picker. */
export async function listCharacterModels(): Promise<CharacterModelEntry[]> {
  return (await listDir(await characterLibraryDir()))
    .filter(file => GLB.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map(file => ({ id: file, file, label: characterLabel(file) }));
}

/** Read only a file that the flat character catalog actually contains; no caller-controlled path segments. */
export async function readCharacterModelBytes(name: string): Promise<Buffer> {
  const stem = safeDataName(name.replace(GLB, ''));
  if (!stem) throw new Error(`invalid character model ${name}`);
  const match = (await listCharacterModels()).find(entry => entry.file.toLowerCase() === `${stem}.glb`.toLowerCase());
  if (!match) throw new Error(`no character model ${name}`);
  return readFile(join(await characterLibraryDir(), match.file));
}
