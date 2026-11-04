import type { AssetVersion } from './asset-version';
import type { PropsPayload } from './props';

export type ReferenceAssetKind = NonNullable<AssetVersion['kind']>;
export interface ReferenceAsset extends AssetVersion {
  kind: ReferenceAssetKind;
  key: string;
  /** Source model label, for reviewing compatible imports independently of model numbering. */
  name?: string;
  /** Imported definition equivalence without source-local model/material numbering. Not an immutable id. */
  compatibilityHash?: string;
  /** Exact dependency bytes, relative to the source map. */
  files: Record<string, string>;
  payloadHash?: string;
}
export interface AssetManifest {
  schema: 'openslope-assets/v1';
  game: string;
  map: string;
  assets: ReferenceAsset[];
  unavailable?: { kind: ReferenceAssetKind; key: string; reason: string }[];
}
/** Crowd playback needs source membership and frame identities, without every asset's dependency closure. */
export interface CrowdAssetManifest {
  schema: 'openslope-crowd-assets/v1';
  game: string;
  map: string;
  props: Record<string, string>;
  frames: Record<string, string>;
}

export function crowdAssetManifest(manifest: AssetManifest): CrowdAssetManifest {
  return {
    schema: 'openslope-crowd-assets/v1',
    game: manifest.game,
    map: manifest.map,
    props: Object.fromEntries(
      manifest.assets.filter(asset => asset.kind === 'prop').map(asset => [asset.key, asset.hash]),
    ),
    // Cached props may still name an older crowd profile. Keep every available texture addressable.
    frames: Object.fromEntries(
      manifest.assets.filter(asset => asset.kind === 'texture').map(asset => [asset.key.toLowerCase(), asset.id]),
    ),
  };
}
export const referenceAssetId = (game: string, map: string, kind: ReferenceAssetKind, key: string, hash: string) =>
  `asset2:${encodeURIComponent(game)}:${encodeURIComponent(map)}:${kind}:${encodeURIComponent(key)}:${hash}`;

export function manifestAsset(
  manifest: AssetManifest,
  kind: ReferenceAssetKind,
  key: string,
): ReferenceAsset | undefined {
  return manifest.assets.find(
    asset =>
      asset.kind === kind && (kind === 'texture' ? asset.key.toLowerCase() === key.toLowerCase() : asset.key === key),
  );
}

/** A placed asset needs its own reusable definition, without the donor map's models and placements. */
export function propAssetPayload(payload: PropsPayload, asset: AssetVersion): PropsPayload {
  if (asset.kind !== 'prop' && asset.kind !== 'body') return payload;
  const models = asset.kind === 'prop' ? payload.models.filter(model => String(model.id) === asset.key) : [];
  return {
    ...payload,
    models,
    materials: payload.materials.filter(material =>
      models.some(model => model.subs.some(sub => sub.mat === material.id)),
    ),
    instances: [],
    // Models carry their reusable collision inline; this table belongs to donor placements.
    collisionMeshes: [],
    physicsBodies: asset.kind === 'body' ? payload.physicsBodies?.filter(body => String(body.id) === asset.key) : [],
  };
}

export function assetRequestCovered(version: AssetVersion, path: string, query: URLSearchParams): boolean {
  if (!version.kind) return true;
  if (path === '/api/texture')
    return (
      version.kind === 'prop' ||
      (version.kind === 'texture' && version.key?.toLowerCase() === query.get('name')?.toLowerCase())
    );
  if (path === '/api/props') return version.kind === 'prop' || version.kind === 'body';
  if (path === '/api/props/materials') return version.kind === 'prop';
  return path === '/api/physics-body' && version.kind === 'body' && query.get('idx') === version.key;
}
