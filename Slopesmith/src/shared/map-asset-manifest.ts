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
import { assetDefinitionHash, propAssetDefinition, propCompatibilityHash, sha256 } from '../core/reference/asset-hash';
import { listLevelOrigins } from './map-levels';
import { buildLevelPropsUncached, type PropSelection } from './map-props';
import { joinMapPath, mapLimit, READ_CONCURRENCY, type MapDataSource } from './map-data';

export interface AssetSelection {
  textures: string[];
  props: string[];
  names: string[];
  bodies: string[];
}

export async function readAssetManifest(
  io: MapDataSource,
  level: string,
  loadProps?: (selection?: PropSelection) => Promise<PropsPayload>,
  selection?: AssetSelection,
): Promise<AssetManifest> {
  const origin = (await listLevelOrigins(io, [level]))[0] ?? { name: level };
  const game = mapGame(origin),
    map = assetMapKey(level, origin.course);
  const assets: ReferenceAsset[] = [];
  const unavailable: NonNullable<AssetManifest['unavailable']> = [];
  const textures = new Map<string, { path: string; hash: string }>();
  // A map normally uses only a handful of models from a bank. Decode just those,
  // retaining the full placement/effect index so their immutable identities stay identical.
  let payload: PropsPayload | undefined;
  const sourceModels =
    !selection || selection.props.length || selection.names.length || selection.bodies.length
      ? await io.readJsonOr<{ Models?: { ModelName?: string }[] }>(joinMapPath(io.root, level, 'Models.json'), {})
      : {};
  const modelKeys = new Set(selection?.props);
  const modelNames = new Set(selection?.names.map(name => name.toLowerCase()));
  const selectedModels = new Set(
    (sourceModels.Models ?? []).flatMap((model, id) =>
      modelKeys.has(String(id)) || (model.ModelName && modelNames.has(model.ModelName.toLowerCase())) ? [id] : [],
    ),
  );
  if (sourceModels.Models && (!selection || selectedModels.size || selection.bodies.length)) {
    const subset = selection ? { models: selectedModels, bodies: new Set(selection.bodies.map(Number)) } : undefined;
    payload = await (loadProps?.(subset) ?? buildLevelPropsUncached(io, level, subset)).catch(error => {
      unavailable.push({ kind: 'prop', key: '*', reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    });
  }
  const wanted = new Set(selection?.textures.map(name => name.toLowerCase()));
  for (const frame of payload?.crowdFrames ?? []) wanted.add(frame.toLowerCase());
  for (const material of payload?.materials ?? []) {
    if (material.tex) wanted.add(material.tex.toLowerCase());
    for (const frame of material.frames ?? []) wanted.add(frame.toLowerCase());
  }
  const textureFiles = (await assetBankFiles(io, level)).filter(
    path => /^textures\//i.test(path) && (!selection || wanted.has(path.slice('Textures/'.length).toLowerCase())),
  );
  const entries = await mapLimit(textureFiles, READ_CONCURRENCY, async path => {
    const bytes = await io.readBytesOrNull(joinMapPath(io.root, level, path));
    if (!bytes) throw new Error(`Missing asset ${level}/${path}`);
    const hash = await sha256(bytes),
      key = path.slice('Textures/'.length).toLowerCase();
    return {
      id: referenceAssetId(game, map, 'texture', key, hash),
      game,
      map,
      kind: 'texture' as const,
      key,
      hash,
      files: { [path.toLowerCase()]: hash },
    };
  });
  for (const asset of entries) {
    textures.set(asset.key, { path: `textures/${asset.key}`, hash: asset.hash });
    assets.push(asset);
  }
  if (payload) {
    const props = payload;
    try {
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
        const model = kind === 'prop' ? props.models.find(model => String(model.id) === key) : undefined;
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
          ...(model ? { name: model.name, compatibilityHash: await propCompatibilityHash(definition, files) } : {}),
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
