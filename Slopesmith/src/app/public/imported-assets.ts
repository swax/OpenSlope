import { assetMapKey, assetVersionsIn, parseAssetVersion, type AssetVersion } from '../../core/reference/asset-version';
import { compatibleImportedAssets, compatibleImportScope } from '../../core/reference/asset-compatibility';
import { mapGame, type MapSourceChoice } from '../../core/reference/map-game';
import { splitMapSource } from '../../core/reference/map-source';
import { mapLimit } from '../../shared/map-data';
import { availableAssetMaps, readAssetManifestAt, readAssetBankAt, readSelectedAssetManifestAt } from '../net/asset-versions';
import type { AssetSelection } from '../../shared/map-asset-manifest';

function selectionFor(document: unknown, map: string, accepts: (asset: AssetVersion) => boolean): AssetSelection {
  const textures = new Set<string>(), props = new Set<string>(), names = new Set<string>(), bodies = new Set<string>();
  function texture(key: string) {
    textures.add(key.toLowerCase());
    if (!/_[oa]\.png$/i.test(key)) for (const suffix of ['_o', '_a']) textures.add(key.replace(/\.png$/i, `${suffix}.png`).toLowerCase());
  }
  function visit(value: unknown) {
    if (typeof value === 'string') {
      const [id, ...path] = value.split('/'), asset = parseAssetVersion(id);
      if (!asset || !accepts(asset)) return;
      if (asset.kind === 'texture') texture(asset.key!);
      else if (asset.kind === 'prop' && asset.map === map) props.add(asset.key!);
      else if (asset.kind === 'body' && asset.map === map) bodies.add(asset.key!);
      else if (path.length) texture(path.join('/'));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>, asset = typeof row.level === 'string' ? parseAssetVersion(row.level) : undefined;
      if (asset && accepts(asset)) {
        if (typeof row.model === 'number' && asset.map === map) props.add(String(row.model));
        if (typeof row.body === 'number' && asset.map === map) bodies.add(String(row.body));
        if (typeof row.name === 'string' && (asset.kind === 'prop' || typeof row.model === 'number')) names.add(row.name.toLowerCase());
      }
      Object.values(row).forEach(visit);
    }
  }
  visit(document);
  return { textures: [...textures].sort(), props: [...props].sort(), names: [...names].sort(), bodies: [...bodies].sort() };
}

/** Playback substitutions use imported identities without rewriting the authored document. */
export async function matchImportedAssets<T>(document: T) {
  const expected = assetVersionsIn(document).map(id => parseAssetVersion(id)!).filter(asset =>
    asset.game !== 'slopesmith');
  if (!expected.length) return { document, replacements: [] };
  const maps = await availableAssetMaps();
  const source = (map: MapSourceChoice) => map.source ?? splitMapSource(map.name).source;
  const sameScope = (map: MapSourceChoice, asset: typeof expected[number]) =>
    mapGame(map) === asset.game && assetMapKey(splitMapSource(map.name).name, map.course) === asset.map;
  const local = maps.filter(map => source(map) === 'local');
  const candidates = maps.filter(map => source(map) === 'local'
    ? expected.some(asset => mapGame(map) === asset.game &&
      (local.some(choice => sameScope(choice, asset)) ? sameScope(map, asset) :
        compatibleImportScope(asset.map, assetMapKey(splitMapSource(map.name).name, map.course))))
    : expected.some(asset => sameScope(map, asset)));
  if (!candidates.some(map => source(map) === 'local')) return { document, replacements: [] };
  const loaded = await mapLimit(candidates, 4, async map => {
    try {
      const [manifest, bank] = await Promise.all([
        source(map) === 'local' ? readSelectedAssetManifestAt(map.name, selectionFor(document, assetMapKey(splitMapSource(map.name).name, map.course), asset =>
          mapGame(map) === asset.game && compatibleImportScope(asset.map, assetMapKey(splitMapSource(map.name).name, map.course)))) : readAssetManifestAt(map.name),
        expected.some(asset => !asset.kind && sameScope(map, asset)) ? readAssetBankAt(map.name).catch(() => null) : null,
      ]);
      return { map, manifest, bank };
    }
    catch { return null; }
  });
  return compatibleImportedAssets(document,
    loaded.flatMap(value => value && source(value.map) === 'local' ? [value.manifest] : []),
    loaded.flatMap(value => value ? [
      ...(value.bank ? [value.bank.id] : []),
      ...(source(value.map) !== 'local' ? value.manifest.assets.map(asset => asset.id) : []),
    ] : []));
}
