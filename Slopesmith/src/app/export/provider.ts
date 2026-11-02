import type { SkyboxDoc } from '../../core/doc/types';
import { AUTHORED_MODEL_LEVEL } from '../../core/doc/models';
import { IMPORTED_PROP_LEVEL } from '../../core/props/imported';
import { DISC_SLOT, type DiscRecipePaths } from '../../core/export/disc';
import type { ExportFile } from '../../core/export/files';
import { safeDataName } from '../../core/export/names';
import type { SourceMaterial } from '../../core/export/materials';
import type { GeometryLookup, ModelGeometry } from '../../core/export/props';
import type { ExportProvider, NativeArt } from '../../core/export/provider';
import { composeSkybox, type SkyboxPageSource } from '../../core/export/skybox';
import type { GroupDef, GroupsPayload } from '../../core/reference/groups';
import { decodeProps, type PropsPayload } from '../../core/reference/props';
import type { SkyRing } from '../../core/sky/ring';
import { assetBytes as defaultAssetBytes } from '../net/asset-bytes';
import { safeDataName as assetTableKey } from '../../core/export/names';
import {
  customSkyUrl,
  effectSoundUrl,
  environmentSoundUrl,
  customSoundUrl,
  particleTextureUrl,
  skyPageUrl,
  textureUrl,
} from '../net/asset-paths';
import { fetchJson as defaultFetchJson } from '../net/fetch-json';
import { findSkyLevel, type SkyCatalogue } from '../../core/sky/catalogue';
import { decodePng, encodePng } from './png';
import { stageRaceMusic } from './music';
import type { CollisionSoundIndex } from '../../core/effects/collision-sound';

/**
 * The browser side of the export seam: every byte `buildExportFolder` asks for, fetched from the routes that
 * already serve the editor.
 *
 * There is one composition and two providers. The server reads the extracted library off disk; this reads the
 * same library over HTTP, so the folder an author writes from the editor and the folder `npm run smoke` bakes
 * are built by the same code from the same bytes. Nothing here decides what a map folder contains.
 *
 * Two rules shape it. Copied art passes through **untouched** — a painted tile, a prop texture, a shipped sky
 * page and a hit sound all arrive as bytes through the cache and land as those bytes, because a page decoded
 * to a canvas and re-encoded is a different file. And every answer a bake reads synchronously — material
 * tables, model geometry, group defs — is fetched up front, whole, because the emission loops cannot reach
 * back out for a byte mid-triangle.
 */
export interface BrowserExportOptions {
  assetLevels?: readonly string[];
  /** The named map folder inside the .snowknife.zip download. */
  folderName: string;
  /** Whether the destination already holds a file — what tells race-music staging that there is a track to
   *  preserve or to clear. A download has nothing to look at, so it answers false. */
  existingFile: (path: string) => Promise<boolean>;
  /** A library-row export reads its own mountain without changing the active editor/player workspace. */
  request?: (url: string) => Promise<Response>;
}

