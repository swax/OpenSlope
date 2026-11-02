import { assetMapKey } from '../core/reference/asset-version';
import {
  referenceAssetId,
  type AssetManifest,
  type ReferenceAsset,
  type ReferenceAssetKind,
} from '../core/reference/asset-manifest';
import type { PropsPayload } from '../core/reference/props';
import { mapGame } from '../core/reference/map-game';
import { assetBankFiles } from './map-asset-version';
import { assetDefinitionHash, propAssetDefinition, sha256 } from '../core/reference/asset-hash';
import { listLevelOrigins } from './map-levels';
import { buildLevelPropsUncached } from './map-props';
import { joinMapPath, type MapDataSource } from './map-data';

export async function readAssetManifest(
  io: MapDataSource,
  level: string,
  loadProps?: () => Promise<PropsPayload>,
): Promise<AssetManifest> {
  const origin = (await listLevelOrigins(io, [level]))[0] ?? { name: level };
  const game = mapGame(origin),
    map = assetMapKey(level, origin.course);
  const assets: ReferenceAsset[] = [];
  const unavailable: NonNullable<AssetManifest['unavailable']> = [];
  const textures = new Map<string, { path: string; hash: string }>();
  for (const path of await assetBankFiles(io, level)) {
    if (!/^textures\//i.test(path)) continue;
    const bytes = await io.readBytesOrNull(joinMapPath(io.root, level, path));
    if (!bytes) throw new Error(`Missing asset ${level}/${path}`);
    const hash = await sha256(bytes),
      key = path.slice('Textures/'.length).toLowerCase();
    textures.set(key, { path: path.toLowerCase(), hash });
    assets.push({
      id: referenceAssetId(game, map, 'texture', key, hash),
      game,
      map,
      kind: 'texture',
      key,
      hash,
      files: { [path.toLowerCase()]: hash },
    });
  }
  if (await io.pathExists(joinMapPath(io.root, level, 'Models.json'))) {
    try {
      const payload = await (loadProps?.() ?? buildLevelPropsUncached(io, level));
      const sourceModels = await io.readJsonOr<{ Models?: unknown[] }>(joinMapPath(io.root, level, 'Models.json'), {});
      const sourceMaterials = await io.readJsonOr<{ Materials?: unknown[] }>(
        joinMapPath(io.root, level, 'Materials.json'),
        {},
      );
      async function add(kind: ReferenceAssetKind, key: string, definition: unknown, names: string[] = []) {
        const files: Record<string, string> = {};
        for (const name of [...new Set(names)].sort()) {
          const texture = textures.get(name.toLowerCase());
          if (!texture) throw new Error(`Prop ${key} needs the missing texture ${name}.`);
          files[texture.path] = texture.hash;
        }
        const model = kind === 'prop' ? payload.models.find(model => String(model.id) === key) : undefined;
        const materialIds = [...new Set(model?.subs.map(sub => sub.mat) ?? [])].sort((a, b) => a - b);
        const hash = await assetDefinitionHash(
          {
            definition,
            source: model ? sourceModels.Models?.[model.id] : undefined,
            materials: materialIds.map(id => sourceMaterials.Materials?.[id]),
          },
          files,
        );
        const payloadHash = await assetDefinitionHash(definition, {});
        assets.push({
          id: referenceAssetId(game, map, kind, key, hash),
          game,
          map,
          kind,
          key,
          hash,
          files,
          payloadHash,
        });
      }
      for (const model of payload.models) {
        const materials = payload.materials.filter(material => model.subs.some(sub => sub.mat === material.id));
        try {
          await add(
            'prop',
            String(model.id),
            propAssetDefinition(payload, String(model.id)),
            materials.flatMap(material =>
              [material.tex, ...(material.frames ?? [])].filter((name): name is string => !!name),
            ),
          );
        } catch (error) {
          unavailable.push({
            kind: 'prop',
            key: String(model.id),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const body of payload.physicsBodies ?? []) await add('body', String(body.id), body);
    } catch (error) {
      unavailable.push({ kind: 'prop', key: '*', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { schema: 'openslope-assets/v1', game, map, assets, ...(unavailable.length ? { unavailable } : {}) };
}
