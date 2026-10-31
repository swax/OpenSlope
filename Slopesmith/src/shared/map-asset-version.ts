import { assetMapKey, assetVersion, type AssetVersion } from '../core/reference/asset-version';
import { mapGame } from '../core/reference/map-game';
import { joinMapPath as join, mapLimit, READ_CONCURRENCY, type MapDataSource } from './map-data';
import { listLevelOrigins } from './map-levels';

/** Only consumed asset-bank data: raw disc archives, terrain, baked companions and music are excluded. */
export function assetBankFile(path: string): boolean {
  const name = path.toLowerCase();
  if (/^(textures|meshes|collision)\//.test(name)) return true;
  if (name.startsWith('audio/') && !/^audio\/(music|intro)(\/|$)/.test(name)) return true;
  return (
    !name.includes('/') &&
    name.endsWith('.json') &&
    ![
      'origin.json',
      'import.json',
      'slopesmith.json',
      'patches.json',
      'aip.json',
      'sop.json',
      'splines.json',
      'world.json',
      'playtestimport.json',
      'soundbindings.json',
    ].includes(name)
  );
}

export async function assetBankFiles(io: MapDataSource, level: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (path: string) => {
    for (const entry of await io.listEntries(join(io.root, level, path))) {
      const next = join(path, entry.name);
      if (entry.isDirectory) {
        if (/^(textures|meshes|collision|audio)(\/|$)/i.test(next) && !/^audio\/(music|intro)(\/|$)/i.test(next))
          await walk(next);
      } else if (assetBankFile(next)) result.push(next);
    }
  };
  await walk('');
  return result.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

const utf8 = new TextEncoder();
export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function readAssetVersion(
  io: MapDataSource,
  level: string,
  files?: readonly string[],
  onFile?: (path: string, hash: string) => void,
): Promise<AssetVersion> {
  const metadata = (await listLevelOrigins(io, [level]))[0] ?? { name: level };
  const selected = files ?? (await assetBankFiles(io, level));
  if (!selected.length) throw new Error(`No prop or texture assets are available in ${level}.`);
  const hashes = await mapLimit([...selected], READ_CONCURRENCY, async path => {
    let bytes = await io.readBytesOrNull(join(io.root, level, path));
    if (!bytes) throw new Error(`Missing asset ${level}/${path}`);
    if (path.toLowerCase().endsWith('.json')) {
      const document = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      bytes = utf8.encode(JSON.stringify(canonical(document)));
    } else if (path.toLowerCase().endsWith('.obj'))
      bytes = utf8.encode(new TextDecoder().decode(bytes).replace(/\r\n/g, '\n'));
    const hash = await sha256(bytes);
    onFile?.(path.toLowerCase(), hash);
    return [path.toLowerCase(), hash];
  });
  const hash = await sha256(utf8.encode(JSON.stringify(['openslope-asset-bank/v1', hashes])));
  return assetVersion(mapGame(metadata), assetMapKey(level, metadata.course), hash);
}