export function browserExportProvider(opts: BrowserExportOptions): ExportProvider {
  const fetchJson = opts.request
    ? async <T>(url: string): Promise<T> => {
        const response = await opts.request!(url);
        if (!response.ok) throw new Error((await response.text()) || `Could not read ${url}`);
        return response.json() as Promise<T>;
      }
    : defaultFetchJson;
  const assetBytes = opts.request
    ? async (url: string): Promise<Uint8Array> => {
        const response = await opts.request!(url);
        if (!response.ok) throw new Error((await response.text()) || `Could not read ${url}`);
        return new Uint8Array(await response.arrayBuffer());
      }
    : defaultAssetBytes;
  const asset = (path: string, params: Record<string, string | number>, ordinary: () => string) =>
    assetBytes(
      opts.request
        ? `${path}?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`
        : ordinary(),
    );
  // A level's prop payload is megabytes of geometry and an export asks for one twice — once for the placed
  // models, once for the gem crystals — so it is read once per export and answered from here after that.
  const propsByLevel = new Map<string, Promise<PropsPayload>>();
  const levelProps = (level: string): Promise<PropsPayload> => {
    let pending = propsByLevel.get(level);
    if (!pending) {
      pending = fetchJson<PropsPayload>(`/api/props?level=${encodeURIComponent(level)}`)
        .then(payload => {
          if (!Array.isArray(payload?.models) || !Array.isArray(payload.materials) || !Array.isArray(payload.instances))
            throw new Error('The source did not return a prop geometry payload.');
          return payload;
        })
        .catch((cause: unknown) => {
          throw new Error(
            `Could not load prop geometry for ${level}. Make its source map available before exporting.`,
            {
              cause,
            },
          );
        });
      propsByLevel.set(level, pending);
    }
    return pending;
  };
  const soundIndexes = new Map<string, Promise<CollisionSoundIndex | null>>();
  const soundIndex = (level?: string): Promise<CollisionSoundIndex | null> => {
    const key = level?.trim().toUpperCase() || '*';
    let pending = soundIndexes.get(key);
    if (!pending) {
      pending = (async () => {
        let source = level?.trim() ?? '';
        if (!source) {
          const body = await fetchJson<{ levels?: string[] }>('/api/sound-banks');
          source = body.levels?.[0] ?? '';
        }
        if (!source) return null;
        const body = await fetchJson<{ soundIndex?: CollisionSoundIndex }>(
          `/api/sound-banks?level=${encodeURIComponent(source)}`,
        );
        return body.soundIndex ?? null;
      })().catch(() => null);
      soundIndexes.set(key, pending);
    }
    return pending;
  };

  return {
    async groupDefs(levels) {
      const payloads = await Promise.all(
        levels.map(level => fetchJson<GroupsPayload>(`/api/groups?level=${encodeURIComponent(level)}`)),
      );
      const index = new Map<string, GroupDef>();
      for (const payload of payloads)
        for (const group of payload.groups) index.set(`${group.level}:${group.id}`, group);
      return index;
    },

    async modelGeometry(models) {
      const levels = [
        ...new Set(
          models
            .map(({ level }) => level)
            .filter(level => level !== AUTHORED_MODEL_LEVEL && level !== IMPORTED_PROP_LEVEL),
        ),
      ];
      // One payload per source level, fetched together. `/api/props` is the same `readModelGeometries` the
      // server bakes from, so a submesh's `{mat, positions, uvs, indices}` arrives ready to emit. A level with
      // no prop table — the '@models' and '@import' pseudo-levels, which carry their geometry on the document
      // and in the imported catalogue — simply contributes nothing.
      const payloads = await Promise.all(levels.map(levelProps));
      const geometry = new Map<string, ModelGeometry>();
      for (const [index, payload] of payloads.entries()) {
        for (const model of decodeProps(payload).models)
          geometry.set(`${safeDataName(levels[index])}:${model.id}`, {
            subs: model.subs,
            collision: model.collision,
            rotation: model.rotation,
            animation: model.animation,
          });
      }
      const lookup: GeometryLookup = (level, model) => geometry.get(`${safeDataName(level)}:${model}`) ?? null;
      return lookup;
    },

    async materialTables() {
      const { tables } = await fetchJson<{ tables: Record<string, SourceMaterial[]> }>('/api/props/materials');
      for (const level of opts.assetLevels ?? []) {
        const value = await fetchJson<{ tables: Record<string, SourceMaterial[]> }>(
          `/api/props/materials?level=${encodeURIComponent(level)}`,
        );
        if (value.tables[assetTableKey(level)]) tables[assetTableKey(level)] = value.tables[assetTableKey(level)];
      }
      return new Map(Object.entries(tables));
    },

    importedProps: () => fetchJson<PropsPayload>('/api/custom-props'),
    nativeArt: () => fetchJson<NativeArt>('/api/props/native-art'),
    referenceTexture: (level, name) => asset('/api/texture', { level, name }, () => textureUrl(level, name)),
    particleTexture: (name, level) =>
      asset('/api/particle-texture', { name, level }, () => particleTextureUrl(name, level)),
    customSound: name => asset('/api/custom-sound', { name }, () => customSoundUrl(name)),
    soundIndex,
    courseEffectSound: (level, slot, bank) =>
      asset('/api/effect-sound', { level, slot, bank }, () => effectSoundUrl(level, slot, bank)),
    namedEffectSound: (level, slot, bank) =>
      asset('/api/effect-sound', { level, slot, bank }, () => effectSoundUrl(level, slot, bank)),
    environmentEffectSound: (bank, slot, loop) =>
      asset('/api/environment-sound', { bank, slot, ...(loop ? { loop: 1 } : {}) }, () =>
        environmentSoundUrl(bank, slot, loop),
      ),
    encodePng: image => encodePng(image),
    decodePng,

    skybox: sky => browserSkyboxFiles(sky, fetchJson, assetBytes, !!opts.request),

    stageRaceMusic: (selection, arrangement) =>
      stageRaceMusic(
        selection,
        arrangement,
        opts.existingFile,
        opts.request ? name => asset('/api/custom-music-file', { name }, () => '') : undefined,
      ),

    async discRecipePaths() {
      // Build commands accept the downloaded archive directly; extracted-folder commands remain available.
      return {
        exportDir: opts.folderName,
        archive: `${opts.folderName}.snowknife.zip`,
        levelData: `Maps/TRICKY_${DISC_SLOT}`,
        levelDataRelative: `../Maps/TRICKY_${DISC_SLOT}`,
      } satisfies DiscRecipePaths;
    },
  };
}

