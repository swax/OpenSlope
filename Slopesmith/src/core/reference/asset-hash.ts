import type { PropsPayload } from './props';

export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function canonicalAssetJson(value: unknown): string {
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sorted(v)]),
      );
    return value;
  }
  return JSON.stringify(sorted(value));
}

/** The reusable model's closure excludes other models and source placement transforms. */
export function propAssetDefinition(payload: PropsPayload, key: string): unknown {
  const model = payload.models.find(model => String(model.id) === key);
  if (!model) throw new Error(`Prop ${key} is unavailable.`);
  const materials = payload.materials.filter(material => model.subs.some(sub => sub.mat === material.id));
  const effect = model.fx && payload.effects?.[model.fx.t];
  const ownLevels = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ownLevels);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          key === 'level' && child === payload.level ? '@self' : ownLevels(child),
        ]),
      );
    return value;
  };
  return ownLevels({
    model: { ...model, fx: undefined },
    materials,
    effect: effect ? { ...effect, key: undefined } : undefined,
  });
}

export async function assetDefinitionHash(definition: unknown, files: Record<string, string>): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalAssetJson(['openslope-asset/v1', definition, files])));
}

/** Source-local model/material numbers do not distinguish the same reusable imported definition. */
export async function propCompatibilityHash(
  definition: unknown,
  files: Record<string, string>,
): Promise<string | undefined> {
  const value = definition as { model: PropsPayload['models'][number]; materials: PropsPayload['materials'] };
  const ids = [...new Set(value.model.subs.map(sub => sub.mat))];
  // Optional compatibility metadata must not hide an otherwise addressable legacy prop.
  if (ids.some(id => !value.materials.some(material => material.id === id))) return;
  return assetDefinitionHash(
    {
      ...value,
      model: { ...value.model, id: 0, subs: value.model.subs.map(sub => ({ ...sub, mat: ids.indexOf(sub.mat) })) },
      materials: ids.map((id, index) => {
        const material = value.materials.find(material => material.id === id)!;
        return { ...material, id: index };
      }),
    },
    files,
  );
}
