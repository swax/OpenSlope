import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { referenceFilePath } from '../../shared/reference-transfer';
import { safeMapName } from '../../shared/map-data';
import { resolveServerMapName } from '../reference-map-paths';
import { mapsRoot } from '../workspace-config';
import { jsonResponse, type ApiHandler } from './common';

/** Read portable course files for browser packaging, under the same access rules as reference assets. */
export const mapFileRoutes: Record<string, ApiHandler> = {
  '/api/map-files': async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (req.method !== 'GET') {
      jsonResponse(res, 405, { error: 'GET only.' });
      return;
    }
    try {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const requested = q.get('level') ?? '';
      const level = safeMapName(requested);
      if (!level || level !== requested) throw new Error('Invalid map name.');
      const root = join(mapsRoot(), await resolveServerMapName(level));
      if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Map not found.');
      const path = q.get('path');
      if (path !== null) {
        if (!referenceFilePath(path)) throw new Error('Invalid map file path.');
        let file = root;
        for (const part of path.split('/')) {
          file = join(file, part);
          if ((await lstat(file)).isSymbolicLink()) throw new Error('Map links cannot be exported.');
        }
        if (!(await lstat(file)).isFile()) throw new Error('Map file not found.');
        res.setHeader('content-type', 'application/octet-stream');
        res.end(await readFile(file));
        return;
      }
      const files: string[] = [];
      async function walk(directory: string, prefix = '') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = `${prefix}${entry.name}`;
          if (
            entry.isDirectory() &&
            (prefix || /^(Textures|Lightmaps|Meshes|Collision|Skybox|Audio|Source)$/.test(entry.name))
          )
            await walk(join(directory, entry.name), `${path}/`);
          else if (entry.isFile() && referenceFilePath(path)) files.push(path);
        }
      }
      await walk(root);
      if (!files.includes('Patches.json')) throw new Error('This map has no Patches.json.');
      jsonResponse(res, 200, { files: files.sort() });
    } catch (error) {
      const filesystemError = !!(error as NodeJS.ErrnoException)?.code;
      jsonResponse(res, filesystemError ? 404 : 400, {
        error: filesystemError ? 'Map file not found.' : error instanceof Error ? error.message : String(error),
      });
    }
  },
};
