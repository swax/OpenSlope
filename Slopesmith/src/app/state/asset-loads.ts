export type AssetLoadState = 'loading' | 'ready' | 'missing';
const textures = new Map<string, AssetLoadState>();
const props = new Map<string, { state: AssetLoadState; models?: Set<number>; token?: object }>();
const listeners = new Set<() => void>();
let scope = '',
  queued = false;
function changed() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const listener of listeners) listener();
  });
}
export function watchAssetLoads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function setAssetLoadScope(id: string) {
  scope = id;
  changed();
}
const propKey = (level: string) => (level.startsWith('@') ? `${scope}:${level}` : level);
export const textureLoadState = (url: string): AssetLoadState => textures.get(url) ?? 'loading';
export function reportTextureLoad(url: string, state: AssetLoadState) {
  if (textures.get(url) === state) return;
  textures.set(url, state);
  changed();
}
export function propLoadState(level: string, model: number): AssetLoadState {
  const entry = props.get(propKey(level));
  return entry?.state === 'ready' ? (entry.models?.has(model) ? 'ready' : 'missing') : (entry?.state ?? 'loading');
}
export function reportPropModels(level: string, models: readonly number[]) {
  const key = propKey(level),
    previous = props.get(key);
  if (
    previous?.state === 'ready' &&
    previous.models?.size === models.length &&
    models.every(id => previous.models!.has(id))
  )
    return;
  props.set(key, { state: 'ready', models: new Set(models) });
  changed();
}
/** Capture the project and attempt; an older failed request cannot overwrite a newer retry. */
export function beginPropLoad(level: string) {
  const key = propKey(level),
    token = {};
  props.set(key, { state: 'loading', token });
  changed();
  return () => {
    if (props.get(key)?.token !== token) return;
    props.set(key, { state: 'missing' });
    changed();
  };
}
