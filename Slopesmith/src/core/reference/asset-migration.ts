import { assetMapKey, parseAssetVersion, type AssetVersion } from './asset-version';
import { manifestAsset, type AssetManifest, type ReferenceAsset, type ReferenceAssetKind } from './asset-manifest';
import type { MapSourceChoice } from './map-game';
import { findMapChoice, mapSourceId, splitMapSource } from './map-source';
import { makeTexRef } from '../paint/textures';

type Path = string[];
export interface AssetMigrationRow {
  id: string;
  from: string;
  kind: ReferenceAssetKind;
  key: string;
  to?: string;
  source?: string;
  status: 'verified' | 'matching' | 'different' | 'current' | 'replacement' | 'missing';
  paths: Path[];
}
export interface AssetMigrationPreview {
  before: string;
  rows: AssetMigrationRow[];
}
export interface AssetMigrationSources {
  maps(): Promise<MapSourceChoice[]>;
  manifest(location: string): Promise<AssetManifest>;
  version(location: string): Promise<AssetVersion>;
  verify?(reference: AssetMigrationReference, asset: ReferenceAsset): Promise<boolean | undefined>;
}
export interface AssetMigrationReference {
  level: string;
  kind: ReferenceAssetKind;
  key: string;
}

/** Build a reviewable patch. Neither discovery nor a failed lookup changes the document. */
export async function previewAssetMigration(
  document: unknown,
  sources: AssetMigrationSources,
): Promise<AssetMigrationPreview> {
  const before = JSON.stringify(document);
  const references = new Map<
    string,
    { from: string; level: string; kind: ReferenceAssetKind; key: string; paths: Path[] }
  >();
  function visit(value: unknown, path: Path = []) {
    if (
      !value ||
      typeof value !== 'object' ||
      ArrayBuffer.isView(value) ||
      (Array.isArray(value) && typeof value[0] === 'number')
    )
      return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child !== 'string') {
        visit(child, [...path, key]);
        continue;
      }
      const slash = child.indexOf('/');
      const textureField =
        ['texture', 'tex', 'TexturePath'].includes(key) ||
        ['quadTex', 'particleTextures', 'frames'].includes(path.at(-1) ?? '');
      const texture = textureField && slash > 0 && /\.(png|webp|jpe?g)$/i.test(child);
      const owner = value as Record<string, unknown>;
      const kind = texture
        ? 'texture'
        : key === 'level' && typeof owner.model === 'number' && !owner.group
          ? 'prop'
          : key === 'level' && typeof owner.body === 'number'
            ? 'body'
            : undefined;
      if (!kind) continue;
      const level = texture ? child.slice(0, slash) : child;
      if (/^(custom$|@)/i.test(splitMapSource(level).name) || parseAssetVersion(level)?.kind) continue;
      const assetKey = texture ? child.slice(slash + 1) : String(owner[kind === 'prop' ? 'model' : 'body']);
      const id = `${kind}:${child}:${assetKey}`;
      const row = references.get(id) ?? {
        from: child,
        level,
        kind,
        key: assetKey,
        paths: [],
      };
      row.paths.push([...path, key]);
      references.set(id, row);
    }
  }
  visit(document);
  if (!references.size) return { before, rows: [] };
  const maps = await sources.maps();
  const manifests = new Map<string, Promise<AssetManifest>>(),
    versions = new Map<string, Promise<AssetVersion>>();
  const manifest = (location: string) => {
    let value = manifests.get(location);
    if (!value) {
      value = sources.manifest(location);
      manifests.set(location, value);
    }
    return value;
  };
  const version = (location: string) => {
    let value = versions.get(location);
    if (!value) {
      value = sources.version(location);
      versions.set(location, value);
    }
    return value;
  };
  const rows: AssetMigrationRow[] = [];
  for (const [id, reference] of references) {
    const expected = parseAssetVersion(reference.level),
      explicit = splitMapSource(reference.level);
    const choices = expected
      ? maps.filter(map => assetMapKey(splitMapSource(map.name).name, map.course) === expected.map)
      : (explicit.source
          ? [reference.level]
          : [mapSourceId('local', reference.level), mapSourceId('server', reference.level)]
        )
          .map(location => findMapChoice(maps, location))
          .filter((map): map is MapSourceChoice => !!map);
    const locations = [
      ...new Set(choices.map(map => mapSourceId(map.source ?? splitMapSource(map.name).source ?? 'server', map.name))),
    ];
    // Match rendering: resolve aliases within each source, then try local assets before server assets.
    locations.sort(
      (a, b) => Number(splitMapSource(b).source === 'local') - Number(splitMapSource(a).source === 'local'),
    );
    let proposal: AssetMigrationRow | undefined;
    for (const location of locations) {
      try {
        const current = await manifest(location);
        if (expected && current.game !== expected.game) continue;
        const asset = manifestAsset(current, reference.kind, reference.key);
        if (!asset) continue;
        const verified = expected && (await version(location).catch(() => undefined))?.id === expected.id;
        const matches = verified ? undefined : await sources.verify?.(reference, asset).catch(() => undefined);
        const row: AssetMigrationRow = {
          id,
          from: reference.from,
          kind: reference.kind,
          key: reference.key,
          to: reference.kind === 'texture' ? makeTexRef(asset.id, reference.key) : asset.id,
          paths: reference.paths,
          source: location,
          status: verified
            ? 'verified'
            : matches === true
              ? 'matching'
              : expected
                ? 'replacement'
                : matches === false
                  ? 'different'
                  : 'current',
        };
        if (!proposal || verified || (matches === true && proposal.status !== 'matching')) proposal = row;
        if (verified || (matches === true && !expected)) break;
      } catch {
        /* One unavailable source must not hide an available copy. */
      }
    }
    rows.push(
      proposal ?? {
        id,
        from: reference.from,
        kind: reference.kind,
        key: reference.key,
        paths: reference.paths,
        status: 'missing',
      },
    );
  }
  return { before, rows };
}

/** Apply exactly the selected preview to a copy; reject stale previews instead of overwriting newer edits. */
export function applyAssetMigration<T>(document: T, preview: AssetMigrationPreview, selected: readonly string[]): T {
  if (JSON.stringify(document) !== preview.before)
    throw new Error('The mountain changed after this preview. Review its asset references again.');
  const result = structuredClone(document);
  for (const id of selected) {
    const row = preview.rows.find(row => row.id === id);
    if (!row?.to) throw new Error('The selected migration has no available replacement.');
    for (const path of row.paths) {
      let target = result as Record<string, unknown>;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[path.at(-1)!] = row.to;
    }
  }
  return result;
}

/** Upgrade only verified identities, preserving edits made while discovery was in flight. */
export function upgradeExactAssetReferences(document: unknown, preview: AssetMigrationPreview): number {
  let changed = 0;
  for (const row of preview.rows) {
    if (!row.to || !['verified', 'matching'].includes(row.status)) continue;
    for (const path of row.paths) {
      let owner: unknown = document;
      for (const key of path.slice(0, -1))
        owner =
          owner && typeof owner === 'object' && Object.hasOwn(owner, key)
            ? (owner as Record<string, unknown>)[key]
            : undefined;
      if (!owner || typeof owner !== 'object') continue;
      const target = owner as Record<string, unknown>,
        field = path.at(-1)!;
      if (!Object.hasOwn(target, field) || target[field] !== row.from) continue;
      if (row.kind === 'prop' && (String(target.model) !== row.key || target.group)) continue;
      if (row.kind === 'body' && String(target.body) !== row.key) continue;
      target[field] = row.to;
      changed++;
    }
  }
  return changed;
}
