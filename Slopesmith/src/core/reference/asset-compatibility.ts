import { assetVersionsIn, parseAssetVersion, type AssetVersion } from './asset-version';
import type { AssetManifest, ReferenceAsset } from './asset-manifest';
import { isDiscCourse } from './disc-courses';

export interface AssetReplacement {
  original: string;
  originalKey?: string;
  replacement: ReferenceAsset;
}
/** Old SSX 3 peak banks shared art now repeated in individually imported sections. */
export function compatibleImportScope(expected: string, candidate: string): boolean {
  if (expected === candidate) return true;
  const peak = expected.match(/^(SSX3B?)_PEAK[123]$/);
  return !!peak && candidate.startsWith(`${peak[1]}_`) && !/_PEAK[123]$/.test(candidate) && isDiscCourse(candidate);
}

/** Playback substitutions use real imported identities and never certify an old hash. */
export function compatibleImportedAssets<T>(
  document: T,
  banks: readonly AssetManifest[],
  exactAssets: readonly string[] = [],
) {
  const names = new Map<string, Set<string>>();
  function labels(value: unknown) {
    if (Array.isArray(value)) value.forEach(labels);
    else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      if (typeof row.level === 'string' && typeof row.name === 'string') {
        const labels = names.get(row.level) ?? new Set<string>();
        labels.add(row.name.toLowerCase());
        names.set(row.level, labels);
      }
      Object.values(row).forEach(labels);
    }
  }
  labels(document);
  const replacements = new Map<string, ReferenceAsset>();
  const used = new Set<string>();
  const legacy = new Map<string, AssetReplacement>();
  const all = banks.flatMap(bank => bank.assets);
  const exact = new Set([...all.map(asset => asset.id), ...exactAssets]);
  const textureKey = (name: string) => name.toLowerCase().replace(/_[oa](?=\.png$)/, '');
  function choose(expected: AssetVersion, labels = names.get(expected.id)): ReferenceAsset | undefined {
    if (exact.has(expected.id) || !expected.kind || expected.game === 'slopesmith') return;
    const game = banks.filter(bank => bank.game === expected.game && compatibleImportScope(expected.map, bank.map));
    const own = game.filter(bank => bank.map === expected.map);
    let candidates = (own.length ? own : game)
      .flatMap(bank => bank.assets)
      .filter(asset => {
        if (asset.kind !== expected.kind || asset.game !== expected.game) return false;
        if (asset.kind === 'texture') return textureKey(asset.key) === textureKey(expected.key!);
        if (asset.kind === 'body') return asset.map === expected.map && asset.key === expected.key;
        return /^\d+$/.test(asset.key) && !!asset.name && !!labels?.has(asset.name.toLowerCase());
      });
    if (expected.kind === 'texture' && /_[oa]\.png$/i.test(expected.key!))
      candidates = candidates.filter(asset => asset.key.toLowerCase() === expected.key!.toLowerCase());
    if (
      expected.kind === 'prop' &&
      own.some(bank => bank.assets.some(asset => asset.kind === 'prop' && asset.key === expected.key))
    )
      candidates = candidates.filter(asset => asset.key === expected.key);
    // A matching label/index can be reused only when all candidates agree on one imported definition.
    if (candidates.length && new Set(candidates.map(asset => asset.compatibilityHash ?? asset.hash)).size === 1)
      return [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0];
  }
  for (const id of assetVersionsIn(document)) {
    const replacement = choose(parseAssetVersion(id)!);
    if (replacement) replacements.set(id, replacement);
  }
  function legacyAsset(id: string, kind: NonNullable<AssetVersion['kind']>, key: string, label?: string) {
    const expected = parseAssetVersion(id);
    if (!expected || expected.kind) return;
    if (kind === 'prop' && !label) return;
    const replacement = choose({ ...expected, kind, key }, label ? new Set([label.toLowerCase()]) : undefined);
    if (replacement) legacy.set(`${id}/${kind}/${key}`, { original: id, originalKey: key, replacement });
    return replacement;
  }
  function rewrite(value: unknown): unknown {
    if (typeof value === 'string') {
      const [id, ...path] = value.split('/');
      const replacement =
        replacements.get(id) ?? (path.length ? legacyAsset(id, 'texture', path.join('/')) : undefined);
      if (!replacement) return value;
      if (replacements.has(id)) used.add(id);
      return path.length && replacement.kind === 'texture' ? `${replacement.id}/${replacement.key}` : replacement.id;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      const result = Object.fromEntries(
        Object.entries(row).map(([key, child]) => [
          key,
          ['name', 'note', 'description', 'id'].includes(key) ? child : rewrite(child),
        ]),
      );
      const replacement =
        typeof row.level === 'string'
          ? (replacements.get(row.level) ??
            (typeof row.model === 'number'
              ? legacyAsset(row.level, 'prop', String(row.model), typeof row.name === 'string' ? row.name : undefined)
              : typeof row.body === 'number'
                ? legacyAsset(row.level, 'body', String(row.body))
                : undefined))
          : undefined;
      if (replacement) result.level = replacement.id;
      if (replacement?.kind === 'prop' && typeof row.model === 'number') result.model = Number(replacement.key);
      if (replacement?.kind === 'body' && typeof row.body === 'number') result.body = Number(replacement.key);
      if (
        replacement?.kind === 'texture' &&
        typeof row.name === 'string' &&
        row.name.toLowerCase() === parseAssetVersion(String(row.level))?.key?.toLowerCase()
      )
        result.name = replacement.key;
      return result;
    }
    return value;
  }
  return {
    document: rewrite(document) as T,
    replacements: [
      ...[...replacements]
        .filter(([id]) => used.has(id))
        .map(([original, replacement]): AssetReplacement => ({ original, replacement })),
      ...legacy.values(),
    ],
  };
}
