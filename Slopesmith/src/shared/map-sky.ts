import { readModelGeometries } from './map-props';
import { joinMapPath as join, safeMapName, mapLimit, READ_CONCURRENCY, type MapDataSource } from './map-data';

export interface NativeSkyPayload {
  level: string;
  parts: { positions: number[]; uvs: number[]; indices: number[]; texture: string | null; alphaMode?: string }[];
}

function skyFileName(name: string): string {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name)) throw new Error(`Invalid sky file name: ${name}`);
  return name;
}

/** Mesh backdrops do not need the measured ring used by the panorama authoring tools. */
export async function levelsWithNativeSky(io: MapDataSource): Promise<string[]> {
  const names = (await io.listEntries(io.root)).filter(entry => entry.isDirectory).map(entry => entry.name);
  const admitted = await mapLimit(names, READ_CONCURRENCY, async name => {
    const root = join(io.root, name, 'Skybox');
    const [models, ring] = await Promise.all([
      io.readJsonOr<{ Models?: unknown[] }>(join(root, 'Models.json'), {}),
      io.pathExists(join(root, 'Ring.json')),
    ]);
    return !ring && !!models.Models?.length;
  });
  return names.filter((_name, index) => admitted[index]).sort();
}

/** Prepare the original dome in model-local raw centimetres; texture URLs may be blob URLs or data URLs. */
export async function readNativeSky(
  io: MapDataSource,
  level: string,
  textureUrl?: (path: string) => string,
): Promise<NativeSkyPayload | null> {
  const safe = safeMapName(level),
    root = join(io.root, safe);
  const [models, materials] = await Promise.all([
    io.readJsonOr<{ Models?: unknown[] }>(join(root, 'Skybox', 'Models.json'), {}),
    io.readJsonOr<{ Materials?: { TexturePath?: string; AlphaMode?: string }[] }>(
      join(root, 'Skybox', 'Materials.json'),
      {},
    ),
  ]);
  if (!models.Models?.length) return null;
  const geometries = await readModelGeometries(
    { ...io, root },
    'Skybox',
    new Set(models.Models.map((_model, index) => index)),
  );
  const textures = new Map<string, string | null>();
  const names = [
    ...new Set(
      (materials.Materials ?? []).flatMap(material =>
        material.TexturePath ? [skyFileName(material.TexturePath)] : [],
      ),
    ),
  ];
  await Promise.all(
    names.map(async name => {
      const path = join(root, 'Skybox', 'Textures', name);
      if (textureUrl) {
        textures.set(name, textureUrl(path));
        return;
      }
      const bytes = await io.readBytesOrNull(path);
      if (!bytes) throw new Error(`Missing sky texture ${safe}/${name}`);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      textures.set(name, `data:image/png;base64,${btoa(binary)}`);
    }),
  );
  const parts = [...geometries.values()].flatMap(model =>
    model.subs.map(sub => {
      const material = materials.Materials?.[sub.mat];
      return {
        positions: sub.positions,
        uvs: sub.uvs,
        indices: sub.indices,
        texture: material?.TexturePath ? (textures.get(material.TexturePath) ?? null) : null,
        ...(material?.AlphaMode ? { alphaMode: material.AlphaMode } : {}),
      };
    }),
  );
  return parts.length ? { level: safe, parts } : null;
}

/** Copy a level sky whole. No page splitting or panorama conversion is needed for an original dome. */
export async function nativeSkyFiles(io: MapDataSource, level: string): Promise<{ path: string; bytes: Uint8Array }[]> {
  const root = join(io.root, safeMapName(level), 'Skybox');
  const models = await io.readJsonOr<{ Models?: unknown[] }>(join(root, 'Models.json'), {});
  if (!models.Models?.length) throw new Error(`No native sky for ${level}`);
  const names = ['Models.json', 'Materials.json'];
  for (const folder of ['Meshes', 'Textures'])
    for (const name of await io.listDir(join(root, folder))) names.push(`${folder}/${skyFileName(name)}`);
  return Promise.all(
    names.map(async path => {
      const bytes = await io.readBytesOrNull(join(root, path));
      if (!bytes) throw new Error(`Missing sky file ${path}`);
      return { path: `Skybox/${path}`, bytes };
    }),
  );
}