/** The ring a sky's pages are cut for, as the server resolved it, plus its `Skybox/` shell. */
interface SkyRingPayload {
  level: string;
  ring: SkyRing;
  pageVersions?: string[];
  files: { path: string; bytes: string }[];
}

const b64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

async function browserSkyboxFiles(
  sky: SkyboxDoc,
  fetchJson: <T>(url: string) => Promise<T>,
  assetBytes: typeof defaultAssetBytes,
  scoped: boolean,
): Promise<{ files: ExportFile[]; log: string[] }> {
  const preferred = sky.source.kind === 'level' ? sky.source.level : (sky.ring ?? '');
  if (sky.source.kind === 'level') {
    const catalog = await fetchJson<SkyCatalogue>('/api/skybox');
    const resolved = findSkyLevel([...(catalog.levels ?? []), ...(catalog.nativeLevels ?? [])], preferred);
    if (resolved && catalog.nativeLevels?.includes(resolved)) {
      const native = await fetchJson<{ files: { path: string; bytes: string }[] }>(
        `/api/skybox/native?level=${encodeURIComponent(resolved)}&files=1`,
      );
      const files = native.files.map(file => ({ path: file.path, bytes: b64ToBytes(file.bytes) }));
      files.push({
        path: 'Skybox/Sky.json',
        bytes: new TextEncoder().encode(JSON.stringify({ Source: 'level', Level: preferred, TopColor: sky.topColor })),
      });
      return { files, log: [`Copied ${preferred}'s original sky mesh and textures.`] };
    }
  }
  const ring = await fetchJson<SkyRingPayload>(`/api/skybox/ring?level=${encodeURIComponent(preferred)}`);
  const ringFiles: ExportFile[] = ring.files.map(file => ({ path: file.path, bytes: b64ToBytes(file.bytes) }));
  const pages: SkyboxPageSource =
    sky.source.kind === 'level'
      ? // A level sky lifts every page named by the measured ring, byte for byte, never through a canvas.
        {
          kind: 'level',
          pages: await Promise.all(
            Array.from({ length: ring.ring.tiles.length }, (_unused, index) =>
              assetBytes(
                scoped
                  ? `/api/skybox/page?level=${encodeURIComponent(ring.level)}&index=${index}`
                  : skyPageUrl(ring.level, index, ring.pageVersions?.[index]),
              ),
            ),
          ),
        }
      : {
          kind: 'custom',
          panorama: await decodePng(
            await assetBytes(
              scoped
                ? `/api/skypano?sky=${encodeURIComponent(sky.source.name)}`
                : customSkyUrl(sky.source.name, 'panorama'),
            ),
          ),
        };
  return composeSkybox(sky, { ringLevel: ring.level, ringFiles, ring: ring.ring, pages }, encodePng);
}
