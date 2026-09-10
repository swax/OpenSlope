import type { V3 } from './doc/types';
import type { SharedViewOptions } from './session/screen-share';

export const VIEW_MODES = ['scene', 'edit', 'sculpt', 'paint', 'props', 'effects', 'test'] as const;
export type ViewMode = typeof VIEW_MODES[number];
export const VIEW_FLAGS = {
  cage: 'cage', grid: 'viewGrid', orientation: 'orientation', course: 'courseGuide', normals: 'normals',
  ai: 'aiPaths', props: 'props', tricks: 'tricks', effects: 'effects', sources: 'sources',
  lights: 'propLights', sun: 'sun', skybox: 'skybox',
} as const;
export const CLEAN_VIEW: SharedViewOptions = {
  shadeMode: 'textured', cage: false, viewGrid: false, orientation: false, courseGuide: false,
  normals: false, aiPaths: false, props: true, tricks: true, effects: true, sources: false,
  propLights: true, sun: true, skybox: true,
};
export interface ViewLink {
  pos?: V3;
  look?: V3;
  up?: V3;
  space: 'world' | 'mountain' | 'reference';
  projection: 'perspective' | 'orthographic';
  fov: number;
  height?: number;
  label?: string;
  az: number;
  el: number;
  reference: string;
  refOffset?: V3;
  revision?: number;
  size?: [number, number];
  mode: ViewMode;
  ui: boolean;
  options: SharedViewOptions;
}

/** A fragment is a declarative view, never document edits or commands to run. */
export function parseViewLink(hash: string): ViewLink | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (!['view', 'pos', 'look', 'label', 'preset'].some(key => p.has(key))) return null;
  const allowed = new Set(['view', 'pos', 'look', 'up', 'space', 'projection', 'fov', 'height', 'label',
    'az', 'el', 'reference', 'refOffset', 'revision', 'size', 'mode', 'ui', 'shade', 'preset', ...Object.keys(VIEW_FLAGS)]);
  for (const key of p.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown view parameter: ${key}.`);
    if (p.getAll(key).length !== 1) throw new Error(`Repeated view parameter: ${key}.`);
  }
  const choice = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
    const value = p.get(key) ?? fallback;
    if (!values.includes(value as T)) throw new Error(`${key} must be ${values.join(' or ')}.`);
    return value as T;
  };
  const number = (key: string, fallback: number, min: number, max: number) => {
    if (!p.has(key)) return fallback;
    const raw = p.get(key)!;
    const value = raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    return value;
  };
  const vector = (key: string, length = 3): number[] | undefined => {
    if (!p.has(key)) return undefined;
    const parts = p.get(key)!.split(',');
    const values = parts.map(v => v.trim() ? Number(v) : NaN);
    if (values.length !== length || values.some(v => !Number.isFinite(v) || Math.abs(v) > 10_000_000))
      throw new Error(`${key} needs ${length} finite comma-separated numbers (maximum magnitude 10000000).`);
    return values;
  };
  const flag = (key: string, fallback: boolean) => choice(key, ['0', '1'], fallback ? '1' : '0') === '1';
  choice('view', ['1'], '1');
  const preset = choice('preset', ['clean', 'topology', 'surface'], 'clean');
  const options: SharedViewOptions = { ...CLEAN_VIEW,
    ...(preset === 'topology' ? { cage: true, shadeMode: 'none', props: false, tricks: false, effects: false, skybox: false } : {}),
    ...(preset === 'surface' ? { shadeMode: 'surface' } : {}),
  };
  options.shadeMode = choice('shade', ['textured', 'surface', 'none'], options.shadeMode);
  for (const [key, field] of Object.entries(VIEW_FLAGS)) options[field] = flag(key, options[field]);
  const pos = vector('pos') as V3 | undefined, look = vector('look') as V3 | undefined;
  if (!!pos !== !!look) throw new Error('Supply pos and look together.');
  if (pos && look && Math.hypot(...pos.map((v, i) => v - look[i])) < 0.01)
    throw new Error('pos and look must be at least 0.01 m apart.');
  const up = vector('up') as V3 | undefined;
  if (up && Math.hypot(...up) < 0.000001) throw new Error('up must be a nonzero vector.');
  const label = p.get('label') ?? undefined;
  if (label !== undefined && (!label.trim() || label.length > 256)) throw new Error('label must name a label id or name.');
  if (label && pos) throw new Error('Use label framing or pos/look, not both.');
  const size = vector('size', 2) as [number, number] | undefined;
  if (size && (size.some(v => !Number.isInteger(v) || v < 64 || v > 4096) || size[0] * size[1] > 8_388_608))
    throw new Error('size needs integer dimensions from 64 to 4096 pixels, at most 8388608 pixels total.');
  const revision = p.has('revision') ? number('revision', 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
  if (revision !== undefined && !Number.isInteger(revision)) throw new Error('revision must be an integer.');
  const reference = p.get('reference') ?? 'none';
  if (!/^[a-z0-9_-]{1,64}$/i.test(reference)) throw new Error('reference must be a level name or none.');
  const space = choice('space', ['world', 'mountain', 'reference'], 'world');
  const refOffset = vector('refOffset') as V3 | undefined;
  if ((space === 'reference' || refOffset) && reference === 'none') throw new Error('Reference coordinates need a reference level.');
  return {
    pos, look, up, label, size, revision, reference, refOffset, space, options,
    projection: choice('projection', ['perspective', 'orthographic'], 'perspective'),
    fov: number('fov', 55, 1, 175), height: p.has('height') ? number('height', 100, 0.01, 10_000_000) : undefined,
    az: number('az', 45, -360, 360), el: number('el', 35, -89.9, 89.9),
    mode: choice('mode', VIEW_MODES, 'scene'), ui: flag('ui', true),
  };
}

/** Explicit options make the link independent of the next browser's remembered settings. */
export function encodeViewLink(view: ViewLink): string {
  const p = new URLSearchParams({ view: '1', space: view.space, projection: view.projection,
    fov: String(view.fov), mode: view.mode, ui: view.ui ? '1' : '0', reference: view.reference, shade: view.options.shadeMode });
  for (const key of ['pos', 'look', 'up', 'refOffset', 'size'] as const)
    if (view[key]) p.set(key, view[key]!.map(v => Number(v.toFixed(6))).join(','));
  if (view.height !== undefined) p.set('height', String(view.height));
  if (view.label) { p.set('label', view.label); p.set('az', String(view.az)); p.set('el', String(view.el)); }
  if (view.revision !== undefined) p.set('revision', String(view.revision));
  for (const [key, field] of Object.entries(VIEW_FLAGS)) p.set(key, view.options[field] ? '1' : '0');
  return `#${p.toString()}`;
}
