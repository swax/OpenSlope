import type { ProjectBundle, BundleAssetKind } from '../../core/project/transfer';
import type { ImportedPropRecord } from '../../core/props/imported';
import type { PropsPayload } from '../../core/reference/props';

const unpack = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

/** The editor and solo player resolve the same self-contained mountain's custom art. */
export function bundleAssets(source: ProjectBundle | (() => ProjectBundle | undefined)) {
  const urls = new Map<string, string>();
  function assetUrl(kind: BundleAssetKind, name: string): string {
    const bundle = typeof source === 'function' ? source() : source;
    const asset = bundle?.assets.find(asset => asset.kind === kind && asset.name === name);
    const bytes = asset && bundle?.blobs?.[asset.hash];
    if (!asset || !bytes) return 'data:application/octet-stream;base64,';
    let url = urls.get(asset.hash);
    if (!url) {
      url = URL.createObjectURL(new Blob([unpack(bytes)], {
        type: kind === 'texture' || kind === 'sky' ? 'image/png' : kind === 'sound' ? 'audio/wav' : 'application/octet-stream',
      }));
      urls.set(asset.hash, url);
    }
    return url;
  }
  return {
    resolve(path: string): string {
      const url = new URL(path, location.origin), q = url.searchParams;
      if (url.origin !== location.origin) return path;
      if (url.pathname === '/api/texture' && q.get('level')?.toLowerCase() === 'custom') return assetUrl('texture', q.get('name') ?? '');
      if (url.pathname === '/api/custom-sound') return assetUrl('sound', q.get('name') ?? '');
      if (url.pathname === '/api/custom-music-file') return assetUrl('music', q.get('name') ?? '');
      if (['/api/skypano', '/api/skyground'].includes(url.pathname) && q.has('sky')) return assetUrl('sky', q.get('sky') ?? '');
      return path;
    },
    dispose() { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); },
  };
}

export function bundleProps(bundle: ProjectBundle): PropsPayload {
  const payload: PropsPayload = { level: '@import', models: [], materials: [], instances: [] };
  for (const asset of bundle.assets.filter(asset => asset.kind === 'prop')) {
    const bytes = bundle.blobs?.[asset.hash];
    if (!bytes) continue;
    const record = JSON.parse(new TextDecoder().decode(unpack(bytes))) as ImportedPropRecord;
    const base = payload.materials.length;
    payload.materials.push(...record.materials.map(material => ({ ...material, id: base + material.id })));
    payload.models.push({ ...record, subs: record.subs.map(sub => ({ ...sub, mat: base + sub.mat })) });
  }
  return payload;
}
