import type { SkyboxDoc } from '../../core/doc/types';
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
import { assetBytes } from '../net/asset-bytes';
import {
  customSkyUrl, effectSoundUrl, environmentSoundUrl, customSoundUrl, particleTextureUrl, skyPageUrl, textureUrl,
} from '../net/asset-paths';
import { fetchJson } from '../net/fetch-json';
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
  /** The folder name the export lands under, inside the directory the author picked. The disc recipe's
   *  commands are written relative to that directory, since a browser is never told its absolute path. */
  folderName: string;
  /** Whether the destination already holds a file — what tells race-music staging that there is a track to
   *  preserve or to clear. A download has nothing to look at, so it answers false. */
  existingFile: (path: string) => Promise<boolean>;
}

export function browserExportProvider(opts: BrowserExportOptions): ExportProvider {
  // A level's prop payload is megabytes of geometry and an export asks for one twice — once for the placed
  // models, once for the gem crystals — so it is read once per export and answered from here after that.
  const propsByLevel = new Map<string, Promise<PropsPayload | null>>();
  const levelProps = (level: string): Promise<PropsPayload | null> => {
    let pending = propsByLevel.get(level);
    if (!pending) {
      pending = fetchJson<PropsPayload>(`/api/props?level=${encodeURIComponent(level)}`).catch(() => null);
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
          `/api/sound-banks?level=${encodeURIComponent(source)}`);
        return body.soundIndex ?? null;
      })().catch(() => null);
      soundIndexes.set(key, pending);
    }
    return pending;
  };

  return {
    async groupDefs(levels) {
      const payloads = await Promise.all(levels.map(level =>
        fetchJson<GroupsPayload>(`/api/groups?level=${encodeURIComponent(level)}`)));
      const index = new Map<string, GroupDef>();
      for (const payload of payloads) for (const group of payload.groups) index.set(`${group.level}:${group.id}`, group);
      return index;
    },

    async modelGeometry(models) {
      const levels = [...new Set(models.map(({ level }) => level))];
      // One payload per source level, fetched together. `/api/props` is the same `readModelGeometries` the
      // server bakes from, so a submesh's `{mat, positions, uvs, indices}` arrives ready to emit. A level with
      // no prop table — the '@models' and '@import' pseudo-levels, which carry their geometry on the document
      // and in the imported catalogue — simply contributes nothing.
      const payloads = await Promise.all(levels.map(levelProps));
      const geometry = new Map<string, ModelGeometry>();
      for (const [index, payload] of payloads.entries()) {
        if (!payload) continue;
        for (const model of decodeProps(payload).models)
          geometry.set(`${safeDataName(levels[index])}:${model.id}`, { subs: model.subs });
      }
      const lookup: GeometryLookup = (level, model) =>
        geometry.get(`${safeDataName(level)}:${model}`) ?? null;
      return lookup;
    },

    async materialTables() {
      const { tables } = await fetchJson<{ tables: Record<string, SourceMaterial[]> }>('/api/props/materials');
      return new Map(Object.entries(tables));
    },

    importedProps: () => fetchJson<PropsPayload>('/api/custom-props'),
    nativeArt: () => fetchJson<NativeArt>('/api/props/native-art'),
    referenceTexture: (level, name) => assetBytes(textureUrl(level, name)),
    particleTexture: (name, donorLevel) => assetBytes(particleTextureUrl(name, donorLevel)),
    customSound: file => assetBytes(customSoundUrl(file)),
    soundIndex,
    courseEffectSound: (level, slot, bank) => assetBytes(effectSoundUrl(level, slot, bank)),
    namedEffectSound: (level, slot, bank) => assetBytes(effectSoundUrl(level, slot, bank)),
    environmentEffectSound: (bank, slot, loop) => assetBytes(environmentSoundUrl(bank, slot, loop)),
    encodePng: image => encodePng(image),

    skybox: sky => browserSkyboxFiles(sky),

    stageRaceMusic: (selection, arrangement) => stageRaceMusic(selection, arrangement, opts.existingFile),

    async discRecipePaths() {
      // A picked directory has no path a browser may read, so the recipe is written relative to it — which is
      // the folder holding both this export and the extracted level data, since that is what `Maps/` is.
      return {
        exportDir: opts.folderName,
        levelData: DISC_SLOT,
        levelDataRelative: `../${DISC_SLOT}`,
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

async function browserSkyboxFiles(sky: SkyboxDoc): Promise<{ files: ExportFile[]; log: string[] }> {
  const preferred = sky.source.kind === 'level' ? sky.source.level : sky.ring ?? '';
  const ring = await fetchJson<SkyRingPayload>(`/api/skybox/ring?level=${encodeURIComponent(preferred)}`);
  const ringFiles: ExportFile[] = ring.files.map(file => ({ path: file.path, bytes: b64ToBytes(file.bytes) }));
  const pages: SkyboxPageSource = sky.source.kind === 'level'
    // A level sky lifts every page named by the measured ring, byte for byte, never through a canvas.
    ? { kind: 'level', pages: await Promise.all(Array.from({ length: ring.ring.tiles.length },
      (_unused, index) => assetBytes(skyPageUrl(ring.level, index, ring.pageVersions?.[index])))) }
    : { kind: 'custom',
      panorama: await decodePng(await assetBytes(customSkyUrl(sky.source.name, 'panorama'))) };
  return composeSkybox(sky, { ringLevel: ring.level, ringFiles, ring: ring.ring, pages }, encodePng);
}
