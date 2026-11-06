import { migrateMountain } from '../../core/doc/mountain';
import { decodeProps, type PropsPayload } from '../../core/reference/props';
import { recordFromReferenceProp } from '../../core/props/adopt';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { ProjectBundle, BundleAssetKind } from '../../core/project/transfer';
import type { PublicCourse } from '../../core/session/public-courses';

interface PublicBundleSource {
  origin: string;
  fetch: typeof globalThis.fetch;
}

const packed = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Copy only the published document and its original assets. All subsequent editor requests stay local. */
export async function publicBundle(
  course: PublicCourse,
  source: PublicBundleSource = { origin: location.origin, fetch },
): Promise<ProjectBundle> {
  const request = source.fetch;
  const response = await request(`/api/public/project?id=${encodeURIComponent(course.id)}`);
  if (!response.ok) throw new Error('This public mountain is no longer available.');
  const { document } = (await response.json()) as { document: EditDoc };
  const bundle: ProjectBundle = {
    kind: 'slopesmith-project',
    schema: 1,
    name: document.name,
    revision: 0,
    takenAt: new Date().toISOString(),
    document: migrateMountain(document),
    assets: [],
    blobs: {},
    missing: [],
  };
  const wanted = new Map<string, { kind: BundleAssetKind; name: string; url: string }>();
  const add = (kind: BundleAssetKind, name: string, path: string, params: Record<string, string>) => {
    const url = new URL(path, source.origin);
    for (const [key, value] of Object.entries({ ...params, project: course.id })) url.searchParams.set(key, value);
    wanted.set(`${kind}:${name}`, { kind, name, url: url.href });
  };
  function collect(value: unknown): void {
    if (typeof value === 'string' && /^Custom\//i.test(value)) {
      const name = value.slice(value.indexOf('/') + 1);
      add('texture', name, '/api/texture', { level: 'Custom', name });
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && ['collisionSoundFile', 'ambientSoundFile', 'soundFile'].includes(key))
          add('sound', child, '/api/custom-sound', { name: child });
        collect(child);
      }
  }
  async function attach(kind: BundleAssetKind, name: string, bytes: Uint8Array, model?: number) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    bundle.assets.push({ kind, name, hash, size: bytes.length, ...(model === undefined ? {} : { model }) });
    bundle.blobs![hash] = packed(bytes);
  }
  if (
    document.props?.some(prop => prop.level === '@import') ||
    document.propLines?.some(line => line.template.level === '@import')
  ) {
    const response = await request(`/api/custom-props?project=${encodeURIComponent(course.id)}`);
    if (!response.ok) throw new Error('The public mountain’s custom models could not be loaded.');
    const props = decodeProps((await response.json()) as PropsPayload);
    for (const model of props.models) {
      const record = { ...recordFromReferenceProp(props, model, model.name).record, id: model.id };
      collect(record);
      await attach('prop', record.name, new TextEncoder().encode(JSON.stringify(record)), record.id);
    }
  }
  collect(document);
  if (document.raceMusic) add('music', document.raceMusic, '/api/custom-music-file', { name: document.raceMusic });
  if (document.skybox?.source.kind === 'custom') {
    const name = document.skybox.source.name;
    add('sky', name, '/api/skypano', { sky: name });
  }
  for (const asset of wanted.values()) {
    const response = await request(asset.url);
    if (response.ok) await attach(asset.kind, asset.name, new Uint8Array(await response.arrayBuffer()));
    else bundle.missing!.push(`${asset.kind}:${asset.name}`);
  }
  return bundle;
}
