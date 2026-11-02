import { assetMapKey, parseAssetVersion, type AssetVersion } from '../../core/reference/asset-version';
import type {
  AssetManifest,
  CrowdAssetManifest,
  ReferenceAsset,
  ReferenceAssetKind,
} from '../../core/reference/asset-manifest';
import { assetRequestCovered, manifestAsset, propAssetPayload } from '../../core/reference/asset-manifest';
import type { MapSourceChoice } from '../../core/reference/map-game';
import { mapSourceId, splitMapSource } from '../../core/reference/map-source';
import type { PropsPayload } from '../../core/reference/props';
import { assetDefinitionHash, propAssetDefinition, sha256 } from '../../core/reference/asset-hash';
import { safeDataName } from '../../core/export/names';

export type AssetTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A source is only a candidate. Its descriptor must match before it can supply an immutable identity. */
export function createAssetReader(transport: AssetTransport, bind: (id: string, location: string) => void = () => {}) {
  const metadata = new Map<string, Promise<AssetVersion | AssetManifest>>();
  const crowds = new Map<string, Promise<CrowdAssetManifest>>();
  let catalogue: Promise<MapSourceChoice[]> | undefined;
  async function maps() {
    catalogue ??= transport('/api/levels')
      .then(async response => {
        if (!response.ok) {
          catalogue = undefined;
          return [];
        }
        const body = (await response.json()) as { levels?: string[]; maps?: MapSourceChoice[] };
        return (body.levels ?? []).map(name => body.maps?.find(map => map.name === name) ?? { name });
      })
      .catch(() => {
        catalogue = undefined;
        return [];
      });
    return catalogue;
  }
  async function descriptor(location: string, manifest: boolean): Promise<AssetVersion | AssetManifest> {
    const key = `${manifest}:${location}`;
    let pending = metadata.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await transport(
          `/api/map-asset-${manifest ? 'manifest' : 'version'}?level=${encodeURIComponent(location)}`,
        );
        if (!response.ok) throw new Error('The selected map assets are unavailable.');
        const value = (await response.json()) as AssetVersion | AssetManifest;
        if (
          manifest
            ? !('schema' in value && value.schema === 'openslope-assets/v1' && Array.isArray(value.assets))
            : !('id' in value && parseAssetVersion(value.id))
        )
          throw new Error('The source returned an invalid asset descriptor.');
        return value;
      })();
      metadata.set(key, pending);
      void pending.catch(() => {
        if (metadata.get(key) === pending) metadata.delete(key);
      });
    }
    return pending;
  }
  async function locations(expected: AssetVersion) {
    const choices = (await maps()).filter(
      map => assetMapKey(splitMapSource(map.name).name, map.course) === expected.map,
    );
    return [
      ...new Set([
        ...choices.map(map => mapSourceId(map.source ?? splitMapSource(map.name).source ?? 'server', map.name)),
        mapSourceId('local', expected.map),
        mapSourceId('server', expected.map),
      ]),
    ].sort((a, b) => Number(splitMapSource(b).source === 'local') - Number(splitMapSource(a).source === 'local'));
  }
  async function crowdDescriptor(location: string): Promise<CrowdAssetManifest> {
    let pending = crowds.get(location);
    if (!pending) {
      pending = (async () => {
        const response = await transport(`/api/map-asset-manifest?level=${encodeURIComponent(location)}&crowd=1`);
        if (!response.ok) throw new Error('Crowd frame metadata is unavailable.');
        const value = (await response.json()) as CrowdAssetManifest;
        if (value.schema !== 'openslope-crowd-assets/v1' || !value.props || !value.frames)
          throw new Error('The source returned an invalid crowd descriptor.');
        return value;
      })();
      crowds.set(location, pending);
      void pending.catch(() => {
        if (crowds.get(location) === pending) crowds.delete(location);
      });
    }
    return pending;
  }
  return {
    maps,
    manifest: (location: string) => descriptor(location, true) as Promise<AssetManifest>,
    version: (location: string) => descriptor(location, false) as Promise<AssetVersion>,
    clear() {
      catalogue = undefined;
      metadata.clear();
      crowds.clear();
    },
    /** Crowd animation belongs to the shared frame bank, not the model's ordinary material closure. */
    async crowdFrames(id: string, names: readonly string[]): Promise<string[]> {
      const expected = parseAssetVersion(id);
      if (
        expected?.kind !== 'prop' ||
        !names.length ||
        names.every(name => parseAssetVersion(name)?.kind === 'texture')
      )
        return [...names];
      for (const location of await locations(expected)) {
        try {
          if (splitMapSource(location).source === 'server' && !metadata.has(`true:${location}`)) {
            try {
              const crowd = await crowdDescriptor(location);
              if (
                crowd.game !== expected.game ||
                crowd.map !== expected.map ||
                crowd.props[expected.key!] !== expected.hash
              )
                continue;
              return names.map(name => crowd.frames[name.toLowerCase()] ?? name);
            } catch {
              // Older servers do not have the compact view. Local banks use their in-process manifest too.
            }
          }
          const manifest = (await descriptor(location, true)) as AssetManifest;
          if (!manifest.assets.some(asset => asset.id === id)) continue;
          return names.map(name => manifestAsset(manifest, 'texture', name)?.id ?? name);
        } catch {
          /* Keep ordinary missing-frame handling if this source is unavailable. */
        }
      }
      return [...names];
    },
    async libraryBank(id: string): Promise<string> {
      const expected = parseAssetVersion(id);
      if (!expected?.kind) return id;
      for (const location of await locations(expected)) {
        try {
          metadata.delete(`true:${location}`);
          metadata.delete(`false:${location}`);
          const manifest = (await descriptor(location, true)) as AssetManifest;
          if (!manifest.assets.some(asset => asset.id === id)) continue;
          const bank = (await descriptor(location, false)) as AssetVersion;
          bind(id, location);
          bind(bank.id, location);
          return bank.id;
        } catch {
          /* Another matching copy may still be available. */
        }
      }
      throw new Error('The source of this asset is unavailable.');
    },
    /** New library picks must belong to the exact bank that supplied their preview/defaults. */
    async pinAssets(id: string, kind: ReferenceAssetKind, keys: readonly string[]): Promise<Map<string, string>> {
      if (!keys.length) return new Map();
      const expected = parseAssetVersion(id);
      if (!expected) throw new Error('An exact source bank is required to select reference assets.');
      if (expected.kind) {
        if (expected.kind !== kind || keys.some(key => key.toLowerCase() !== expected.key?.toLowerCase()))
          throw new Error('This asset identity does not cover the selected resource.');
        return new Map(keys.map(key => [key, id]));
      }
      for (const location of await locations(expected)) {
        try {
          if (((await descriptor(location, false)) as AssetVersion).id !== id) {
            metadata.delete(`false:${location}`);
            if (((await descriptor(location, false)) as AssetVersion).id !== id) continue;
            metadata.delete(`true:${location}`);
          }
          const manifest = (await descriptor(location, true)) as AssetManifest;
          const selected = keys.map(key => manifestAsset(manifest, kind, key));
          if (selected.some(asset => !asset)) continue;
          for (const asset of selected) {
            const parsed = parseAssetVersion(asset!.id);
            if (
              parsed?.kind !== kind ||
              parsed.game !== expected.game ||
              parsed.map !== expected.map ||
              parsed.key !== asset!.key ||
              parsed.hash !== asset!.hash
            )
              throw new Error('The selected asset manifest is invalid.');
          }
          for (const asset of selected) bind(asset!.id, location);
          return new Map(keys.map((key, index) => [key, selected[index]!.id]));
        } catch {
          metadata.delete(`false:${location}`);
          metadata.delete(`true:${location}`);
        }
      }
      throw new Error(
        `The selected ${kind} is unavailable in the original source bank. Reopen the library to refresh it.`,
      );
    },
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
        globalThis.location?.origin ?? 'http://localhost',
      );
      const parameter = url.pathname === '/api/level' ? 'name' : 'level';
      const id = url.searchParams.get(parameter) ?? '',
        expected = parseAssetVersion(id);
      if (!expected) return transport(input, init);
      if (!assetRequestCovered(expected, url.pathname, url.searchParams))
        return Response.json({ error: 'This asset identity does not cover the requested resource.' }, { status: 404 });
      const attempts: { location: string; reason: string }[] = [];
      for (const location of await locations(expected)) {
        try {
          let asset: ReferenceAsset | undefined;
          if (expected.kind)
            asset = ((await descriptor(location, true)) as AssetManifest).assets.find(asset => asset.id === id);
          else if (((await descriptor(location, false)) as AssetVersion).id !== id)
            throw new Error('Different asset version');
          if (expected.kind && !asset) throw new Error('Different asset version');
          const candidate = new URL(url),
            source = splitMapSource(location).source!;
          candidate.searchParams.set('mapSource', source);
          candidate.searchParams.set(parameter, source === 'server' ? id : splitMapSource(location).name);
          const response = await transport(candidate, init);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (url.pathname === '/api/props/materials') {
            const body = (await response.json()) as { tables: Record<string, unknown> };
            const entries = Object.entries(body.tables ?? {});
            const own = [safeDataName(location), safeDataName(splitMapSource(location).name)]
              .map(key => entries.find(([name]) => name.toLowerCase() === key.toLowerCase()))
              .find(entry => !!entry);
            if (own) body.tables[safeDataName(id)] = own[1];
            bind(id, location);
            return Response.json(body);
          }
          if (asset && url.pathname === '/api/texture') {
            const path = `textures/${url.searchParams.get('name') ?? ''}`.toLowerCase();
            const hash = Object.entries(asset.files).find(([name]) => name.toLowerCase() === path)?.[1];
            if (!hash || (await sha256(new Uint8Array(await response.clone().arrayBuffer()))) !== hash)
              throw new Error('Texture bytes differ from the manifest');
          }
          if (asset && url.pathname === '/api/props') {
            const payload = (await response.json()) as PropsPayload;
            const definition =
              asset.kind === 'prop'
                ? propAssetDefinition(payload, asset.key)
                : payload.physicsBodies?.find(body => String(body.id) === asset.key);
            if (!definition || (await assetDefinitionHash(definition, {})) !== asset.payloadHash)
              throw new Error('Prop bytes differ from the manifest');
            bind(id, location);
            return Response.json({ ...propAssetPayload(payload, asset), level: id });
          }
          bind(id, location);
          return response;
        } catch (error) {
          if (init?.signal?.aborted) throw error;
          attempts.push({ location, reason: error instanceof Error ? error.message : String(error) });
          metadata.delete(`${!!expected.kind}:${location}`);
        }
      }
      return Response.json(
        {
          error: `Matching ${expected.kind ?? 'bank'} asset version ${expected.hash.slice(0, 8)} for ${expected.map} is unavailable.`,
          attempts,
        },
        { status: 404 },
      );
    },
  };
}
