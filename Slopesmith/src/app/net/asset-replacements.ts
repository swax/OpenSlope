import type { AssetReplacement } from '../../core/reference/asset-compatibility';
import { parseAssetVersion } from '../../core/reference/asset-version';
import type { PropsPayload } from '../../core/reference/props';
import { mapLimit } from '../../shared/map-data';

let replacements: readonly AssetReplacement[] = [];
export function setRuntimeAssetReplacements(next: readonly AssetReplacement[]) {
  replacements = next;
}

/** Replacement bytes are fetched/cached by their real identity. Adapt only the runtime view to saved slots. */
export async function fetchRuntimeAssetReplacement(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fetchActual: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  preparePayload: (payload: PropsPayload) => Promise<PropsPayload> = async payload => payload,
): Promise<Response | undefined> {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    globalThis.location?.origin ?? 'http://localhost',
  );
  if (
    url.origin !== (globalThis.location?.origin ?? 'http://localhost') ||
    (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET'
  )
    return;
  const original = url.searchParams.get('level') ?? '';
  const matches = replacements.filter(value => value.original === original);
  if (!matches.length) return;
  const expected = parseAssetVersion(original);
  const fetchTarget = (request: URL) =>
    fetchActual(input instanceof Request ? new Request(request, input) : request, init);
  function target(value: AssetReplacement) {
    const request = new URL(url);
    request.searchParams.set('level', value.replacement.id);
    request.searchParams.delete('mapSource');
    return request;
  }
  if (url.pathname === '/api/texture') {
    let name = url.searchParams.get('name') ?? '';
    const [nested, ...path] = name.split('/');
    if (!expected?.kind && matches.some(value => value.replacement.id === nested) && path.length) {
      const request = new URL(url);
      request.searchParams.set('level', nested);
      request.searchParams.set('name', path.join('/'));
      return fetchTarget(request);
    }
    const key = name.toLowerCase().replace(/_[oa](?=\.png$)/, '');
    const candidates = matches.filter(value =>
      value.replacement.kind === 'texture'
        ? (value.originalKey ?? expected?.key)?.toLowerCase() === name.toLowerCase()
        : Object.keys(value.replacement.files).some(
            file => file.slice('textures/'.length).replace(/_[oa](?=\.png$)/, '') === key,
          ),
    );
    const value = candidates[0];
    if (!value) return;
    const request = target(value),
      asset = value.replacement;
    if (asset.kind === 'texture') name = asset.key;
    else if (!asset.files[`textures/${name.toLowerCase()}`]) {
      const files = Object.keys(asset.files).filter(
        file => file.slice('textures/'.length).replace(/_[oa](?=\.png$)/, '') === key,
      );
      if (files.length !== 1) return;
      name = files[0].slice('textures/'.length);
    }
    request.searchParams.set('name', name);
    return fetchTarget(request);
  }
  if (url.pathname === '/api/physics-body') {
    const value = matches.find(
      value =>
        value.replacement.kind === 'body' && (value.originalKey ?? expected?.key) === url.searchParams.get('idx'),
    );
    if (!value) return;
    const request = target(value);
    request.searchParams.set('idx', value.replacement.key);
    return fetchTarget(request);
  }
  if (url.pathname !== '/api/props') return;
  const selected = matches.filter(value => value.replacement.kind === 'prop' || value.replacement.kind === 'body');
  if (!selected.length) return;
  const loaded = await mapLimit(selected, 4, async value => {
    const response = await fetchTarget(target(value));
    if (!response.ok) return { response };
    const payload = await preparePayload((await response.json()) as PropsPayload);
    const key = Number(value.originalKey ?? expected?.key);
    return { payload, key, value };
  });
  const failed = loaded.find(value => value.response);
  if (failed) return failed.response;
  const payloads = loaded.filter(
    (value): value is { payload: PropsPayload; key: number; value: AssetReplacement } => 'payload' in value,
  );
  const result: PropsPayload = {
    ...payloads[0].payload,
    level: original,
    models: [],
    materials: [],
    instances: [],
    physicsBodies: [],
    effects: [],
  };
  for (const { payload, key, value } of payloads) {
    const offset = result.materials.length;
    const effectOffset = result.effects!.length;
    result.effects!.push(...(payload.effects ?? []));
    const materials = new Map(payload.materials.map((material, index) => [material.id, offset + index]));
    result.materials.push(
      ...payload.materials.map(material => ({
        ...material,
        id: materials.get(material.id)!,
        ...(!expected?.kind
          ? {
              tex: material.tex ? `${value.replacement.id}/${material.tex}` : null,
              frames: material.frames?.map(name => `${value.replacement.id}/${name}`),
            }
          : {}),
      })),
    );
    result.models.push(
      ...payload.models.map(model => ({
        ...model,
        id: key,
        ...(model.fx ? { fx: { ...model.fx, t: model.fx.t + effectOffset } } : {}),
        subs: model.subs.map(sub => ({ ...sub, mat: materials.get(sub.mat) ?? sub.mat })),
      })),
    );
    result.physicsBodies!.push(...(payload.physicsBodies ?? []).map(body => ({ ...body, id: key })));
  }
  return Response.json(result);
}
